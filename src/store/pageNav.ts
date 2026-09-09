import { create } from 'zustand'

/**
 * Page-within-document, for the reader's `‹ n / m ›` stepper.
 *
 * Everything is keyed by `fileId` rather than being "the last write".
 *
 * The original reason was that the pager mounted three renderers at once; it no
 * longer does — only the active file is mounted, because three live pdfium
 * documents crashed inside `FPDF_LoadPage`. The keying is still required, for
 * two reasons that survived that change:
 *
 *  - Mounting is not instant. During a swipe the outgoing renderer is still
 *    mounted while the incoming one starts reporting, so two publishers overlap
 *    briefly and a single "last write" slot would flicker between them.
 *  - The prepared-document cache and its pinned window mean neighbouring files
 *    are prepared ahead of time, so a position can be known for a file that is
 *    not currently on screen.
 *
 * A renderer must still call `forget()` on unmount, or its stale
 * `{current,total}` outlives it.
 *
 * Renderers publish with `usePageNav.getState().report(...)` — never a hook —
 * so publishing a page change cannot re-render the publisher.
 */

import type { TocEntry } from '../renderers/webview/pagination'

interface PagePosition {
  current: number
  total: number
  /** What to display — a print page number can be roman numerals. */
  label?: string
  /** How far through the document, 0..100. */
  percent?: number
}

interface PageNavState {
  byFile: Record<string, PagePosition>
  /** Nonce'd jump requests travel back down to the renderer. */
  jump: Record<string, { page: number; nonce: number }>
  /** Chapter selections, addressed by href rather than page. */
  hrefJump: Record<string, { href: string; nonce: number }>
  /** Chapter list per file, populated when a document declares one. */
  toc: Record<string, TocEntry[]>

  report: (
    fileId: string,
    current: number,
    total: number,
    extra?: { label?: string; percent?: number },
  ) => void
  requestJump: (fileId: string, page: number) => void
  requestHref: (fileId: string, href: string) => void
  setToc: (fileId: string, entries: TocEntry[]) => void
  forget: (fileId: string) => void
}

export const usePageNav = create<PageNavState>((set, get) => ({
  byFile: {},
  jump: {},
  hrefJump: {},
  toc: {},

  report: (fileId, current, total, extra) => {
    // Bail when nothing changed, or every scroll frame allocates a new state
    // object and re-renders every subscriber.
    const prev = get().byFile[fileId]
    if (
      prev &&
      prev.current === current &&
      prev.total === total &&
      prev.percent === extra?.percent
    ) {
      return
    }
    set((s) => ({
      byFile: {
        ...s.byFile,
        [fileId]: { current, total, label: extra?.label, percent: extra?.percent },
      },
    }))
  },

  requestHref: (fileId, href) =>
    set((s) => ({
      hrefJump: {
        ...s.hrefJump,
        [fileId]: { href, nonce: (s.hrefJump[fileId]?.nonce ?? 0) + 1 },
      },
    })),

  setToc: (fileId, entries) =>
    set((s) => {
      const prev = s.toc[fileId]
      if (prev === entries || (!prev?.length && !entries.length)) return {}
      return { toc: { ...s.toc, [fileId]: entries } }
    }),

  requestJump: (fileId, page) =>
    set((s) => ({
      jump: {
        ...s.jump,
        [fileId]: { page, nonce: (s.jump[fileId]?.nonce ?? 0) + 1 },
      },
    })),

  forget: (fileId) =>
    set((s) => {
      /*
       * Every map the body deletes from must be checked here.
       *
       * `hrefJump` was deleted below but missing from this guard, so a file
       * that only ever received a TOC chapter jump — the one sequence that
       * populates `hrefJump` and nothing else — took the early return and kept
       * its entry for the life of the process. The guard is an optimisation,
       * not a filter, and an asymmetry between the two lists turns it into one.
       */
      if (
        !(fileId in s.byFile) &&
        !(fileId in s.jump) &&
        !(fileId in s.hrefJump) &&
        !(fileId in s.toc)
      ) {
        return {}
      }
      const byFile = { ...s.byFile }
      const jump = { ...s.jump }
      const hrefJump = { ...s.hrefJump }
      const toc = { ...s.toc }
      delete byFile[fileId]
      delete jump[fileId]
      delete hrefJump[fileId]
      delete toc[fileId]
      return { byFile, jump, hrefJump, toc }
    }),
}))
