/**
 * Tidies a PDF page's extracted text for reading and copying.
 *
 * pdfium returns the page's characters in reading order with the line breaks
 * the PDF drew — CRLF on most files — plus the odd NUL or form feed where a
 * glyph has no character. Those become plain newlines or go, runs of blank
 * lines collapse to one, and trailing spaces are trimmed, so what the user
 * selects and copies is clean text.
 *
 * Words are deliberately not re-joined across line ends: telling a hyphenated
 * word from a real hyphen at a line end needs a dictionary, and guessing wrong
 * corrupts the text being copied.
 *
 * Imports nothing, so it is tested directly (`pdfPageText.test.ts`).
 */
export function tidyPdfText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000\u000b\u000c￾￿]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
