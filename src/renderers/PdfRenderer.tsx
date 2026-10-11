import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  InteractionManager,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native'
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { Image } from 'expo-image'
import Pdf, { type PdfRef } from 'react-native-pdf'

import { LoadingCover } from '../components/LoadingCover'
import { fileUri } from '../storage/paths'
import { captureFirstPage } from '../storage/thumbs'
import { existingPreview, savePreview } from '../storage/pdfPreview'
import { getScroll, setScroll, setProgress } from '../store/scroll'
import { useLibrary } from '../store/library'
import { usePageNav } from '../store/pageNav'
import { useSearch } from '../store/search'
import { usePdfSearch } from './usePdfSearch'
import { acquirePdfium, type PdfiumLease } from '../storage/pdfiumLease'
import { useTheme } from '../ui/theme'
import type { RendererProps } from './types'

/**
 * PDF via `react-native-pdf` (pdfium, through AndroidPdfViewer).
 *
 * Chosen over `react-native-pdf-renderer` because the page stepper and the
 * pager's zoom-lock both need APIs that library does not expose: page jumps and
 * `onPageChanged` for the stepper, and `onScaleChanged` for the lock.
 *
 * Position is remembered as a **page number**, not a pixel offset — pixels are
 * meaningless across rotations and zoom levels for a paged document.
 *
 * ## Why every prop handed to the native view is fixed for its lifetime
 *
 * `react-native-pdf`'s view manager posts `drawPdf()` after **every** prop
 * update (`PdfManager.onAfterUpdateTransaction`), and AndroidPdfViewer's
 * `Configurator.load()` answers that by recycling the document and parsing it
 * again from scratch. So any prop that changed after mount reloaded the whole
 * file — and three did, routinely:
 *
 *  - the fullscreen inset, animated as the view's own margins: every chrome
 *    hide and show, including the automatic one 2.5s after opening, became a
 *    burst of layout commits and a reload for each;
 *  - `page`, which every scrollbar seek and search hit changed;
 *  - a style array rebuilt on each render.
 *
 * On a large PDF each reload is seconds, so the document visibly loaded, then
 * loaded again ([perf: Drive-like PDF opening]). Now: the view fills the window
 * and never resizes (the chrome overlays it, as Drive's does), `page` is only
 * the initial page, jumps go through the native `setPage` command, and every
 * other prop is memoised. A patch to `react-native-pdf` makes `drawPdf()`
 * idempotent as well (`patches/`), so nothing reloads a document it already
 * has — but the renderer does not rely on that.
 *
 * `fullscreen` is deliberately not read: resizing the document to follow the
 * system bars is exactly the reload above, and an O(pages) re-layout per frame
 * even without it.
 */

/**
 * How long after `onLoadComplete` the document counts as settled.
 *
 * `onLoadComplete` means parsed, not painted — pdfium renders the first pages
 * on its own thread afterwards. Matches the 400ms the cover capture already
 * waits for the same reason, with headroom for a full screen of pages.
 */
const FIRST_PAGES_MS = 600

/** How long the instant-open preview takes to give way to the live document. */
const PREVIEW_FADE_MS = 180

