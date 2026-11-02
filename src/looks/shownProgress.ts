/**
 * What each look card last showed as its progress, 0..100, by file id.
 *
 * The board is unmounted while a file is read, so a card remounts with the new
 * progress already in place and there is nothing to animate from. Remembering
 * what it *showed* lets it start from there and grow to the new value — the one
 * moment the board acknowledges that reading happened.
 *
 * Import-free on purpose: storage/lifecycle.ts, which is in the startup graph,
 * clears it with every other file-id-keyed cache (CLAUDE.md §7).
 */
const shown = new Map<string, number>()

export function getShownProgress(fileId: string): number | undefined {
  return shown.get(fileId)
}

export function setShownProgress(fileId: string, percent: number): void {
  shown.set(fileId, percent)
}

export function forgetShownProgress(fileId: string): void {
  shown.delete(fileId)
}

export function clearShownProgress(): void {
  shown.clear()
}
