import { create } from 'zustand'

/**
 * Counts taps the reader recognised on the page.
 *
 * The reader's tap gesture claims the touch when the finger lifts, so the
 * WebView underneath never sees the lift and turns the tap into a long press —
 * a selected word on every tap. WebViewRenderer watches this counter and tells
 * its page "that touch was a tap", which refuses the long press for that touch
 * only (see "taps are not long presses" in viewerHtml.ts).
 */
interface ReaderTap {
  n: number
  bump: () => void
}

export const useReaderTap = create<ReaderTap>((set) => ({
  n: 0,
  bump: () => set((s) => ({ n: s.n + 1 })),
}))
