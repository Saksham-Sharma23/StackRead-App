/**
 * The one shape every search engine in this app returns.
 *
 * ## Why this exists before either implementation
 *
 * ReadEra renders twenty formats through five separate engines — MuPDF for PDF,
 * CoolReader for EPUB and Office, DjVuLibre, libmobi, a comic unpacker — and it
 * implements search **once**, in a shared `StSearchUtils.cpp`, over a common
 * `Hitbox` type carrying a rect and a character range. Every engine emits that
 * type; the search, the highlight merging and the match navigation are written
 * a single time.
 *
 * This app has two engines: the WebView viewer (nine formats) and pdfium (PDF).
 * Their natural outputs have nothing in common — the viewer has DOM ranges in
 * CSS pixels that reflow with font size, pdfium has rects in fixed page
 * coordinates. Left to themselves that is two search features with two UIs and
 * two sets of edge cases, and every later feature that wants "a position in a
 * document" has to handle both.
 *
 * So the normalisation is defined first, and both engines are written to it.
 *
 * ## Why `charOffset` is the anchor and rects are optional
 *
 * A character offset into the document's extracted text is the only coordinate
 * both engines can produce and both can honour. It is also **invariant under
 * everything that breaks a pixel offset**: font size, margin, screen width,
 * orientation. That is precisely the property P11 needs to remember a reading
 * position across a rotation, which is why these two phases share a type rather
 * than inventing one each.
 *
 * Rects are the exception rather than the rule. The WebView highlights by
 * wrapping a DOM range in `<mark>` and needs no geometry at all; pdfium has no
 * DOM and can only describe a hit as rectangles on a page. Making them optional
 * keeps the shape honest instead of forcing the viewer to synthesise numbers
 * nobody reads.
 *
 * ## Why this module imports nothing
 *
 * It is pure types and total functions over them, so it runs under Node with no
 * device runtime. Everything in this app that could not be tested off-device
 * has eventually needed to be — that is the whole argument of the audits — and
 * the merging and clamping below is exactly the kind of arithmetic that is
 * wrong in a way nobody notices until a highlight lands on the wrong word.
 */

/** A single match, in whichever document produced it. */
export interface SearchHit {
  /** Which file this hit is in. Hits from several files can share one list. */
  fileId: string
  /**
   * Start of the match, in characters into the document's **extracted text**.
   *
   * Not a DOM offset and not a pixel: this is the coordinate both engines agree
   * on, and the one that survives a font change or a rotation.
   */
  charOffset: number
  /** Length of the match in characters. Never zero — an empty hit is not a hit. */
  length: number
  /**
   * Surrounding text, for a result list that shows *where* a hit is.
   *
   * Carried on the hit rather than fetched later because only the engine still
   * has the full text at the moment the match is found; asking for it
   * afterwards would mean holding the whole document to answer.
   */
  context: string
  /** Offset of the match within `context`, so a UI can embolden it. */
  contextOffset: number
  /**
   * 1-based page, for engines that have pages.
   *
   * Absent for reflowable content, where the page number is a function of
   * layout and is derived at display time rather than being a property of the
   * hit ([DETAIL.md §5.2](../../DETAIL.md)).
   */
  page?: number
  /**
   * Highlight geometry, in the engine's own coordinate space.
   *
   * Only pdfium supplies these. The viewer wraps a DOM range in `<mark>` and
   * has no use for rectangles.
   */
  rects?: SearchRect[]
}

/** One highlight rectangle, in the coordinate space of its page. */
export interface SearchRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** What a caller asks for. */
export interface SearchQuery {
  text: string
  matchCase?: boolean
  wholeWord?: boolean
  /**
   * Stop after this many hits.
   *
   * A search for "the" in a 900-page book has tens of thousands of matches, and
   * nobody pages through them — but building the list still costs the memory
   * and the time. Both engines honour this.
   */
  limit?: number
}

/** Result of one search, with enough context for a UI to say what happened. */
export interface SearchResult {
  hits: SearchHit[]
  /**
   * True when `limit` stopped the search before the document ended.
   *
   * The distinction matters to the UI: "12 results" and "first 200 of more"
   * are different statements, and reporting the second as the first is a lie
   * about the document.
   */
  truncated: boolean
}

/** How many characters of context to keep either side of a match. */
export const CONTEXT_RADIUS = 40

export const EMPTY_RESULT: SearchResult = { hits: [], truncated: false }

/**
 * Builds the context snippet around a match.
 *
 * Clamped to the document's bounds, so a hit at the very start or end does not
 * produce a negative slice — `String.prototype.slice` would silently treat a
 * negative start as "from the end", which puts text from the wrong part of the
 * book next to the match.
 *
 * Whitespace is collapsed because extracted text is full of newlines and runs
 * of spaces from the original layout, and a result row is one line.
 */
