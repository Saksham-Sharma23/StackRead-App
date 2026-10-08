import { File } from 'expo-file-system'

import { LIBRARY_DIR } from './paths'
import { MAX_PREPARE_BYTES } from './formats'
import { unzipOffThread } from '../renderers/webview/offload'

/**
 * Extracts a *cover image* from a container format, as raw bytes.
 *
 * Deliberately separate from `renderers/webview/prepare.ts`. That module builds
 * a whole document for display — it unzips everything, sanitises every chapter
 * and base64-encodes every image. A thumbnail needs exactly one image and none
 * of that work, and routing covers through the render pipeline would mean
 * parsing an entire book to draw a 320px card.
 *
 * Everything here returns bytes rather than a URI, so the caller decides where
 * the file lands. `storage/thumbs.ts` writes it beside the file it belongs to,
 * the same as an image thumbnail.
 *
 * Formats that carry no cover return null and the card falls back to its format
 * badge, which is a perfectly good card.
 */

/**
 * Refuse a cover larger than this rather than decoding it.
 *
 * A cover is about to be downscaled to 320px wide, so a 12MB source is pure
 * waste — and decoding it costs the full bitmap in memory first. Comfortably
 * above any real cover; a book whose cover exceeds it simply shows a badge.
 */
const MAX_COVER_BYTES = 8_000_000

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
function resolvePath(base: string, href: string): string {
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

export interface CoverBytes {
  bytes: Uint8Array
  /** Extension of the source image, so the caller can name a temp file. */
  ext: string
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
 * The parsing mirrors `epub.ts` rather than sharing with it, because that
 * function assembles a whole book and this one must not. The duplication is
 * limited to two regexes and `resolvePath`; see the note in `bytes.ts` about
 * what happens when *behavioural* logic is duplicated instead.
 */
function epubCover(zip: Record<string, Uint8Array>): CoverBytes | null {
  const container = zip['META-INF/container.xml']
  if (!container) return null

  const containerText = new TextDecoder().decode(container)
  const opfPath = containerText.match(/full-path\s*=\s*["']([^"']+)["']/)?.[1]
  if (!opfPath || !zip[opfPath]) return null

  const opf = new TextDecoder().decode(zip[opfPath])

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
    const path = resolvePath(opfPath, href)
    const entry = zip[path]
    if (entry && COVER_IMAGE_RE.test(path) && entry.length <= MAX_COVER_BYTES) {
      return { bytes: entry, ext: extensionOfPath(path) }
    }
  }

  // Nothing declared. The first image inside the first spine item is, in
  // practice, the cover page's image.
  const firstIdref = opf.match(/<itemref\b[^>]*\bidref\s*=\s*["']([^"']+)["']/)?.[1]
  const firstHref = firstIdref ? hrefById.get(firstIdref) : undefined
  if (firstHref) {
    const chapterPath = resolvePath(opfPath, firstHref)
    const chapter = zip[chapterPath]
    if (chapter) {
      const html = new TextDecoder().decode(chapter)
      // Covers a plain <img src> and SVG's <image xlink:href>, which is how a
      // great many EPUB cover pages are actually built.
      const src =
        html.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] ??
        html.match(/<image\b[^>]*\b(?:xlink:)?href\s*=\s*["']([^"']+)["']/i)?.[1]
      if (src && !/^(https?:|data:)/i.test(src)) {
        const path = resolvePath(chapterPath, src)
        const entry = zip[path]
        if (entry && COVER_IMAGE_RE.test(path) && entry.length <= MAX_COVER_BYTES) {
          return { bytes: entry, ext: extensionOfPath(path) }
        }
      }
    }
  }

  return null
}

/**
 * The cover of a comic: its first page.
 *
 * Sorted with the same `naturalCompare` the renderer uses, so the thumbnail is
 * guaranteed to be the page the reader will actually see first — `page2` before
 * `page10`, not lexicographically.
 */
function comicCover(zip: Record<string, Uint8Array>): CoverBytes | null {
  const pages = Object.keys(zip)
    .filter((p) => COVER_IMAGE_RE.test(p) && !p.startsWith('__MACOSX'))
    .sort(naturalCompare)

  for (const path of pages) {
    const entry = zip[path]
    if (entry && entry.length <= MAX_COVER_BYTES) {
      return { bytes: entry, ext: extensionOfPath(path) }
    }
    // An oversized first page should not mean "no cover" — try the next.
  }
  return null
}

/**
 * Extracts cover bytes for a stored file, or null when it carries none.
 *
 * Only handles zip-based containers. PDF covers are rendered natively by the
 * PDF renderer rather than extracted, because a PDF page is drawn, not stored.
 */
export async function extractCover(
  storedName: string,
  format: 'epub' | 'comic',
): Promise<CoverBytes | null> {
  const file = new File(LIBRARY_DIR, storedName)
  if (!file.exists) return null

  /*
   * The same ceiling opening the file uses ([AUDIT4 A1](../../AUDIT4.md)).
   *
   * This path runs for every uncovered card on the board, with nothing the user
   * asked for at stake — a book too large to open is too large to read whole
   * into JS for a thumbnail. Returning null records the attempt as failed, so
   * it is not retried on every launch.
   */
  const limit = MAX_PREPARE_BYTES[format]
  if (limit !== undefined && (file.size ?? 0) > limit) return null

  let zip: Record<string, Uint8Array>
  try {
    // Off the JS thread: covers are generated while the board is being
    // scrolled, so this must not compete with it.
    zip = await unzipOffThread(await file.bytes())
  } catch {
    // A corrupt or non-zip file is not an error here — the card shows a badge.
    return null
  }

  return format === 'epub' ? epubCover(zip) : comicCover(zip)
}
