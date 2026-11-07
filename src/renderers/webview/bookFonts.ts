/**
 * A book's own typefaces: which to load, and how to point its CSS at them.
 *
 * The viewer can fetch nothing (`default-src 'none'`), and its CSP allows fonts
 * only as `data:` URIs — so a book's `@font-face { src: url(fonts/x.ttf) }`
 * named a file the page could never load, and every book fell back to the
 * reader's default face. The fonts are now read from the archive and inlined.
 *
 * Imports nothing, so it is tested directly (`bookStyle.test.ts`).
 */

/** Largest single face inlined. Real text faces are 30–500 KB. */
export const MAX_FONT_BYTES = 1_500_000

/**
 * All faces in one book, together.
 *
 * Inlined fonts are part of the first paint (the stylesheet that names them
 * is) and live in the cached document as base64, so this is a first-paint and
 * memory budget. Four faces — regular, italic, bold, bold italic — of a typical
 * text font fit several times over; a CJK font that does not fit is skipped and
 * the reader's own face is used.
 */
export const MAX_TOTAL_FONT_BYTES = 4_000_000

/** Where an EPUB lists encrypted and obfuscated resources. */
export const ENCRYPTION_PATH = 'META-INF/encryption.xml'

const FONT_EXT = /\.(otf|ttf|woff2?)$/i
const FONT_TYPE = /font|opentype|truetype|woff/i

/** Resolves an href against the archive path of the file that contains it. */
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

/**
 * Archive paths listed in `encryption.xml` — fonts obfuscated per the IDPF or
 * Adobe schemes. Their bytes are scrambled; inlined, the browser would reject
 * them anyway, so they are not read at all and the reader's face is used.
 */
export function encryptedPaths(xml: string | null): Set<string> {
  const out = new Set<string>()
  if (!xml) return out
  for (const m of xml.matchAll(/CipherReference[^>]*?\bURI\s*=\s*["']([^"']+)["']/gi)) {
    try {
      out.add(decodeURI(m[1]))
    } catch {
      out.add(m[1])
    }
  }
  return out
}

/**
 * The font files to read, within both budgets, in manifest order.
 *
 * Decided from the central directory's sizes, before anything is
 * decompressed — the same discipline as the book's images.
 */
export function chooseFonts(
  items: { href: string; type: string }[],
  opfPath: string,
  sizeOf: ReadonlyMap<string, number>,
  skip: ReadonlySet<string>,
): string[] {
  const chosen: string[] = []
  let total = 0
  for (const item of items) {
    if (!FONT_TYPE.test(item.type) && !FONT_EXT.test(item.href)) continue
    const path = resolvePath(opfPath, item.href)
    if (skip.has(path) || chosen.includes(path)) continue
    const size = sizeOf.get(path)
    if (size === undefined || size > MAX_FONT_BYTES) continue
    if (total + size > MAX_TOTAL_FONT_BYTES) continue
    total += size
    chosen.push(path)
  }
  return chosen
}

/** The MIME type for a font file, by extension. */
export function fontMime(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'otf') return 'font/otf'
  if (ext === 'woff') return 'font/woff'
  if (ext === 'woff2') return 'font/woff2'
  return 'font/ttf'
}

/**
 * Points a stylesheet's `url()`s at inlined fonts.
 *
 * Each URL is resolved against the stylesheet's own path, as the book wrote it.
 * A URL that is not an inlined font is left alone — `normalizeBookCss` then
 * replaces it, because only `data:` URIs survive that pass.
 */
export function inlineFontUrls(css: string, cssPath: string, fonts: ReadonlyMap<string, string>): string {
  if (!fonts.size) return css
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, _q: string, href: string) => {
    if (/^data:/i.test(href.trim())) return whole
    let path = resolvePath(cssPath, href.trim())
    try {
      path = decodeURI(path)
    } catch {
      // Not percent-encoded; use as written.
    }
    const uri = fonts.get(path)
    return uri ? `url("${uri}")` : whole
  })
}