export function buildContext(
  text: string,
  start: number,
  length: number,
): { context: string; contextOffset: number } {
  const from = Math.max(0, start - CONTEXT_RADIUS)
  const to = Math.min(text.length, start + length + CONTEXT_RADIUS)

  const raw = text.slice(from, to)
  const prefix = text.slice(from, start)

  // Collapsed *after* measuring the prefix, so the reported offset refers to
  // the string actually returned rather than to the pre-collapse one.
  const context = raw.replace(/\s+/g, ' ').trim()
  const collapsedPrefix = prefix.replace(/\s+/g, ' ').trimStart()

  return { context, contextOffset: Math.min(collapsedPrefix.length, context.length) }
}

/**
 * Finds every occurrence of `query` in `text`, as hits.
 *
 * The shared matcher: both engines can use it, and the WebView one does. It is
 * here rather than in the viewer so that the matching *rules* — case folding,
 * word boundaries, overlap — are defined once and tested once, which is the
 * whole point of this module.
 *
 * `indexOf` in a loop rather than a regex: a user's query is arbitrary text and
 * would have to be escaped to be a safe pattern, and `indexOf` is native and
 * already fast enough for a book. It also cannot backtrack pathologically,
 * which a naive escape can still allow.
 */
export function findMatches(
  text: string,
  query: SearchQuery,
  fileId: string,
): SearchResult {
  const needle = query.text
  if (!needle) return EMPTY_RESULT

  const haystack = query.matchCase ? text : text.toLowerCase()
  const target = query.matchCase ? needle : needle.toLowerCase()

  const hits: SearchHit[] = []
  const limit = query.limit ?? Infinity

  let from = 0
  let truncated = false

  for (;;) {
    const at = haystack.indexOf(target, from)
    if (at === -1) break

    // Advance past this match before any `continue`, so a rejected whole-word
    // candidate cannot spin here forever.
    from = at + target.length

    if (query.wholeWord && !isWholeWord(haystack, at, target.length)) continue

    if (hits.length >= limit) {
      truncated = true
      break
    }

    const { context, contextOffset } = buildContext(text, at, needle.length)
    hits.push({ fileId, charOffset: at, length: needle.length, context, contextOffset })
  }

  return { hits, truncated }
}

/**
 * Whether the match at `start` stands alone rather than inside a longer word.
 *
 * Deliberately not `\b`: that is defined over `[A-Za-z0-9_]`, so it treats
 * every accented and non-Latin letter as a boundary — searching for a Cyrillic
 * or Greek word with "whole word" on would match inside longer words and, worse,
 * would behave differently from the same search in a different script.
 *
 * ReadEra hit the same problem from the other side and hand-rolled case folding
 * for Cyrillic, Greek, Armenian and Georgian rather than pulling in ICU. This
 * is the cheap version of that idea: ask whether the neighbouring character is
 * a letter or digit *in Unicode terms*, which `\p{L}` answers for every script.
 */
function isWholeWord(text: string, start: number, length: number): boolean {
  const before = start > 0 ? text[start - 1] : ''
  const after = start + length < text.length ? text[start + length] : ''
  return !isWordChar(before) && !isWordChar(after)
}

function isWordChar(ch: string): boolean {
  if (!ch) return false
  return /[\p{L}\p{N}]/u.test(ch)
}

/**
 * Merges rects that sit on the same line into single highlight runs.
 *
 * pdfium reports geometry per character range, so a five-word match comes back
 * as a row of adjacent boxes. Drawing them individually shows seams where the
 * boxes meet and rounding gaps between them; ReadEra merges the same way, in
 * `unionRects`.
 *
 * "Same line" is decided by vertical overlap rather than equal tops, because
 * characters of different sizes on one line — a capital, a subscript — do not
 * share a top edge.
 */
export function mergeRects(rects: SearchRect[]): SearchRect[] {
  if (rects.length <= 1) return rects

  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left)
  const out: SearchRect[] = []

  for (const rect of sorted) {
    const last = out[out.length - 1]
    if (last && sameLine(last, rect) && rect.left <= last.right + LINE_GAP) {
      last.right = Math.max(last.right, rect.right)
      last.top = Math.min(last.top, rect.top)
      last.bottom = Math.max(last.bottom, rect.bottom)
      continue
    }
    out.push({ ...rect })
  }

  return out
}

/** Horizontal slack, in page units, that still counts as adjacent. */
const LINE_GAP = 2

function sameLine(a: SearchRect, b: SearchRect): boolean {
  const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  const height = Math.min(a.bottom - a.top, b.bottom - b.top)
  // More than half the shorter box's height in common: tolerant of mixed sizes
  // on one line, and still separates genuinely different lines.
  return height > 0 && overlap > height * 0.5
}
