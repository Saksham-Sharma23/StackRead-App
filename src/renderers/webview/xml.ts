import { XMLParser } from 'fast-xml-parser'

/**
 * One configured XML parser for every EPUB document this app reads.
 *
 * ## Why a parser at all
 *
 * The OPF, NCX and navigation documents were parsed with about a dozen
 * hand-written regexes — `/<item\b[^>]*>/g`, then a second regex per attribute.
 * They work on well-formed, conventionally-written books, and they fail
 * **silently** on the awkward ones:
 *
 *  - a namespaced element (`<opf:item>`) does not match `<item\b`, so the whole
 *    manifest comes back empty;
 *  - a CDATA title (`<dc:title><![CDATA[...]]></dc:title>`) does not match a
 *    text capture, so the book has no title;
 *  - an attribute in an unexpected order, or one containing a `>` inside its
 *    value, truncates the tag match.
 *
 * In every case the book still opens — with no table of contents and no page
 * list, which the reader experiences as "this EPUB just doesn't have chapters"
 * rather than as a bug. That is the worst kind of failure: invisible, plausible,
 * and unreported.
 *
 * ## The two options that matter here
 *
 * `removeNSPrefix` is what fixes the namespace class of bug outright: `opf:item`
 * and `item` become the same key, so a book that declares its namespace
 * explicitly parses identically to one that does not.
 *
 * `attributeNamePrefix: '@_'` keeps attributes from colliding with child
 * elements of the same name — an `<item href="...">` with a child `<href>`
 * would otherwise overwrite one with the other.
 *
 * ## Why the helpers below exist
 *
 * fast-xml-parser returns a single object where there is one child and an array
 * where there are several, which is convenient to read and a trap to program
 * against: a manifest with exactly one item is shaped differently from one with
 * two. `asArray` normalises that at every use site, so no caller has to
 * remember.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // `opf:item` and `item` become one key. This alone fixes the largest class of
  // silent failure the regexes had.
  removeNSPrefix: true,
  // Titles and labels are text, not numbers: a book called "1984" must not
  // become the number 1984, and a page label "007" must keep its zeros.
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  // CDATA is merged into the element's text rather than exposed separately, so
  // `<dc:title><![CDATA[x]]></dc:title>` reads the same as a plain title.
  cdataPropName: false,
})

/** Parses a document, returning null rather than throwing on malformed input. */
export function parseXml(source: string): Record<string, unknown> | null {
  try {
    return parser.parse(source) as Record<string, unknown>
  } catch {
    /*
     * A malformed manifest must not take the book down.
     *
     * The callers all degrade: no manifest means "not a valid EPUB", no nav
     * means the NCX fallback, no NCX means no chapter list. Returning null lets
     * each of those paths run rather than propagating an exception through a
     * parse that is otherwise recoverable.
     */
    return null
  }
}

/**
 * Normalises "one child or many" into an array.
 *
 * fast-xml-parser gives an object for a single occurrence and an array for
 * several. Every caller wants a list, and forgetting this is a bug that appears
 * only on books with exactly one chapter, one nav point, or one page target —
 * which is exactly the kind of edge case that ships.
 */
export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/** Reads an attribute, or undefined. Attributes carry the `@_` prefix. */
export function attr(node: unknown, name: string): string | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const value = (node as Record<string, unknown>)[`@_${name}`]
  return value === undefined || value === null ? undefined : String(value)
}

/**
 * The text content of a node, however the parser represented it.
 *
 * A node with no attributes parses to a bare string; one with attributes parses
 * to an object whose text sits under `#text`. Both are ordinary in these
 * documents — `<text>Chapter 1</text>` versus `<text xml:lang="en">Chapter
 * 1</text>` — so both have to be handled or a book fails on the variant nobody
 * tested against.
 */
export function textOfNode(node: unknown): string {
  if (node === undefined || node === null) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number' || typeof node === 'boolean') return String(node)
  if (typeof node === 'object') {
    const text = (node as Record<string, unknown>)['#text']
    if (text !== undefined && text !== null) return String(text)
  }
  return ''
}

/** Child node by name, or undefined. */
export function child(node: unknown, name: string): unknown {
  if (typeof node !== 'object' || node === null) return undefined
  return (node as Record<string, unknown>)[name]
}
