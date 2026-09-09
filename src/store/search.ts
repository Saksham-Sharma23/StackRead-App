import { create } from 'zustand'

/**
 * Find-in-document state: the query, where the results are, and the requests
 * that travel down to a renderer.
 *
 * ## Why this mirrors `pageNav` rather than inventing a shape
 *
 * The problem is identical — a value the renderer publishes, and a command the
 * UI sends back — so the same two mechanisms apply, and for the same reasons:
 *
 *  - **Keyed by `fileId`.** During a swipe the outgoing renderer is still
 *    mounted while the incoming one starts reporting, so a single "last write"
 *    slot would flicker between two documents' match counts.
 *  - **Requests carry a nonce.** Pressing "next" twice on a one-match document
 *    sends the same command twice; without a nonce the second is
 *    indistinguishable from the first and the effect that delivers it never
 *    re-runs. This is the same trick `jump` uses for the scrollbar.
 *
 * ## What is deliberately *not* here
 *
 * The hits themselves. The viewer owns its `<mark>` elements and navigates
 * between them by index; shipping the full match list across the bridge would
 * duplicate state that already exists in a form the JS side cannot act on
 * anyway. What crosses is a count and a position — the two things a UI shows.
 *
 * The PDF path will need more than that (it has no DOM to hold marks in), which
 * is why the shared hit shape in `search/types.ts` exists. This store is the
 * transport for both; only the payload differs.
 */

/** What a renderer reports back about the current search. */
export interface SearchStatus {
  /** The query these results are for, so a stale report can be recognised. */
  query: string
  /** Total matches painted. Zero means "searched and found nothing". */
  total: number
  /** 1-based position within the matches; 0 when there are none. */
  current: number
  /** True when a match limit stopped the search before the document ended. */
  truncated?: boolean
}

interface SearchState {
  /** Whether the search bar is open. Not per-file: it is one UI. */
  open: boolean
  /** The live query text, as typed. */
  query: string
  /** Per-file results, published by whichever renderer owns that file. */
  byFile: Record<string, SearchStatus>
  /** Nonce'd commands travelling down to a renderer. */
  request: Record<string, { query: string; nonce: number }>
  step: Record<string, { delta: number; nonce: number }>

  setOpen: (open: boolean) => void
  setQuery: (query: string) => void
  /** Runs `query` against one file. */
  submit: (fileId: string, query: string) => void
  /** Moves to the next (+1) or previous (-1) match. */
  stepMatch: (fileId: string, delta: number) => void
  /** Publishes a renderer's result. Called via `getState()`, never as a hook. */
  report: (fileId: string, status: SearchStatus) => void
  /** Closes the bar and clears highlights for the file. */
  close: (fileId?: string) => void
  /** Drops a file's state, on renderer unmount. */
  forget: (fileId: string) => void
}

let nonce = 0

export const useSearch = create<SearchState>((set) => ({
  open: false,
  query: '',
  byFile: {},
  request: {},
  step: {},

  setOpen: (open) => set({ open }),

  setQuery: (query) => set({ query }),

  submit: (fileId, query) =>
    set((s) => ({
      query,
      request: { ...s.request, [fileId]: { query, nonce: ++nonce } },
    })),

  stepMatch: (fileId, delta) =>
    set((s) => ({
      step: { ...s.step, [fileId]: { delta, nonce: ++nonce } },
    })),

  report: (fileId, status) =>
    set((s) => {
      const prev = s.byFile[fileId]
      // Identical reports are dropped rather than re-set: the viewer confirms
      // its position after every jump, and a no-op `set` would re-render the
      // search bar on each one.
      if (
        prev &&
        prev.query === status.query &&
        prev.total === status.total &&
        prev.current === status.current &&
        prev.truncated === status.truncated
      ) {
        return {}
      }
      return { byFile: { ...s.byFile, [fileId]: status } }
    }),

  close: (fileId) =>
    set((s) => {
      const next: Partial<SearchState> = { open: false, query: '' }
      if (fileId) {
        // A cleared query is the signal to drop highlights: the renderer's
        // effect sees a new nonce with an empty query and tells the viewer.
        next.request = { ...s.request, [fileId]: { query: '', nonce: ++nonce } }
        const byFile = { ...s.byFile }
        delete byFile[fileId]
        next.byFile = byFile
      }
      return next
    }),

  forget: (fileId) =>
    set((s) => {
      const byFile = { ...s.byFile }
      const request = { ...s.request }
      const step = { ...s.step }
      delete byFile[fileId]
      delete request[fileId]
      delete step[fileId]
      return { byFile, request, step }
    }),
}))
