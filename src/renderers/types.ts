import type { FileEntry, FileFormat } from '../types'

/**
 * Formats served by the WebView host rather than a native view.
 *
 * One definition, because three places need the same answer and they must not
 * drift: `FileRenderer` dispatches on it, `prefetch` decides what is worth
 * warming by it, and `HorizontalPager` decides which neighbours are cheap to
 * mount by it. Three copies of this list is exactly the duplicated-decision
 * shape [AUDIT §7](../../AUDIT.md) named as a class of fault.
 */
const WEBVIEW_FORMATS: ReadonlySet<FileFormat> = new Set<FileFormat>([
  'epub',
  'html',
  'markdown',
  'text',
  'docx',
  'xlsx',
  'csv',
  'comic',
  'archive',
])

/**
 * Whether this format is rendered by the WebView host.
 *
 * The complement is the native fast path — PDF and images — which is drawn
 * straight from disk and has no prepared document at all.
 */
export function isWebViewFormat(format: FileFormat): boolean {
  return WEBVIEW_FORMATS.has(format)
}

/**
 * The contract every renderer implements, so the pager never needs to know
 * which family a format belongs to.
 *
 * Two families exist (see the plan):
 *  - **Native fast path** — PDF and images, where a WebView would be visibly slower.
 *  - **WebView host** — everything the desktop app rendered as HTML (P5).
 */
export interface RendererProps {
  file: FileEntry

  /** True only for the file the user is actually looking at. */
  active: boolean

  /**
   * Reports the renderer's current zoom scale.
   *
   * The pager uses this to disable horizontal paging while zoomed in: panning
   * around a zoomed page must never flip to the next file. This is the single
   * most likely "feels broken" bug in the app.
   */
  onScaleChange?: (scale: number) => void

  /**
   * True while the reader is in immersive mode.
   *
   * Renderers own their own safe-area insets — they know whether their content
   * is a paged document or a scrolling one — so the fullscreen inset collapse
   * has to happen here rather than in a wrapper, or the two would stack.
   */
  fullscreen?: boolean
}
