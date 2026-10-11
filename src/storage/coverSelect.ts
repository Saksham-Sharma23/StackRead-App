import { strFromU8 } from 'fflate'

import type { ZipEntryInfo } from '../renderers/webview/zipWorklet'

/**
 * Finds a container's cover and reads **only that entry** (plus the few small
 * documents needed to locate it).
 *
 * ## Why this is separate from `covers.ts`
 *
 * It used to be one function over a fully unzipped archive: every EPUB or comic
 * card without a cover decompressed its whole book — every chapter and every
 * illustration — to pick out one image, two cards at a time, on the user's
 * worklet lane ([AUDIT4 A6](../../AUDIT4.md)). Now the archive is opened as a
 * handle and entries are requested by name, with sizes checked against the
 * central directory before anything is decompressed.
 *
 * Kept free of `expo-file-system` and worklets so the tests can run it against
 * real archives; `covers.ts` supplies the handle.
 *
 * ## No `TextDecoder`
 *
 * Hermes does not reliably provide one (`WebViewRenderer` documents the same
 * gap for `TextEncoder`). fflate's `strFromU8` is already the decoder `epub.ts`
 * uses, so both paths read text the same way.
 */

/** Reads the named entries. Names not in the archive are absent from the result. */
export type ReadEntries = (names: string[]) => Promise<Record<string, Uint8Array>>

export interface CoverBytes {
  bytes: Uint8Array
  /** Extension of the source image, so the caller can name a temp file. */
  ext: string
}

/**
 * Refuse a cover larger than this rather than decoding it.
 *
 * A cover is about to be downscaled to 320px wide, so a 12MB source is pure
 * waste — and decoding it costs the full bitmap in memory first. Comfortably
 * above any real cover; a book whose cover exceeds it simply shows a badge.
 * Checked against the central directory, so an oversized cover is never even
 * decompressed.
 */
export const MAX_COVER_BYTES = 8_000_000

/**
 * The most text read to locate a cover: `container.xml`, the OPF, or a first
 * chapter. These are kilobytes in any real book; a manifest of megabytes is not
 * worth decompressing for a thumbnail.
 */
const MAX_LOCATOR_BYTES = 4_000_000

/**
 * Images a cover may be.
 *
 * SVG is excluded on purpose, and for the same reason `prepare.ts` excludes it
 * from archive previews: an SVG is a document that can carry script, not a
 * bitmap. `expo-image-manipulator` would not decode it here anyway, but the
 * exclusion is written rather than assumed so it survives a library change.
 */
const COVER_IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i

