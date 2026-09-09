import { useCallback, useEffect, useRef, useState } from 'react'
import { InteractionManager, StyleSheet, View } from 'react-native'
import Pdf from 'react-native-pdf'

import type { FileEntry } from '../types'
import { fileUri } from '../storage/paths'
import { captureFirstPage, hasAttemptedThumbnail } from '../storage/thumbs'
import { useLibrary } from '../store/library'

/**
 * Renders page one of PDFs that have no cover yet, off-screen, so the board
 * shows real thumbnails instead of coloured badges.
 *
 * ## Why this exists separately from `PdfRenderer`
 *
 * A PDF page is *rendered*, not stored — unlike an EPUB cover or a comic's
 * first frame, there is no image inside the file to extract, so the only way to
 * get one is to rasterise it with the native view. `PdfRenderer` already does
 * that, and captures a cover the first time a document is opened.
 *
 * That leaves the board's first impression backwards: a PDF shows a badge until
 * you have read it, so the files you have *not* got to — exactly the ones you
 * are scanning the board for — are the ones with no picture. Drive shows page
 * one of everything, immediately.
 *
 * ## Why a mounted component rather than a function
 *
 * `captureRef` photographs a **live native view**. There is no headless path:
 * something has to be in the tree, laid out, and given a moment for pdfium to
 * paint before the pixels exist. So this mounts one `Pdf` at a time, off-screen,
 * works through a queue, and unmounts when the queue is empty.
 *
 * ## Why one at a time
 *
 * Every previous attempt to hold several pdfium documents open at once has
 * ended badly — three live documents crashed inside `FPDF_LoadPage` when one
 * was unmounted mid-render, which is why the pager mounts a single file. This
 * keeps that invariant: exactly one document here, and it is unmounted only
 * after its capture has resolved.
 *
 * ## Why it is positioned off-screen rather than hidden
 *
 * `display: none`, zero size and `opacity: 0` all produce a view with nothing
 * to photograph — `captureRef` returns a blank or fails outright. It has to be
 * really laid out at a real size, just somewhere the user cannot see, which is
 * what the negative offset below does. `collapsable={false}` is required for
 * the same reason it is in `PdfRenderer`: Android flattens view hierarchies,
 * and a collapsed view has no native handle to capture.
 */

/** Matches the card, so the captured page is downscaled once rather than twice. */
const CAPTURE_WIDTH = 320
const CAPTURE_HEIGHT = 420

/**
 * How long to let pdfium paint before photographing.
 *
 * There is no "the page is on screen" callback — `onLoadComplete` fires when
 * the document is parsed, not when pixels have landed — so this is the same
 * empirical settle `PdfRenderer` uses, kept in step with it deliberately.
 */
const SETTLE_MS = 400

/**
 * Covers rasterised per session.
 *
 * 40 is roughly five screens of board — comfortably more than a user scrolls
 * through in one sitting without opening anything, and far less than a library.
 *
 * The bound exists because the work is unbounded and *sequential*: at
 * `SETTLE_MS` per capture plus pdfium's own parse, 3,000 uncovered PDFs is over
 * twenty minutes of continuous native rasterising, competing with the scrolling
 * the user is doing, for covers they may never scroll to. Un-capped it does not
 * stop until the library is exhausted or the app dies.
 *
 * Per session rather than persistent: the ids that were not reached are still
 * in `pdfsNeedingCovers` next launch, so a large library fills in over several
 * sittings, prioritised each time by what the user is actually looking at. A
 * persistent cap would instead mean some files are never covered at all.
 *
 * Deliberately not a time budget. A cap in seconds would produce a different
 * number of covers on every device, which makes "did the factory finish" an
 * unanswerable question when a cover is missing.
 */
const MAX_PER_SESSION = 40

interface Props {
  /**
   * Ids of PDFs with no cover yet, from `usePdfsNeedingCovers`.
   *
   * Ids rather than entries so that this component's own `setThumb` calls do
   * not change the prop that drives it — the list simply gets shorter.
   */
  fileIds: string[]
  /** False while the reader is open, so this never competes with a live document. */
  enabled: boolean
  /**
   * Ids of the groups currently on screen, newest first, read on demand.
   *
   * A function reading a ref rather than a prop: this changes on every scroll
   * settle, and as a prop it would re-render the factory — and through it the
   * board — for information only consulted when a capture slot opens. The
   * factory is the one component that must never cost anything while scrolling.
   */
  visibleGroups: () => ReadonlySet<string>
}

