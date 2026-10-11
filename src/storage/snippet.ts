import { strFromU8 } from 'fflate'

/**
 * The first few lines of a document, for a card that would otherwise show only
 * a format badge.
 *
 * ## Why this exists
 *
 * Only images, PDFs, EPUBs and comics get a real cover. DOCX, XLSX, CSV,
 * Markdown, TXT, HTML and ZIP fall back to a coloured label, so a library of
 * documents is a wall of badges — and the badge says what a file *is*, which is
 * the one thing the filename underneath already says. It never says what the
 * file is *about*.
 *
 * ## Why a snippet and not a rendered thumbnail
 *
 * Rasterising text into a JPEG is what the PDF cover factory does, and it costs
 * a live native view, an off-screen mount, a settle delay and a capture per
 * file — the machinery `PdfCoverFactory` documents at length, and a second
 * unbounded queue of it is exactly what the cover work is already being asked
 * to bound.
 *
 * A snippet needs none of that. The card draws the text itself, so this module
 * only has to produce a short string: no image, no disk write, no thumbnail
 * cache entry, nothing to invalidate. It is also *better* at small sizes —
 * downscaled body text is grey mush at 132pt wide, whereas four lines set at a
 * legible size actually read.
 *
 * ## Why the extraction is deliberately crude
 *
 * This runs on the JS thread when a card first appears, so it has a hard budget.
 * It reads a bounded prefix of the file rather than the whole thing, and does no
 * real parsing — a DOCX is a zip and an XLSX is a zip, so neither is attempted
 * here at all. What is left (Markdown, text, CSV, HTML) is the set where the
 * first bytes on disk genuinely are the first words of the document.
 */

/** Characters read from the file. A few lines is all the card can show. */
const READ_BYTES = 2048

/** Characters kept after cleaning. Four short lines at card width. */
const MAX_CHARS = 220

/**
 * Formats whose leading bytes are usable text.
 *
 * `docx` and `xlsx` are absent on purpose: both are zip containers, so their
 * first bytes are archive headers. Extracting them means unzipping and parsing,
 * which is `prepareFile`'s job and far too much work for a card.
 */
export type SnippetFormat = 'text' | 'markdown' | 'csv' | 'html'

export function canSnippet(format: string): format is SnippetFormat {
  return format === 'text' || format === 'markdown' || format === 'csv' || format === 'html'
}

/**
 * Strips the markup that would otherwise dominate a short preview.
 *
 * Not a sanitiser and not a parser — the output is rendered as *text* by the
 * card, never as markup, so nothing here is load-bearing for safety. It exists
 * only so the preview shows prose rather than `##` and `<div class=`.
 */
function clean(raw: string, format: SnippetFormat): string {
  let text = raw

  if (format === 'html') {
    // Drop whole elements whose content is never prose, then remaining tags.
    text = text
      .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      // The handful of entities common enough to look wrong if left raw.
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
  }

  if (format === 'markdown') {
    text = text
      // Fenced code blocks: a preview of ``` and a language name says nothing.
      .replace(/```[\s\S]*?```/g, ' ')
      // Leading heading, quote and list markers, but not the words after them.
      .replace(/^[ \t]*[#>*+-]+[ \t]*/gm, '')
      // Images before links, so an image's alt text does not survive as a word.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Emphasis and inline code markers, keeping their contents.
      .replace(/[*_`]/g, '')
  }

  if (format === 'csv') {
    // Commas and tabs become spaced separators so a row reads as a row rather
    // than as one run-together word.
    text = text.replace(/[,\t]/g, '  ')
  }

  return text
    // Any run of whitespace — including the newlines this collapses — becomes a
    // single space, so the card's own line wrapping decides where lines break.
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Trims to length without cutting a word in half.
 *
 * A preview ending mid-word reads as corrupt rather than as truncated. Falls
 * back to a hard cut when there is no space to break on, which is what a very
 * long unbroken token (a URL, a base64 blob) produces.
 */
export function trimToWord(text: string, max = MAX_CHARS): string {
  if (text.length <= max) return text

  const cut = text.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  // Only honour the space if it is reasonably near the end; otherwise the
  // result would be far shorter than asked for.
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…'
}

/**
 * Builds the preview string from a file's leading bytes.
 *
 * Exported separately from any file reading so it can be tested in Node: the
 * caller supplies the text, this decides what is worth showing.
 */
export function snippetFrom(raw: string, format: SnippetFormat): string | null {
  const cleaned = clean(raw, format)
  /*
   * A preview of two words is worse than a badge — it looks like a failed read
   * rather than a summary. Below this the card keeps its badge.
   */
  if (cleaned.length < 24) return null
  return trimToWord(cleaned)
}

/** How many bytes a caller should read before calling `snippetFrom`. */
export const SNIPPET_READ_BYTES = READ_BYTES

/**
 * Decodes the first bytes of a text file.
 *
 * The caller reads a fixed number of bytes rather than the whole file
 * ([AUDIT4 A7](../../AUDIT4.md)), so the read can end in the middle of a
 * multi-byte character. fflate's UTF-8 decoder throws on an incomplete sequence,
 * so one cut short at the end is dropped first. A file that is not UTF-8 at all
 * (Windows-1252 notes, Latin-1 logs) decodes as Latin-1 rather than producing
 * nothing — a preview with an odd accent is better than a badge.
 */
export function decodePrefix(bytes: Uint8Array): string {
  let end = bytes.length

  // Walk back over continuation bytes (10xxxxxx) to the start of the last
  // sequence, then drop it if the read did not reach its end.
  let lead = end - 1
  let continuation = 0
  while (lead >= 0 && continuation < 3 && (bytes[lead] & 0xc0) === 0x80) {
    lead--
    continuation++
  }
  if (lead >= 0 && bytes[lead] >= 0xc0) {
    const length = bytes[lead] >= 0xf0 ? 4 : bytes[lead] >= 0xe0 ? 3 : 2
    if (end - lead < length) end = lead
  }

  const head = bytes.subarray(0, end)
  // Validated explicitly rather than by catching: fflate decodes leniently
  // where a `TextDecoder` exists and strictly where it does not, so relying on
  // a throw would give different previews on different runtimes.
  return strFromU8(head, !isUtf8(head))
}

/** True when `bytes` is well-formed UTF-8 (no overlong or surrogate checks needed for a preview). */
function isUtf8(bytes: Uint8Array): boolean {
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    const extra = b < 0x80 ? 0 : b >= 0xc2 && b < 0xe0 ? 1 : b >= 0xe0 && b < 0xf0 ? 2 : b >= 0xf0 && b < 0xf5 ? 3 : -1
    // An invalid lead byte, or a sequence that runs past the end.
    if (extra < 0 || i + extra > bytes.length - 1) return false
    for (let k = 1; k <= extra; k++) {
      if ((bytes[i + k] & 0xc0) !== 0x80) return false
    }
    i += extra + 1
  }
  return true
}