/** Natural sort, so page2 precedes page10. Mirrors the comic path. */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/** ZIP paths are absolute-ish; resolve an href relative to its manifest. */
export function resolvePath(base: string, href: string): string {
  const clean = href.split('#')[0]
  if (!base) return clean
  const parts = base.split('/')
  parts.pop()
  for (const seg of clean.split('/')) {
    if (seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

/** The extension of a zip entry, lowercased and without the dot. */
export function extensionOfPath(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? '' : path.slice(dot + 1).toLowerCase()
}

/** Uncompressed sizes by name, from the listing. */
function sizesOf(entries: readonly ZipEntryInfo[]): Map<string, number> {
  const sizes = new Map<string, number>()
  for (const e of entries) sizes.set(e.name, e.originalSize)
  return sizes
}

/** Reads one text entry, or null when it is absent or too large to bother with. */
async function readText(
  read: ReadEntries,
  sizes: Map<string, number>,
  path: string,
): Promise<string | null> {
  const size = sizes.get(path)
  if (size === undefined || size > MAX_LOCATOR_BYTES) return null
  const bytes = (await read([path]))[path]
  return bytes ? strFromU8(bytes) : null
}

/** Reads one image entry if it is a usable cover by name and declared size. */
async function readCoverImage(
  read: ReadEntries,
  sizes: Map<string, number>,
  path: string,
): Promise<CoverBytes | null> {
  if (!COVER_IMAGE_RE.test(path)) return null
  const size = sizes.get(path)
  if (size === undefined || size > MAX_COVER_BYTES) return null
  const bytes = (await read([path]))[path]
  return bytes ? { bytes, ext: extensionOfPath(path) } : null
}

/**
 * The cover of an EPUB, by the three routes a book can declare one.
 *
 * In descending order of trustworthiness:
 *
 *  1. EPUB 3 — a manifest item with `properties="cover-image"`. Unambiguous.
 *  2. EPUB 2 — `<meta name="cover" content="<id>">` pointing at a manifest id.
 *     Still near-universal in the wild, so it is not a legacy path.
 *  3. Neither — fall back to the first image in the spine's first chapter,
 *     which is what a cover page actually is in a book that declares nothing.
 *
 * Reads `container.xml`, the OPF, then the cover — plus the first chapter only
 * on route 3. The parsing mirrors `epub.ts` rather than sharing with it, because
 * that function assembles a whole book and this one must not. The duplication is
 * limited to a few regexes and `resolvePath`; see the note in `bytes.ts` about
 * what happens when *behavioural* logic is duplicated instead.
 */
export async function findEpubCover(
  entries: readonly ZipEntryInfo[],
  read: ReadEntries,
): Promise<CoverBytes | null> {
  const sizes = sizesOf(entries)

  const container = await readText(read, sizes, 'META-INF/container.xml')
  if (!container) return null

  const opfPath = container.match(/full-path\s*=\s*["']([^"']+)["']/)?.[1]
  if (!opfPath) return null

  const opf = await readText(read, sizes, opfPath)
  if (!opf) return null

  // id -> href, for the whole manifest.
  const hrefById = new Map<string, string>()
  let byProperty: string | null = null

  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const tag = m[0]
    const id = tag.match(/\bid\s*=\s*["']([^"']+)["']/)?.[1]
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/)?.[1]
    if (!id || !href) continue
    hrefById.set(id, href)

    const props = tag.match(/\bproperties\s*=\s*["']([^"']+)["']/)?.[1] ?? ''
    // Word-boundary match: `properties="cover-image"` must hit, but a
    // hypothetical `not-cover-image` must not.
    if (/\bcover-image\b/.test(props)) byProperty = href
  }

  const candidates: string[] = []
  if (byProperty) candidates.push(byProperty)

  // EPUB 2's <meta name="cover" content="cover-id">.
  const metaId = opf.match(
    /<meta\b[^>]*\bname\s*=\s*["']cover["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i,
  )?.[1]
  // Attribute order is not guaranteed, so try content-first as well.
  const metaIdAlt = opf.match(
    /<meta\b[^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*\bname\s*=\s*["']cover["']/i,
  )?.[1]
  for (const id of [metaId, metaIdAlt]) {
    const href = id ? hrefById.get(id) : undefined
    if (href) candidates.push(href)
  }

  for (const href of candidates) {
    const cover = await readCoverImage(read, sizes, resolvePath(opfPath, href))
    if (cover) return cover
  }

  // Nothing declared. The first image inside the first spine item is, in
  // practice, the cover page's image.
  const firstIdref = opf.match(/<itemref\b[^>]*\bidref\s*=\s*["']([^"']+)["']/)?.[1]
  const firstHref = firstIdref ? hrefById.get(firstIdref) : undefined
  if (!firstHref) return null

  const chapterPath = resolvePath(opfPath, firstHref)
  const html = await readText(read, sizes, chapterPath)
  if (!html) return null

  // Covers a plain <img src> and SVG's <image xlink:href>, which is how a
  // great many EPUB cover pages are actually built.
  const src =
    html.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] ??
    html.match(/<image\b[^>]*\b(?:xlink:)?href\s*=\s*["']([^"']+)["']/i)?.[1]
  if (!src || /^(https?:|data:)/i.test(src)) return null

  return readCoverImage(read, sizes, resolvePath(chapterPath, src))
}

/**
 * The cover of a comic: its first page.
 *
 * Chosen from the listing alone — names sorted with the same `naturalCompare`
 * the renderer uses, sizes from the central directory — so exactly one image is
 * decompressed. The thumbnail is guaranteed to be the page the reader will see
 * first: `page2` before `page10`, not lexicographically.
 */
export async function findComicCover(
  entries: readonly ZipEntryInfo[],
  read: ReadEntries,
): Promise<CoverBytes | null> {
  const sizes = sizesOf(entries)
  const pages = entries
    .map((e) => e.name)
    .filter((p) => COVER_IMAGE_RE.test(p) && !p.startsWith('__MACOSX'))
    .sort(naturalCompare)

  for (const path of pages) {
    // An oversized first page should not mean "no cover" — try the next.
    if ((sizes.get(path) ?? Infinity) > MAX_COVER_BYTES) continue
    return readCoverImage(read, sizes, path)
  }
  return null
}
