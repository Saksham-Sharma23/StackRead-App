import { create } from 'zustand'

/**
 * What the board is doing, for consumers that live outside it.
 *
 * `PdfCoverFactory` used to be mounted inside `LibraryScreen` and read these
 * from props. It moved to the app root ([AUDIT4 A8](../../AUDIT4.md)) — the
 * board unmounts the instant a card is tapped, which tore down a half-loaded
 * pdfium document — so the two facts it needs from the board are published here.
 */

/** The groups on screen, newest first. Not React state: see `getVisibleGroups`. */
let visibleGroups: ReadonlySet<string> = new Set()

/**
 * Written on every scroll settle, read only when a capture slot opens.
 *
 * A plain module variable for the same reason `LibraryScreen` kept it in a
 * ref: as state it would re-render its readers on every scroll for information
 * consulted once per cover.
 */
export function setVisibleGroups(ids: ReadonlySet<string>): void {
  visibleGroups = ids
}

export function getVisibleGroups(): ReadonlySet<string> {
  return visibleGroups
}

interface BoardActivity {
  /** An import, backup or restore is running; background work should wait. */
  busy: boolean
  setBusy: (busy: boolean) => void
}

/** State, because the factory must stop and start as this changes. */
export const useBoardActivity = create<BoardActivity>((set) => ({
  busy: false,
  setBusy: (busy) => set((s) => (s.busy === busy ? s : { busy })),
}))
