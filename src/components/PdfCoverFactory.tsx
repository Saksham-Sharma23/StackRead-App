import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { InteractionManager, StyleSheet, View, useWindowDimensions } from 'react-native'
import Pdf from 'react-native-pdf'

import type { FileEntry } from '../types'
import { fileUri } from '../storage/paths'
import {
  beginThumbnailAttempt,
  captureFirstPage,
  endThumbnailAttempt,
  hasAttemptedThumbnail,
  markThumbnailFailed,
} from '../storage/thumbs'
import { acquirePdfium, type PdfiumLease } from '../storage/pdfiumLease'
import { savePreview } from '../storage/pdfPreview'
import { useTheme } from '../ui/theme'
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

/*
 * The stage is the size of the window, not of a card.
 *
 * It used to be 320×420, which made a card cover and nothing else. At window
 * size, laid out exactly as the reader lays a PDF out — fit to width, page 1 at
 * the top, the same spacing and gutter — the one capture is two things: the
 * card cover (cropped to the page, then downscaled) and the instant-open
 * preview the reader shows the moment the file is tapped
 * (`storage/pdfPreview`). Most PDFs are opened first at page 1, so most first
 * opens are now instant too, not only reopens.
 */

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

/**
 * How long a capture may run before the factory gives it up.
 *
 * The one place this unmounts a document it has not seen finish, and it exists
 * only so a PDF that never reports either outcome cannot hold the pdfium lease
 * — and with it the reader's own PDF — forever. Far longer than any real parse.
 */
const ABANDON_MS = 10_000

/*
 * Session-wide bookkeeping, at module scope ([AUDIT4 A12](../../AUDIT4.md)).
 *
 * These were `useRef`s, so they reset whenever the board remounted — every
 * return from the reader. "40 per session" was "40 per visit to the board", and
 * a PDF whose capture failed was attempted again on every return. The factory
 * now lives at the app root and mounts once, but module scope states the intent
 * whatever its host does.
 */

/** Ids attempted this session, so a failure is not retried in a loop. */
const tried = new Set<string>()

/** Captures completed or attempted this session, against `MAX_PER_SESSION`. */
let made = 0

interface Props {
  /**
   * Ids of PDFs with no cover yet, from `usePdfsNeedingCovers`.
   *
   * Ids rather than entries so that this component's own `setThumb` calls do
   * not change the prop that drives it — the list simply gets shorter.
   */
  fileIds: string[]
  /**
   * False while the reader is open, the library is reloading or the board is
   * busy. Turning it off **drains** a capture in flight rather than aborting
   * it: the document is left to finish loading, the capture is skipped, and
   * only then is it unmounted.
   */
  enabled: boolean
  /**
   * Ids of the groups currently on screen, read on demand.
   *
   * A function rather than a prop: this changes on every scroll settle, and as
   * a prop it would re-render the factory for information only consulted when
   * a capture slot opens.
   */
  visibleGroups: () => ReadonlySet<string>
}

type Outcome = 'done' | 'failed' | 'abandoned'