export function PdfCoverFactory({ fileIds, enabled, visibleGroups }: Props) {
  const [target, setTarget] = useState<FileEntry | null>(null)
  const viewRef = useRef<View>(null)
  const busy = useRef(false)

  /*
   * Ids this mount has already tried, so a failure is not retried in a loop.
   *
   * `thumbs` keeps its own session-wide set for the same purpose and this
   * consults it — but a *local* record is still needed, because a file whose
   * capture failed keeps its id in `fileIds` (it still has no cover), and
   * without this it would be picked again on the very next render.
   */
  const tried = useRef<Set<string>>(new Set())

  /** Captures completed or attempted this session, against `MAX_PER_SESSION`. */
  const made = useRef(0)

  const pickNext = useCallback((): FileEntry | null => {
    if (made.current >= MAX_PER_SESSION) return null

    const { filesById } = useLibrary.getState()
    const visible = visibleGroups()

    /*
     * Two passes: what the user is looking at, then everything else.
     *
     * The cover on screen is worth a hundred that are not — the user is
     * scanning the board *now*, and a cover that arrives after they have
     * scrolled past has served nobody. A single ordered pass cannot express
     * that, because `fileIds` is in library order and has no idea where the
     * viewport is.
     *
     * The second pass is what keeps the cap meaningful: with only the first,
     * a user who never scrolls would cover one screen and stop, and the
     * remaining budget would go unspent for a library that needs it.
     */
    let fallback: FileEntry | null = null

    for (const id of fileIds) {
      if (tried.current.has(id)) continue
      if (hasAttemptedThumbnail(id)) continue
      const file = filesById[id]
      // The entry is read here rather than passed in, so this component never
      // subscribes to file *metadata* — only to which ids still need a cover.
      if (!file || file.format !== 'pdf' || file.thumb) continue

      if (visible.has(file.groupId)) return file
      // Remembered rather than returned, so a later on-screen candidate still wins.
      if (!fallback) fallback = file
    }

    return fallback
  }, [fileIds, visibleGroups])

  // Start the queue when there is something to do and nothing in flight.
  useEffect(() => {
    if (!enabled || busy.current || target) return

    const next = pickNext()
    if (!next) return

    /*
     * Deferred until the board has settled.
     *
     * Mounting a PDF and rasterising a page is real work on the native side; a
     * cover is worth nothing if producing it janks the scroll the user is
     * doing right now.
     */
    const handle = InteractionManager.runAfterInteractions(() => {
      busy.current = true
      tried.current.add(next.id)
      // Counted on attempt, not on success: a PDF that will not rasterise costs
      // the same pdfium parse as one that will, and counting only successes
      // would let a library of broken files run the factory all session.
      made.current += 1
      setTarget(next)
    })

    return () => handle.cancel()
  }, [enabled, target, pickNext])

  // Abandon the in-flight capture if the reader opens.
  useEffect(() => {
    if (!enabled && target) {
      setTarget(null)
      busy.current = false
    }
  }, [enabled, target])

  const handleLoaded = useCallback(() => {
    const file = target
    if (!file) return

    void (async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
        if (!viewRef.current) return

        // Deferred import for the reason documented in `PdfRenderer`: a JS
        // bundle can outrun the native binary, and an eager import of a native
        // module would take the whole renderer tree down rather than one cover.
        const { captureRef } = await import('react-native-view-shot')

        const shot = await captureRef(viewRef, {
          format: 'jpg',
          quality: 0.8,
          result: 'tmpfile',
        })

        const result = await captureFirstPage(file, shot)
        if (result) useLibrary.getState().setThumb(file.id, result.thumb, result.thumbhash)
      } catch {
        // A cover is a nicety. A PDF that will not rasterise keeps its badge.
      } finally {
        // Unmount before releasing the slot, so two documents are never live.
        setTarget(null)
        busy.current = false
      }
    })()
  }, [target])

  const handleError = useCallback(() => {
    setTarget(null)
    busy.current = false
  }, [])

  if (!target) return null

  return (
    <View style={styles.stage} pointerEvents="none" collapsable={false}>
      <View ref={viewRef} collapsable={false} style={styles.page}>
        <Pdf
          source={{ uri: fileUri(target.storedName), cache: false }}
          page={1}
          singlePage
          // No spinner and no interaction: nothing here is ever seen.
          renderActivityIndicator={() => <View />}
          enablePaging={false}
          scale={1}
          onLoadComplete={handleLoaded}
          onError={handleError}
          style={styles.page}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  /*
   * Laid out for real, just outside the screen.
   *
   * A zero-sized, hidden or transparent view has no pixels for `captureRef` to
   * photograph, so it must genuinely occupy space — it simply must not occupy
   * space anyone can see.
   */
  stage: {
    position: 'absolute',
    left: -10_000,
    top: 0,
    width: CAPTURE_WIDTH,
    height: CAPTURE_HEIGHT,
    opacity: 1,
  },
  page: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT, backgroundColor: '#fff' },
})
