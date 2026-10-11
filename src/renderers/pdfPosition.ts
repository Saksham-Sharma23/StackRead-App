/**
 * A PDF's exact position, and the rules for trusting it.
 *
 * Import-free, so the rules are testable without a device; the storage is in
 * `store/scroll` (`getPdfPosition` / `setPdfPosition`).
 *
 * The position is the native view's `getPositionOffset()` — 0..1 through the
 * document — when scrolling last settled, with the page it was on and the
 * window it was measured in. The page number in `getScroll` restores only the
 * *top* of a page, so a reader who stopped halfway down came back half a
 * screen away, and an instant-open picture of where they stopped could not
 * match where the view landed. This restores the same pixels.
 */

export interface PdfPosition {
  page: number
  offset: number
  width: number
  height: number
}

/**
 * Two reports closer than this are the same position.
 *
 * Restoring an offset and reading it back crosses a float32 twice
 * (`setPositionOffset`, then `getPositionOffset`), which can move the last
 * digits. Treated as a change, every reopen would rewrite the stored position
 * and orphan the resume frame named after it. 2e-6 of a 2,000-page document
 * is about ten pixels — below anything a reader would notice as "moved".
 */
export const SAME_POSITION = 2e-6

export function samePdfPosition(a: PdfPosition | null, b: PdfPosition): boolean {
  return (
    a !== null &&
    a.page === b.page &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height) &&
    Math.abs(a.offset - b.offset) < SAME_POSITION
  )
}

export function formatPdfPosition(p: PdfPosition): string {
  return `${p.page}|${p.offset}|${Math.round(p.width)}|${Math.round(p.height)}`
}

export function parsePdfPosition(raw: string | undefined): PdfPosition | null {
  if (!raw) return null
  const parts = raw.split('|').map(Number)
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null
  const [page, offset, width, height] = parts
  return { page, offset, width, height }
}

/**
 * The offset to restore, or null to restore by page alone.
 *
 * Only trusted when it agrees with the stored page — the two are written by
 * different events, and a kill between them must not restore a position on
 * another page — and when the window is the same size: the offset is a
 * fraction of the document's length *minus the view's height*, so at another
 * size the same fraction is another spot.
 */
export function restorablePdfOffset(
  position: PdfPosition | null,
  page: number,
  width: number,
  height: number,
): number | null {
  if (!position || position.page !== page) return null
  if (position.width !== Math.round(width) || position.height !== Math.round(height)) return null
  // Zero is the top of the document, where page 1 already lands.
  return position.offset > 0 && position.offset <= 1 ? position.offset : null
}