export function PdfCoverFactory({ fileIds, enabled, visibleGroups }: Props) {
  const theme = useTheme()
  const window = useWindowDimensions()
  /*
   * The frame size, fixed while a capture is in flight so a rotation mid-load
   * cannot resize the document (a reload) or mislabel the preview.
   */
  const [stage, setStage] = useState({ width: window.width, height: window.height })
  const [target, setTarget] = useState<FileEntry | null>(null)
  const viewRef = useRef<View>(null)

  /** The pdfium lease for `target`'s document. Released once it has unmounted. */
  const leaseRef = useRef<PdfiumLease | null>(null)
  /** A lease request is outstanding; do not start another. */
  const requesting = useRef(false)
  /** Bumped to re-run the start effect when a request ends without a target. */
  const [tick, setTick] = useState(0)

  /** Read inside async work, which must see the current value, not its closure's. */
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const windowRef = useRef(window)
  windowRef.current = window

  /** The capture in flight should be skipped rather than taken. */
  const abandonRef = useRef(false)
  /** The current target has been finished, so a late callback must do nothing. */
  const finishedRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const pickNext = useCallback((): FileEntry | null => {
    if (made >= MAX_PER_SESSION) return null

    const { filesById } = useLibrary.getState()
    const visible = visibleGroups()

    /*
     * Two passes: what the user is looking at, then everything else.
     *
     * The cover on screen is worth a hundred that are not — the user is
     * scanning the board *now*, and a cover that arrives after they have
     * scrolled past has served nobody. The second pass is what keeps the cap
     * meaningful for a user who never scrolls.
     */
    let fallback: FileEntry | null = null

    for (const id of fileIds) {
      if (tried.has(id)) continue
      if (hasAttemptedThumbnail(id)) continue
      const file = filesById[id]
      // The entry is read here rather than passed in, so this component never
      // subscribes to file *metadata* — only to which ids still need a cover.
      if (!file || file.format !== 'pdf' || file.thumb) continue

      if (visible.has(file.groupId)) return file
      if (!fallback) fallback = file
    }

    return fallback
  }, [fileIds, visibleGroups])

  /*
   * Start the next capture: wait for the board to settle, take the lease, then
   * mount the document.
   *
   * The lease is what guarantees this document and the reader's are never live
   * together — the rule every comment in this file stated and nothing enforced.
   */
  useEffect(() => {
    if (!enabled || requesting.current || target) return

    const next = pickNext()
    if (!next) return

    let cancelled = false
    const handle = InteractionManager.runAfterInteractions(() => {
      if (cancelled) return
      requesting.current = true

      void acquirePdfium('cover').then((lease) => {
        requesting.current = false
        if (!enabledRef.current) {
          // Disabled while queued: hand the lease straight back, and look again
          // when re-enabled.
          lease.release()
          setTick((t) => t + 1)
          return
        }

        leaseRef.current = lease
        tried.add(next.id)
        // Counted on attempt, not on success: a PDF that will not rasterise
        // costs the same pdfium parse as one that will.
        made += 1
        // Durable marker: if pdfium takes the process down on this file, the
        // next launch will not try it again.
        beginThumbnailAttempt(next.id)
        abandonRef.current = false
        finishedRef.current = false
        // Taken now, at the start of the capture, and held for its duration.
        setStage({ width: windowRef.current.width, height: windowRef.current.height })
        setTarget(next)
      })
    })

    return () => {
      cancelled = true
      handle.cancel()
    }
  }, [enabled, target, pickNext, tick])

  /** Ends the current capture. Idempotent per target. */
  const finish = useCallback((file: FileEntry, outcome: Outcome) => {
    if (finishedRef.current) return
    finishedRef.current = true
    if (timerRef.current) clearTimeout(timerRef.current)

    // Only pdfium refusing the file is a durable failure. A skipped capture,
    // or one that threw in view-shot, is tried again another session.
    if (outcome === 'failed') markThumbnailFailed(file.id)
    endThumbnailAttempt(file.id)
    setTarget(null)
  }, [])

  /*
   * Release the lease only after the document has left the tree.
   *
   * An effect runs after the commit that removed the `<Pdf>`, so the next
   * holder — very possibly the reader — never overlaps this document.
   */
  useEffect(() => {
    if (target || !leaseRef.current) return
    leaseRef.current.release()
    leaseRef.current = null
  }, [target])

  // Release on unmount too, so a remounted host is never locked out.
  useEffect(
    () => () => {
      leaseRef.current?.release()
      leaseRef.current = null
    },
    [],
  )

  /*
   * Drain, don't abort.
   *
   * Disabling used to `setTarget(null)` on the spot, unmounting a document
   * mid-load — and the board's unmount did the same thing without even that.
   * Now the capture is marked to be skipped, and `handleLoaded` / `handleError`
   * unmount the document once pdfium has finished with it.
   */
  useEffect(() => {
    if (!enabled && target) abandonRef.current = true
  }, [enabled, target])

  // The backstop for a document that never reports back.
  useEffect(() => {
    if (!target) return
    timerRef.current = setTimeout(() => finish(target, 'abandoned'), ABANDON_MS)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [target, finish])

  const handleLoaded = useCallback((_pages: number, _path: string, pageSize: { width: number; height: number }) => {
    const file = target
    if (!file) return
    if (timerRef.current) clearTimeout(timerRef.current)

    void (async () => {
      let outcome: Outcome = 'abandoned'
      try {
        /*
         * Always let the first page settle, even when the capture will be
         * skipped. `onLoadComplete` means parsed, not painted: pdfium is still
         * rendering page one on its own thread, and unmounting now is exactly
         * the interruption this component exists to avoid.
         */
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
        if (abandonRef.current || !viewRef.current) return

        // Deferred import for the reason documented in `PdfRenderer`: a JS
        // bundle can outrun the native binary, and an eager import of a native
        // module would take the whole renderer tree down rather than one cover.
        const { captureRef } = await import('react-native-view-shot')

        const shot = await captureRef(viewRef, {
          format: 'jpg',
          quality: 0.85,
          result: 'tmpfile',
        })

        // Page 1's share of the frame, so the card is the page, not the gutter.
        const pageFraction =
          pageSize.width > 0
            ? Math.min(1, (stage.width * (pageSize.height / pageSize.width)) / stage.height)
            : 1

        const result = await captureFirstPage(file, shot, pageFraction)
        if (result) {
          useLibrary.getState().setThumb(file.id, result.thumb, result.thumbhash)
          outcome = 'done'
        }
        // Last: `savePreview` takes ownership of the capture and deletes it.
        savePreview(file.id, stage.width, stage.height, shot)
      } catch {
        // A cover is a nicety. A capture that threw is retried another session.
      } finally {
        finish(file, outcome)
      }
    })()
  }, [target, finish, stage])

  // pdfium could not open the file: a stable property of it, recorded durably.
  const handleError = useCallback(() => {
    if (target) finish(target, 'failed')
  }, [target, finish])

  /*
   * Memoised: in `react-native-pdf` every prop change is a full document
   * reload (see `PdfRenderer`), so nothing handed to the view may be rebuilt
   * per render.
   */
  const source = useMemo(
    () => (target ? { uri: fileUri(target.storedName), cache: false } : null),
    [target],
  )
  const renderNothing = useCallback(() => <View />, [])
  const frame = useMemo(
    () => ({ width: stage.width, height: stage.height, backgroundColor: theme.gutter }),
    [stage.width, stage.height, theme.gutter],
  )

  if (!target || !source) return null

  return (
    <View style={[styles.stage, frame]} pointerEvents="none" collapsable={false}>
      <View ref={viewRef} collapsable={false} style={frame}>
        {/*
          The reader's own layout, prop for prop: fit to width, the same
          spacing, the same gutter, full window — so this frame is the frame
          the reader will show (`PdfRenderer`). Not `singlePage`: the reader
          shows the top of page 2 under a short page 1, and so must this.
        */}
        <Pdf
          source={source}
          page={1}
          horizontal={false}
          enablePaging={false}
          enableAnnotationRendering
          fitPolicy={0}
          spacing={14}
          // No spinner and no interaction: nothing here is ever seen.
          renderActivityIndicator={renderNothing}
          onLoadComplete={handleLoaded}
          onError={handleError}
          style={frame}
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
  // Sized at render time to the window — see the note at the top of the file.
  stage: {
    position: 'absolute',
    left: -10_000,
    top: 0,
    opacity: 1,
  },
})
