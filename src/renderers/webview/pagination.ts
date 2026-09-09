/*
 * Imported with its extension, unlike every other import in `src/`.
 *
 * This module is loaded *directly* by `node --test` under
 * `--experimental-strip-types`, where Node's own ESM resolver applies and does
 * not guess extensions. Metro resolves either form, so the extension is
 * harmless on device and load-bearing off it — without it the pagination tests
 * fail to import at all.
 */
import { parseXml, asArray, attr, child, textOfNode } from './xml.ts'

/**
 * How many pages a document has, derived from its **content** — never from how
 * it happens to be laid out on screen.
 *
 * The previous implementation divided rendered height by an A4-proportioned
 * box, which made the total a function of screen width, font size and
 * orientation. A 145-page book reported 295, and the number changed when the
 * phone was rotated.
 *
 * The convention here follows the W3C EPUB 3.3 Locators note: in the absence of
 * a publisher-supplied page list, generate "one page number for every 1,000
 * unicode code points of uncompressed visible-to-the-reader text". Adobe
 * Digital Editions uses 1024 characters for the same purpose. A book that
 * declares real print pages always wins over the estimate.
 */

/** W3C recommendation for reflowable prose. */
export const CHARS_PER_PAGE = 1000

/**
 * DOCX pages are physically larger than a paperback page. ~300 words at
 * standard formatting, around six characters per word including spaces.
 */
export const CHARS_PER_PAGE_DOCX = 1800