export function PdfRenderer({ file, active, onScaleChange }: RendererProps) {
  const theme = useTheme()
  const window = useWindowDimensions()

  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  // Restored once, on mount. Re-reading later would fight the user's scrolling.
  const initialPage = useRef(Math.max(1, Math.round(getScroll(file.id)) || 1)).current

  /*
   * The right to open a pdfium document ([AUDIT4 A8](../../AUDIT4.md)).
   *
   * The cover factory may be mid-capture when a PDF is opened. It drains
   * rather than aborting — letting its document finish loading before it
   * unmounts — and this waits for that, so two documents are never live at
   * once. Released on unmount; a lease granted after this renderer is gone is
   * handed straight back.
   */
  const [leased, setLeased] = useState(false)
  const leaseRef = useRef<PdfiumLease | null>(null)

  useEffect(() => {
    let gone = false
    void acquirePdfium(`reader:${file.id}`).then((lease) => {
      if (gone) {
        lease.release()
        return
      }
      leaseRef.current = lease
      setLeased(true)
    })
    return () => {
      gone = true
      leaseRef.current?.release()
      leaseRef.current = null
    }
  }, [file.id])

  /*
   * The instant-open preview: the frame this document showed last time, at
   * this window size, laid over the view until the live document has rendered
   * ([storage/pdfPreview](../storage/pdfPreview.ts)).
   *
   * Only for an open that lands on page 1 — the snapshot is of page 1's first
   * frame, and showing it over any other page would be a picture of somewhere
   * the reader is not going. Read once, at mount, against the window size then.
   */
  const frameAtMount = useRef({ width: window.width, height: window.height }).current
  const [previewUri] = useState(() =>
    initialPage === 1 ? existingPreview(file.id, frameAtMount.width, frameAtMount.height) : null,
  )
  const previewSource = useMemo(() => (previewUri ? { uri: previewUri } : null), [previewUri])
  const [previewGone, setPreviewGone] = useState(previewUri === null)
  const previewOpacity = useSharedValue(1)
  const previewStyle = useAnimatedStyle(() => ({ opacity: previewOpacity.value }))

  /*
   * Marks the document settled once it has loaded and its first pages have had
   * time to render. That releases a closing reader (`whenPdfiumSettled`) and
   * fades the preview, which must not uncover a page pdfium has not drawn yet.
   */
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const markSettled = useCallback(() => {
    if (settleTimer.current) return
    settleTimer.current = setTimeout(() => {
      leaseRef.current?.markSettled()
      previewOpacity.value = withTiming(0, { duration: PREVIEW_FADE_MS }, (finished) => {
        'worklet'
        if (finished) runOnJS(setPreviewGone)(true)
      })
    }, FIRST_PAGES_MS)
  }, [previewOpacity])
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current)
    },
    [],
  )

  /**
   * The view handed to `captureRef` for the preview and the cover.
   *
   * Needs `collapsable={false}` on the element itself: React Native flattens
   * view hierarchies on Android, and a collapsed view has no native handle to
   * capture — the call fails with an unhelpful error rather than a blank image.
   */
  const pdfViewRef = useRef<View>(null)
  const pdfRef = useRef<PdfRef>(null)
  const viewSize = useRef({ width: 0, height: 0 })
  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    viewSize.current = { width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height }
  }, [])

  const report = usePageNav((s) => s.report)
  const forget = usePageNav((s) => s.forget)
  const jump = usePageNav((s) => s.jump[file.id])

  /*
   * Find-in-document, over the pdfium text engine already in the build.
   *
   * A hook rather than viewer code because a PDF has no DOM to hold matches in
   * — see `usePdfSearch`. It reports into the same store the WebView viewer
   * does, so the search bar sees one feature.
   */
  usePdfSearch(file, active)

  // Per-file search state must not outlive its renderer, for the same reason
  // pageNav's does not: a stale count would describe the previous document.
  useEffect(() => () => useSearch.getState().forget(file.id), [file.id])

  /*
   * Guards the saved position against the load sequence.
   *
   * The native view emits `onPageChanged(1, n)` while it settles, *before* it
   * has moved to the restored page. Persisting that would overwrite the saved
   * position with 1 every single time the file is opened — the restore appears
   * to work in-session (the view does jump) while the stored value has already
   * been destroyed, so the loss only shows up on the *next* open. Reports are
   * ignored until the view reaches the page we asked for, or the user moves
   * off it themselves.
   *
   * A ref, not state: this must not re-render, and it has to be readable by the
   * callback synchronously on the very first event.
   */
  const restored = useRef(initialPage <= 1)

  /** Whether the user has left page 1, which makes a fresh capture misleading. */
  const moved = useRef(false)

  /*
   * Page jumps — the scrollbar, a search hit — through the native command.
   *
   * Never through the `page` prop: a prop change is a full document reload in
   * this library (see the header). A jump that arrives before the document has
   * loaded is held and applied once it has.
   */
  const loaded = useRef(false)
  const pendingJump = useRef<number | null>(null)
  useEffect(() => {
    if (!jump) return
    // An explicit jump supersedes the restore, so let positions persist again.
    restored.current = true
    if (loaded.current && pdfRef.current) pdfRef.current.setPage(jump.page)
    else pendingJump.current = jump.page
  }, [jump])

  // A stale {current,total} must not outlive this renderer.
  useEffect(() => {
    return () => forget(file.id)
  }, [file.id, forget])

  const handlePageChanged = useCallback(
    (page: number, numberOfPages: number) => {
      if (!restored.current) {
        if (page <= 1) {
          // The settling report, before the view has moved to the restored
          // page. Show the position we are restoring *to*, so the indicator
          // does not flash page 1, and leave the stored value alone.
          report(file.id, initialPage, numberOfPages)
          return
        }
        // Any page above 1 means the view has moved: either it arrived at the
        // restored page, or the user scrolled before it got there. Both are
        // real positions, so persistence resumes from here either way.
        restored.current = true
      }
      if (page !== 1) moved.current = true

      const percent =
        numberOfPages > 1 ? Math.round(((page - 1) / (numberOfPages - 1)) * 100) : 100
      report(file.id, page, numberOfPages, { percent })
      setScroll(file.id, page)
      setProgress(file.id, percent)
    },
    [file.id, initialPage, report],
  )

  /*
   * Captures page 1's first frame: as next time's instant-open preview, and as
   * the card cover when the file has none.
   *
   * A PDF page is *drawn*, not stored, so there is no image to extract — it has
   * to be rasterised, and the native view is the only thing that can do it.
   * This rides the one document the reader already has open and never creates
   * another (three live pdfium documents crashed inside `FPDF_LoadPage`,
   * DETAIL.md 8).
   *
   * Guarded so a capture never disturbs reading or records the wrong thing:
   *  - only for the file on screen, only for an open that landed on page 1;
   *  - only once per mount, and only if a preview or cover is missing;
   *  - skipped if the reader has already left page 1.
   */
  const captured = useRef(false)

  const captureFirstFrame = useCallback(
    (pageSize: { width: number; height: number }) => {
      if (captured.current || initialPage !== 1) return
      const needPreview = !existingPreview(file.id, frameAtMount.width, frameAtMount.height)
      if (!needPreview && file.thumb) return
      captured.current = true

      /*
       * Deferred past the first frames: `onLoadComplete` fires when the document
       * is parsed, not when the page has finished rendering, and waiting for
       * interactions keeps the capture off the critical path of opening.
       */
      void InteractionManager.runAfterInteractions(async () => {
        try {
          // pdfium renders asynchronously after layout; there is no callback for
          // "the page is on screen".
          await new Promise((resolve) => setTimeout(resolve, 400))
          if (!pdfViewRef.current || moved.current) return

          /*
           * Imported here rather than at module scope, and this is load-bearing:
           * `react-native-view-shot` is a native module, and an eager import
           * would take the whole renderer tree down on a JS bundle running
           * against a binary that predates it. Deferred, the mismatch costs a
           * missing picture instead of a dead app.
           */
          const { captureRef } = await import('react-native-view-shot')
          const shot = await captureRef(pdfViewRef, { format: 'jpg', quality: 0.85, result: 'tmpfile' })
          if (moved.current) return

          // How much of the frame is page 1, so the cover can be cropped to it.
          const view = viewSize.current
          const pageFraction =
            view.width > 0 && view.height > 0 && pageSize.width > 0
              ? Math.min(1, (view.width * (pageSize.height / pageSize.width)) / view.height)
              : 1

          if (!file.thumb) {
            const result = await captureFirstPage(file, shot, pageFraction)
            if (result) useLibrary.getState().setThumb(file.id, result.thumb, result.thumbhash)
          }
          // Last: `savePreview` takes ownership of the capture and deletes it.
          if (needPreview) savePreview(file.id, frameAtMount.width, frameAtMount.height, shot)
        } catch {
          // A preview and a cover are niceties; never let them reach the reader.
        }
      })
    },
    [file, initialPage, frameAtMount],
  )

  /*
   * Stable identities for everything handed to the native view.
   *
   * Every prop change is a full reload in this library (see the header), so
   * nothing here may be rebuilt per render.
   *
   * `cache: false`: for a local file the cache path only costs a `stat` of a
   * download-cache file that never exists before the view can mount.
   */
  const source = useMemo(() => ({ uri: fileUri(file.storedName), cache: false }), [file.storedName])
  const pdfStyle = useMemo(() => [styles.fill, { backgroundColor: theme.gutter }], [theme.gutter])

  const handleScaleChanged = useCallback((s: number) => onScaleChange?.(s), [onScaleChange])

  const handleError = useCallback((e: unknown) => {
    // A document that failed to load is not loading; nothing to wait for.
    leaseRef.current?.markSettled()
    setError(String(e))
  }, [])

  // The loading state is ours (the preview, or `LoadingCover`), so the
  // library's own indicator renders nothing.
  const renderNothing = useCallback(() => <View />, [])

  /*
   * Read through a ref, so `handleLoadComplete` keeps one identity for the life
   * of the view. A callback that changed when `active` flipped was a new prop —
   * and a new prop is a reload.
   */
  const activeRef = useRef(active)
  activeRef.current = active

  const handleLoadComplete = useCallback(
    (numberOfPages: number, _path: string, size: { width: number; height: number }) => {
      loaded.current = true
      setReady(true)
      markSettled()
      report(file.id, initialPage, numberOfPages)
      if (pendingJump.current !== null) {
        pdfRef.current?.setPage(pendingJump.current)
        pendingJump.current = null
      }
      if (activeRef.current) captureFirstFrame(size)
    },
    [file.id, initialPage, report, captureFirstFrame, markSettled],
  )

  if (error) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <Text style={[styles.errTitle, { color: theme.fg }]}>Couldn’t open this PDF</Text>
        <Text style={[styles.errBody, { color: theme.fgDim }]}>{error}</Text>
      </View>
    )
  }

  return (
    // The capture target: the document alone, with no reader chrome in it.
    <View
      ref={pdfViewRef}
      collapsable={false}
      onLayout={handleLayout}
      style={[styles.fill, { backgroundColor: theme.gutter }]}
    >
      {leased && (
        <Pdf
          ref={pdfRef}
          source={source}
          // The initial page only. Later jumps use `setPage` — see the header.
          page={initialPage}
          onLoadComplete={handleLoadComplete}
          onPageChanged={handlePageChanged}
          onScaleChanged={handleScaleChanged}
          onError={handleError}
          minScale={1}
          maxScale={5}
          // Continuous vertical scroll through the whole document, the way Drive
          // and every other reader behaves — not one page at a time.
          horizontal={false}
          enablePaging={false}
          enableAnnotationRendering
          // Fit to width (0), so text fills the screen and only needs vertical
          // scrolling. This was 2 ("both") under a comment that said width.
          fitPolicy={0}
          // A gap against the gutter colour is what makes each page read as a
          // separate sheet, the way Drive shows a document.
          spacing={14}
          trustAllCerts={false}
          renderActivityIndicator={renderNothing}
          style={pdfStyle}
        />
      )}

      {/*
        Instant open: last time's first frame, exactly where the live page will
        appear, until pdfium has drawn it. Without one, the blurred cover.
      */}
      {!previewGone && previewUri !== null && (
        <Animated.View
          style={[StyleSheet.absoluteFill, styles.previewHost, { backgroundColor: theme.gutter }, previewStyle]}
          pointerEvents="none"
        >
          {/*
            Width-scaled at the frame's own aspect, top-aligned: fit-to-width
            means page 1's size is set by the view's width alone, so scaling by
            width keeps it exactly where the live page will draw even if the
            view's height differs slightly from the window the frame was taken
            at. Any difference falls at the bottom, over the gutter.
          */}
          <Image
            source={previewSource}
            style={{ width: '100%', aspectRatio: frameAtMount.width / frameAtMount.height }}
            contentFit="fill"
            transition={0}
          />
        </Animated.View>
      )}
      {previewUri === null && !ready && active && (
        <LoadingCover theme={theme} thumbhash={file.thumbhash} />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, width: '100%' },
  previewHost: { overflow: 'hidden', justifyContent: 'flex-start' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 8 },
  errTitle: { fontSize: 16, fontWeight: '600' },
  errBody: { fontSize: 13, textAlign: 'center' },
})
