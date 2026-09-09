import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, InteractionManager, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import Pdf from 'react-native-pdf'

import { LoadingCover } from '../components/LoadingCover'
import { fileUri } from '../storage/paths'
import { captureFirstPage } from '../storage/thumbs'
import { getScroll, setScroll, setProgress } from '../store/scroll'
import { useLibrary } from '../store/library'
import { usePageNav } from '../store/pageNav'
import { useSearch } from '../store/search'
import { usePdfSearch } from './usePdfSearch'
import { useTheme } from '../ui/theme'
import { Spring } from '../ui/motion'
import type { RendererProps } from './types'

/**
 * PDF via `react-native-pdf` (native PdfKit / PdfRenderer under the hood).
 *
 * Chosen over `react-native-pdf-renderer` because the page stepper and the
 * pager's zoom-lock both need APIs that library does not expose: `page` /
 * `onPageChanged` for the stepper, and `onScaleChanged` for the lock.
 *
 * Position is remembered as a **page number**, not a pixel offset — pixels are
 * meaningless across rotations and zoom levels for a paged document.
 */
const AnimatedPdf = Animated.createAnimatedComponent(Pdf)

export function PdfRenderer({ file, active, fullscreen, onScaleChange }: RendererProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()

  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  /**
   * The view handed to `captureRef` for the cover snapshot.
   *
   * Needs `collapsable={false}` on the element itself: React Native flattens
   * view hierarchies on Android, and a collapsed view has no native handle to
   * capture — the call fails with an unhelpful error rather than a blank image.
   */
  const pdfViewRef = useRef<View>(null)

  // Animated rather than switched: entering fullscreen should read as the page
  // expanding into the space, not as a jolt.
  const inset = useSharedValue(1)

  useEffect(() => {
    inset.value = withSpring(fullscreen ? 0 : 1, Spring.smooth)
  }, [fullscreen, inset])

  const insetStyle = useAnimatedStyle(() => ({
    marginTop: insets.top * inset.value,
    marginBottom: insets.bottom * inset.value,
  }))

  // Restored once, on mount. Re-reading later would fight the user's scrolling.
  const initialPage = useRef(Math.max(1, Math.round(getScroll(file.id)) || 1)).current

  const report = usePageNav((s) => s.report)
  const forget = usePageNav((s) => s.forget)
  const jump = usePageNav((s) => s.jump[file.id])

  const [targetPage, setTargetPage] = useState(initialPage)

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
   * The native view emits `onPageChanged(1, n)` while it settles, *before* the
   * `page` prop has moved it to the restored page. Persisting that would
   * overwrite the saved position with 1 every single time the file is opened —
   * the restore appears to work in-session (the view does jump) while the
   * stored value has already been destroyed, so the loss only shows up on the
   * *next* open. Reports are ignored until the view reaches the page we asked
   * for, or the user moves off it themselves.
   *
   * A ref, not state: this must not re-render, and it has to be readable by the
   * callback synchronously on the very first event.
   */
  const restored = useRef(initialPage <= 1)

  // Serve programmatic page jumps. Nothing drives these today, but restoring a
  // saved position and P5's EPUB navigation both go through here.
  useEffect(() => {
    if (!jump) return
    // An explicit jump supersedes the restore, so let positions persist again.
    restored.current = true
    setTargetPage(jump.page)
  }, [jump])

  // A stale {current,total} must not outlive this renderer.
  useEffect(() => {
    return () => forget(file.id)
  }, [file.id, forget])

  const handlePageChanged = useCallback(
    (page: number, numberOfPages: number) => {
      if (!restored.current) {
        if (page <= 1) {
          // The settling report, before the `page` prop has moved the view.
          // Show the position we are restoring *to*, so the indicator does not
          // flash page 1, and leave the stored value alone.
          report(file.id, initialPage, numberOfPages)
          return
        }
        // Any page above 1 means the view has moved: either it arrived at the
        // restored page, or the user scrolled before it got there. Both are
        // real positions, so persistence resumes from here either way.
        restored.current = true
      }

      const percent =
        numberOfPages > 1 ? Math.round(((page - 1) / (numberOfPages - 1)) * 100) : 100
      report(file.id, page, numberOfPages, { percent })
      setScroll(file.id, page)
      setProgress(file.id, percent)
    },
    [file.id, initialPage, report],
  )

  /*
   * Capture this document's first page as its card thumbnail.
   *
   * A PDF page is *drawn*, not stored, so unlike every other format there is no
   * image to extract — it has to be rasterised, and the native view is the only
   * thing that can do it. That is why a PDF cover arrives on first open rather
   * than at import.
   *
   * The alternative — mounting an off-screen PDF view per file at import time —
   * is specifically the shape that crashed inside `FPDF_LoadPage` when three
   * pdfium documents were live at once (DETAIL.md 8). So this deliberately
   * rides the one document the reader already has open and never creates
   * another.
   *
   * Guarded three ways, because a capture must never disturb reading:
   *  - only for the file the user is actually looking at;
   *  - only once, and only when the entry has no thumbnail yet;
   *  - only on the *restored* page if that page is 1, so we never store a
   *    picture of page 40 as the book's cover.
   */
  const captured = useRef(false)

  const captureCover = useCallback(() => {
    if (captured.current || file.thumb) return
    // Only page 1 is a cover. Reopening a book mid-way must not overwrite it.
    if (initialPage !== 1) return
    captured.current = true

    /*
     * Deferred past the first frames.
     *
     * `onLoadComplete` fires when the document is parsed, not when the page has
     * finished rendering — capturing immediately yields a blank or half-drawn
     * sheet. Waiting for interactions to settle also keeps the rasterise off
     * the critical path of opening a file.
     */
    void InteractionManager.runAfterInteractions(async () => {
      try {
        // A short settle: pdfium renders asynchronously after layout, and there
        // is no callback for "the page is on screen".
        await new Promise((resolve) => setTimeout(resolve, 400))
        if (!pdfViewRef.current) return

        /*
         * Imported here rather than at module scope, and this is load-bearing.
         *
         * `react-native-view-shot` is a native module, so importing it at the
         * top of this file makes the *entire renderer tree* fail to evaluate on
         * a JS bundle running against an app binary that predates it —
         * `FileRenderer` imports this module eagerly, so every format breaks,
         * not just PDF, and it surfaces as "could not load the bundle" rather
         * than anything mentioning PDFs or covers.
         *
         * That is exactly what happens during normal development: a JS change
         * arrives over Fast Refresh, but a new native module needs a rebuild.
         * Deferring the import to the moment a cover is actually captured means
         * the mismatch costs a missing thumbnail instead of a dead app.
         */
        const { captureRef } = await import('react-native-view-shot')

        const shot = await captureRef(pdfViewRef, {
          format: 'jpg',
          quality: 0.8,
          result: 'tmpfile',
        })

        const result = await captureFirstPage(file, shot)
        if (result) useLibrary.getState().setThumb(file.id, result.thumb, result.thumbhash)
      } catch {
        // A cover is a nicety; never let it surface to the reader.
      }
    })
  }, [file, initialPage])

  /*
   * Stable identities for everything handed to the native view.
   *
   * This component re-renders on every seek (`targetPage` is state) and on
   * every reported page change, so any prop built inline here churns at
   * exactly the moments the document is busiest.
   */
  const source = useMemo(
    () => ({ uri: fileUri(file.storedName), cache: true }),
    [file.storedName],
  )

  const handleScaleChanged = useCallback(
    (s: number) => onScaleChange?.(s),
    [onScaleChange],
  )

  const handleError = useCallback((e: unknown) => setError(String(e)), [])

  // Hoisted with the rest: an inline arrow here is a new render prop on every
  // render of a component that re-renders on every seek.
  const renderSpinner = useCallback(
    () => <ActivityIndicator color={theme.accent} />,
    [theme.accent],
  )

  const handleLoadComplete = useCallback(
    (numberOfPages: number) => {
      setReady(true)
      report(file.id, initialPage, numberOfPages)
      if (active) captureCover()
    },
    [file.id, initialPage, report, active, captureCover],
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
    // The capture target. Wrapping the Pdf view rather than the whole screen so
    // the cover is the page itself, with no reader chrome baked into it.
    <View ref={pdfViewRef} collapsable={false} style={[styles.fill, { backgroundColor: theme.gutter }]}>
      <AnimatedPdf
        /*
         * Memoised, and this is not cosmetic.
         *
         * `source` was an inline object literal, so it was a new reference on
         * every render of this component — and this component re-renders on
         * every seek, because `targetPage` is state. A native view that
         * re-examines its source prop on each of those is being handed a fresh
         * "open this document" descriptor mid-seek, which is the worst possible
         * moment for it.
         *
         * The URI is a pure function of the file, so the object only needs to
         * change when the file does.
         */
        source={source}
        page={targetPage}
        onLoadComplete={handleLoadComplete}
        onPageChanged={handlePageChanged}
        // Hoisted for the same reason: an inline arrow is a new prop identity
        // on every render, and these are handed to a native view.
        onScaleChanged={handleScaleChanged}
        onError={handleError}
        minScale={1}
        maxScale={5}
        // Continuous vertical scroll through the whole document, the way Drive
        // and every other reader behaves — not one page at a time.
        horizontal={false}
        enablePaging={false}
        enableAnnotationRendering
        // Fit width so text fills the screen and only needs vertical scrolling.
        fitPolicy={2}
        // A wide gap against the gutter colour is what makes each page read as
        // a separate sheet, the way Drive shows a document.
        spacing={14}
        trustAllCerts={false}
        renderActivityIndicator={renderSpinner}
        style={[
          styles.fill,
          { backgroundColor: theme.gutter },
          // Keeps the document clear of the status bar and gesture area, and
          // collapses to zero in fullscreen.
          insetStyle,
        ]}
      />

      {/*
        A PDF that has been opened before carries a captured page-1 cover, so
        this is a blurred first page rather than a grey field — the closest the
        app gets to Drive's "the document is already arriving".
      */}
      {!ready && active && <LoadingCover theme={theme} thumbhash={file.thumbhash} />}
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, width: '100%' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 8 },
  errTitle: { fontSize: 16, fontWeight: '600' },
  errBody: { fontSize: 13, textAlign: 'center' },
})