/** Strips markup and collapses whitespace, leaving what a reader actually sees. */
export function visibleTextLength(html: string): number {
  const text = html
    // Script and style content is never visible.
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    // Entities count as roughly one character each.
    .replace(/&[a-z]+;|&#\d+;/gi, 'x')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length
}

/** Page count for reflowable content, given its visible character count. */
export function pagesFromChars(chars: number, perPage = CHARS_PER_PAGE): number {
  return Math.max(1, Math.ceil(chars / perPage))
}

/**
 * A page boundary the publisher declared, mapped into the assembled document.
 *
 * `href` is the original EPUB target (`chapter3.xhtml#page_42`); `label` is what
 * the print edition calls that page, which is usually a number but can be roman
 * numerals in front matter.
 */
export interface PageMark {
  label: string
  href: string
}

/**
 * Extracts a page list from an EPUB 3 navigation document.
 *
 * Shape: `<nav epub:type="page-list"><ol><li><a href="...">42</a>…`
 */
export function parseNavPageList(navHtml: string): PageMark[] {
  const section = navHtml.match(
    /<nav\b[^>]*epub:type\s*=\s*["'][^"']*page-list[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i,
  )?.[1]
  if (!section) return []
  return collectAnchors(section)
}
/**
 * Extracts a page list from an EPUB 2 NCX.
 *
 * Shape: `<pageList><pageTarget value="42"><navLabel><text>42</text></navLabel>
 *         <content src="chapter3.xhtml#page_42"/>`
 *
 * Parsed as XML rather than tokenised. The previous version matched
 * `<pageTarget>` blocks and then re-matched inside each one, which broke on a
 * namespaced `<ncx:pageTarget>` and on a label carrying its own attributes —
 * and broke by returning an empty list, so the book silently fell back to
 * estimated page numbers instead of using the publisher's real ones.
 */
export function parseNcxPageList(ncxXml: string): PageMark[] {
  const doc = parseXml(ncxXml)
  const targets = asArray(child(ncxSection(doc, 'pageList'), 'pageTarget'))

  const marks: PageMark[] = []
  for (const target of targets) {
    const href = attr(child(target, 'content'), 'src')
    if (!href) continue

    // The label is the displayed page number and can be roman numerals, so it
    // is text and never a number. `value` is the documented fallback.
    const label =
      textOfNode(child(child(target, 'navLabel'), 'text')).trim() ||
      attr(target, 'value') ||
      String(marks.length + 1)

    marks.push({ label: decodeEntities(label), href })
  }
  return marks
}

/** Table-of-contents entry, flattened with its nesting depth. */
export interface TocEntry {
  title: string
  href: string
  depth: number
}

/** EPUB 3 `<nav epub:type="toc">`. */
export function parseNavToc(navHtml: string): TocEntry[] {
  const section = navHtml.match(
    /<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i,
  )?.[1]
  if (!section) return []

  const entries: TocEntry[] = []
  // Depth is inferred from how many <ol> are open at each anchor.
  let depth = 0
  const token = /<ol\b[^>]*>|<\/ol>|<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi

  for (const m of section.matchAll(token)) {
    if (m[0].toLowerCase().startsWith('<ol')) depth += 1
    else if (m[0].toLowerCase().startsWith('</ol')) depth = Math.max(0, depth - 1)
    else if (m[1]) {
      const title = decodeEntities(m[2].replace(/<[^>]+>/g, '').trim())
      if (title) entries.push({ title, href: m[1], depth: Math.max(0, depth - 1) })
    }
  }
  return entries
}

/**
 * EPUB 2 NCX `<navMap>`.
 *
 * Recursive rather than a flat token scan: `<navPoint>` nests, and the depth
 * is structural. The previous version tracked depth by counting opening and
 * closing tags as they streamed past, which is correct only while every tag is
 * matched and unnamespaced — a self-closing or namespaced navPoint desynchronised
 * the counter and every entry after it got the wrong indent.
 */
export function parseNcxToc(ncxXml: string): TocEntry[] {
  const doc = parseXml(ncxXml)
  const navMap = ncxSection(doc, 'navMap')
  if (!navMap) return []

  const entries: TocEntry[] = []

  const walk = (node: unknown, depth: number): void => {
    for (const point of asArray(child(node, 'navPoint'))) {
      const href = attr(child(point, 'content'), 'src')
      const title = decodeEntities(
        textOfNode(child(child(point, 'navLabel'), 'text')).trim(),
      )
      if (href && title) entries.push({ title, href, depth })
      // Children are nested navPoints; depth is how deep the recursion is,
      // which cannot drift the way a running counter can.
      walk(point, depth + 1)
    }
  }

  walk(navMap, 0)
  return entries
}

/**
 * Finds a top-level NCX section, with or without the `<ncx>` root element.
 *
 * A real NCX file is rooted at `<ncx>`, and that is the path this takes first.
 * But the section is also perfectly meaningful on its own — it is how these
 * parsers are exercised in tests, and how a malformed book can present after a
 * partial read — so a bare `<pageList>` or `<navMap>` is accepted too rather
 * than silently yielding nothing.
 *
 * Being lenient here costs one lookup and removes a whole class of "the book
 * has no chapters" that is really "the document was shaped slightly
 * differently than expected".
 */
function ncxSection(doc: unknown, name: string): unknown {
  return child(child(doc, 'ncx'), name) ?? child(doc, name)
}

/** The handful of entities that actually show up in titles and page labels. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

/** Anchors inside a nav list, in document order. */
function collectAnchors(section: string): PageMark[] {
  const marks: PageMark[] = []
  for (const m of section.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = decodeEntities(m[2].replace(/<[^>]+>/g, '').trim())
    if (m[1]) marks.push({ label: label || String(marks.length + 1), href: m[1] })
  }
  return marks
}

/**
 * Uncompressed XHTML bytes per visible character.
 *
 * Phase 1 has the *sizes* of every chapter from the ZIP central directory but
 * not their text, so a book that declares no page list gets a provisional count
 * from bytes and an exact one when phase 2 finishes.
 *
 * **Measured, not guessed** — across the generated test library and three
 * synthetic markup densities:
 *
 *   plain prose, few tags .................. 1.014
 *   typical: headings, emphasis, links ..... 1.083
 *   the generated test EPUB ................ 1.232
 *   heavy: spans, classes, epub:type ....... 1.474
 *
 * 1.2 sits in the middle of that range, so the provisional count is within
 * roughly 20% either way for real markup and usually far closer. That is a
 * different kind of error from the one this whole design exists to remove: it
 * is derived from the book's own bytes, so rotating the phone cannot change it,
 * and it is replaced by the exact figure within seconds.
 */
const BYTES_PER_VISIBLE_CHAR = 1.2

/**
 * A page count from the archive's central directory, with nothing decompressed.
 *
 * The provisional half of the two-tier rule while phase 2 is still running. It
 * is derived from the book's own uncompressed byte sizes, so it remains a
 * function of *content* rather than of layout — rotating the phone still cannot
 * change it, which is the property [DETAIL.md §5.2](../../DETAIL.md) is actually
 * protecting.
 *
 * Lives here rather than in `epub.ts` because it is pure and `epub.ts` imports
 * `expo-file-system`, which cannot load under Node — the same reasoning that
 * put `libraryDiff.ts` in its own module. The calibration below is the part
 * worth pinning, and it is only testable from here.
 */
export function provisionalPageCount(
  spinePaths: string[],
  sizeOf: Map<string, number>,
): number {
  let bytes = 0
  for (const path of spinePaths) bytes += sizeOf.get(path) ?? 0
  if (!bytes) return 1
  return pagesFromChars(Math.round(bytes / BYTES_PER_VISIBLE_CHAR), CHARS_PER_PAGE)
}
