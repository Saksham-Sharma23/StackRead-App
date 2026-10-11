import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import * as SplashScreen from 'expo-splash-screen'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ReducedMotionConfig, ReduceMotion } from 'react-native-reanimated'

import type { FileEntry } from './src/types'
import { LibraryScreen } from './src/screens/LibraryScreen'
import { ReaderTransition } from './src/components/ReaderTransition'
import type { OpenRect } from './src/ui/openTransition'
import { useLibrary } from './src/store/library'
import { useTheme } from './src/ui/theme'
import { useAppLifecycle } from './src/ui/useAppLifecycle'
import { perf, reportStartup } from './src/ui/perf'
import { installCrashLog } from './src/ui/crashLog'
import { ErrorBoundary } from './src/components/ErrorBoundary'
import { PdfCoverFactory } from './src/components/PdfCoverFactory'
import { usePdfsNeedingCovers } from './src/store/selectors'
import { getVisibleGroups, useBoardActivity } from './src/store/boardActivity'
import { whenPdfiumSettled } from './src/storage/pdfiumLease'
import { useIncomingFiles } from './src/ui/useIncomingFiles'

/*
 * Record fatal JS errors before React Native's default handler ends the
 * process, and report the previous session's on this launch
 * ([AUDIT4 A10](AUDIT4.md)). Module scope, so it is in place before the first
 * render can throw.
 */
installCrashLog()

/**
 * How long a closing reader is kept mounted, invisibly, while a PDF finishes
 * loading.
 *
 * Tearing pdfium down mid-load is the crash class DETAIL.md §8 records. The
 * reader has already faded out by the time this applies, so the wait is
 * invisible except as a slightly later board. A backstop, not a target: a PDF
 * that never reports back must not leave the reader unclosable.
 */
const PDF_CLOSE_GRACE_MS = 2000

/**
 * The reader, loaded on first open rather than at startup.
 *
 * Its subtree is the heaviest thing in the app and none of it is needed to
 * paint the board: `react-native-pdf`, the WebView host, the viewer's
 * 1,500-line template literal, the EPUB unpacker, pagination, the sanitiser.
 * All of that was evaluated during launch because this file imported the screen
 * statically, and Expo SDK 57's Metro config disables `inlineRequires`, so
 * nothing deferred it.
 *
 * `ReaderTransition` stays eager — it imports no renderers, and it is what
 * paints over the moment this chunk loads.
 */
const ReaderScreen = lazy(() => import('./src/screens/ReaderScreen'))

/*
 * Hold the native splash until the library has actually loaded.
 *
 * Without this the splash hides as soon as the first React frame commits,
 * which is before `useLibrary.load()` has read the index — so the app shows a
 * blank board for a moment and then pops the rows in. Holding it means the
 * logo stays up for exactly as long as there is nothing to show.
 *
 * Called at module scope because it has to run before the first frame; inside
 * a component it would already be too late on a fast device.
 */
SplashScreen.preventAutoHideAsync().catch(() => {
  /*
   * Never fatal.
   *
   * This rejects when there is no splash to hold — the dev client after a
   * fast refresh, for instance, where the native module has already released
   * it. The app must still start, so the failure is swallowed rather than
   * propagated: the only consequence is that the splash was not held.
   */
})

/**
 * P1–P4: storage, the 2-D board, the reader and its horizontal pager.
 *
 * Navigation is a single conditional swap rather than a nav library: there are
 * exactly two destinations and the reader is a full-screen takeover, so a stack
 * would add a dependency without buying anything. The reader owns the Android
 * back button while it is open.
 */

function Root() {
  const theme = useTheme()
  const [reading, setReading] = useState<FileEntry | null>(null)

  /*
   * Hide the splash once the library is loaded, not on mount.
   *
   * `loaded` is the store's own flag, so this tracks the thing the reader is
   * actually waiting for rather than a timer. It is a plain boolean selector,
   * which returns a stable primitive — the allocating-selector trap documented
   * in `store/selectors.ts` does not apply here.
   */
  const loaded = useLibrary((s) => s.loaded)

  useEffect(() => {
    if (!loaded) return
    // The splash coming down is the first moment there is anything to look at,
    // so it is where the startup line is complete and worth emitting.
    reportStartup()
    void SplashScreen.hideAsync().catch(() => {})
  }, [loaded])

  /*
   * Hide the splash regardless after a few seconds.
   *
   * `load()` has no rejection path of its own, so a throw inside it leaves
   * `loaded` false forever — and gating the splash on that flag alone would
   * turn a recoverable index read error into a launch screen that never goes
   * away, with no way out but force-quitting. The board renders an empty
   * library perfectly well, so showing it is strictly better than showing a
   * logo that never leaves.
   */
  useEffect(() => {
    /*
     * Disarmed once the library has loaded.
     *
     * Without the guard the timer stayed armed after the effect above had
     * already hidden the splash, and fired a redundant second `hideAsync` four
     * seconds into the session. Harmless in itself — the call is idempotent —
     * but it is a timer outliving its purpose, and the next reader has to work
     * out whether the second call matters.
     *
     * The failsafe itself stays. `load()` has no rejection path of its own, so
     * a throw inside it leaves `loaded` false forever, and gating the splash on
     * that flag alone would turn a recoverable index read error into a launch
     * screen that never goes away.
     */
    if (loaded) return

    const t = setTimeout(() => {
      // Reported distinctly from the ordinary path. A startup line that arrived
      // via the failsafe describes a launch where `load()` never resolved, and
      // reading it as an ordinary 4,000ms first paint would send the next
      // reader after the wrong thing entirely.
      perf('startup   FAILSAFE — the library never loaded; timings below are meaningless')
      reportStartup()
      void SplashScreen.hideAsync().catch(() => {})
    }, 4000)
    return () => clearTimeout(t)
  }, [loaded])

  /*
   * Above the screen swap below, deliberately.
   *
   * Flushing the index, committing removals and dropping the parsed-document
   * cache all used to be registered inside `LibraryScreen` — which unmounts
   * while the reader is open, so none of it ran when the process was killed
   * from a file. Mounted here it lives for the whole process, which is the only
   * scope that matches what it protects.
   */
  useAppLifecycle()

  /*
   * The tapped card's position, captured at the moment of the tap.
   *
   * A ref rather than state: nothing renders from it, and putting it in state
   * would re-render the board at exactly the moment it is being animated away
   * from. `ReaderTransition` reads it once when it mounts.
   *
   * It is deliberately *not* cleared on close. The close animation needs the
   * same rect the open used, and it is read through `rectIsUsable`, which
   * rejects a rect the board has since scrolled away from — so a stale value is
   * already handled by falling back to a plain scale-and-fade.
   */
  const openRect = useRef<OpenRect | null>(null)

  /**
   * Two-phase close: `closing` starts the fold, `reading` clears when it ends.
   *
   * The reader cannot be unmounted the instant the user asks to close, because
   * then there is nothing left to animate. So the request and the unmount are
   * separated, the same way `SheetShell` decouples its `mounted` flag from its
   * `visible` prop.
   */
  const [closing, setClosing] = useState(false)

  const handleOpenFile = useCallback((file: FileEntry, rect?: OpenRect | null) => {
    openRect.current = rect ?? null
    setClosing(false)
    setReading(file)
  }, [])

  /** Asks the reader to fold away. The unmount happens in `handleClosed`. */
  const handleClose = useCallback(() => setClosing(true), [])

  /*
   * Files from "Open with" and "Share" (`storage/incoming`), opened like a tap
   * with no card to grow from.
   *
   * If a reader is already open, it is replaced — but not until any PDF in it
   * has finished loading, the same wait a close makes ([AUDIT4 A8](AUDIT4.md)):
   * swapping the reader unmounts the old document as surely as closing does.
   */
  const readingRef = useRef(reading)
  readingRef.current = reading
  const openReceived = useCallback(
    async (file: FileEntry) => {
      const current = readingRef.current
      if (current?.id === file.id) return
      if (current) await whenPdfiumSettled(PDF_CLOSE_GRACE_MS)
      handleOpenFile(file, null)
    },
    [handleOpenFile],
  )
  const receiving = useIncomingFiles(loaded, openReceived)

  const handleClosed = useCallback(() => {
    /*
     * Not until any PDF in the reader has finished loading ([AUDIT4 A8](AUDIT4.md)).
     * Resolves at once for every other format, and for a PDF already open.
     */
    void whenPdfiumSettled(PDF_CLOSE_GRACE_MS).then(() => {
      setReading(null)
      setClosing(false)
    })
  }, [])

  /*
   * The reader threw while rendering. Close it, and say so.
   *
   * Without a boundary this took the whole app down. A file that cannot be
   * displayed should cost its own open, not the session ([AUDIT4 A10](AUDIT4.md)).
   */
  const handleReaderCrash = useCallback(() => {
    setClosing(true)
    Alert.alert(
      'Couldn’t display this file',
      'The reader ran into a problem and was closed. Your library is unaffected.',
    )
  }, [])

  return (
    <>
      <StatusBar style={reading ? 'light' : theme.dark ? 'light' : 'dark'} />
      {/*
        The board stays mounted only while there is no reader.

        Keeping both alive would let the board scale away underneath the reader,
        which is the conventional companion to this transition. It is
        deliberately not done: the cost is every card's image instance and MMKV
        subscription held alive for a whole reading session, to animate
        something that spends almost all of the transition behind an opaque
        reader.

        The trade has one consequence, and it was a visible bug before it was
        handled: with the board gone, whatever the reader does not cover is the
        Android *window* background — the splash navy — so the transition
        flashed blue at both ends. `ReaderTransition` paints its own opaque
        backdrop for exactly this reason.
      */}
      {reading ? (
        <ReaderTransition
          from={openRect.current}
          closing={closing}
          onClosed={handleClosed}
          /*
           * The app background, not transparent.
           *
           * The reader animates in from card size, so it does not cover the
           * screen for the length of the transition — and with the board
           * unmounted, anything left uncovered shows the Android window
           * background, which is the splash navy. Painting the app's own
           * background behind it is what keeps the transition from flashing
           * blue at both ends.
           */
          backdrop={theme.bg}
        >
          {/*
           * Keyed on the file id so opening a different file always gets a fresh
           * reader. ReaderScreen seeds its group and index from `initialFile` in
           * `useState` initialisers, which run once per mount — without the key,
           * React reuses the instance and the reader can open into the group the
           * previous file was in. Moving a file between groups and reopening it
           * is exactly the sequence that exposes this.
           */}
          {/*
            `fallback={null}`, not a spinner.

            `ReaderTransition` is already animating an opaque backdrop over this
            exact moment — that is what stops the transition flashing the splash
            navy — so a fallback would render *behind* it and never be seen. A
            second loading affordance during a designed transition is worse than
            none.
          */}
          <ErrorBoundary
            name="reader"
            onError={handleReaderCrash}
            // Plain page colour while the transition folds it away.
            fallback={() => <View style={[styles.fill, { backgroundColor: theme.bg }]} />}
          >
            <Suspense fallback={null}>
              <ReaderScreen key={reading.id} initialFile={reading} onClose={handleClose} />
            </Suspense>
          </ErrorBoundary>
        </ReaderTransition>
      ) : (
        <LibraryScreen onOpenFile={handleOpenFile} />
      )}

      <CoverFactoryHost reading={reading !== null} />

      {receiving !== null && (
        <View style={[styles.receiving, { backgroundColor: theme.overlay }]} pointerEvents="none">
          <ActivityIndicator color="#fff" />
          <Text style={styles.receivingText}>{receiving}</Text>
        </View>
      )}
    </>
  )
}

/**
 * The PDF cover factory, at the root ([AUDIT4 A8](AUDIT4.md)).
 *
 * It lived inside `LibraryScreen`, which is unmounted the instant a card is
 * tapped — tearing down whatever pdfium document it had half-loaded. Here it is
 * never unmounted by navigation; opening the reader only disables it, and it
 * drains its current capture instead of aborting it.
 *
 * Its own component so its subscriptions — covers landing, the board going busy
 * — re-render it alone, not `Root` and everything under it.
 */
function CoverFactoryHost({ reading }: { reading: boolean }) {
  const loaded = useLibrary((s) => s.loaded)
  const boardBusy = useBoardActivity((s) => s.busy)
  const fileIds = usePdfsNeedingCovers()

  return (
    <PdfCoverFactory
      fileIds={fileIds}
      enabled={loaded && !reading && !boardBusy}
      visibleGroups={getVisibleGroups}
    />
  )
}

/**
 * Shown when something outside the reader fails to render.
 *
 * Deliberately plain: it must not depend on the theme, the store or anything
 * else that might be what failed. "Try again" re-renders the tree from scratch,
 * which recovers from anything transient; the error itself is already logged.
 */
function RootFallback({ reset }: { reset: () => void }) {
  return (
    <View style={styles.crash}>
      <Text style={styles.crashTitle}>Something went wrong</Text>
      <Text style={styles.crashBody}>StackRead hit an unexpected error. Your library is safe.</Text>
      <Pressable onPress={reset} style={styles.crashButton} accessibilityRole="button">
        <Text style={styles.crashButtonText}>Try again</Text>
      </Pressable>
    </View>
  )
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/*
        Makes every animation in the app honour "Remove animations" in Android
        accessibility settings. Reanimated animations default to
        `ReduceMotion.System`, so with this mounted they are disabled
        automatically — no per-component code, provided a config never
        hard-codes `reduceMotion`. None of the tokens in `ui/motion` do.
      */}
      <ReducedMotionConfig mode={ReduceMotion.System} />
      <SafeAreaProvider>
        {/*
          The last line of defence: a render error anywhere outside the reader
          (which has its own boundary) shows a recoverable screen instead of
          exiting the app ([AUDIT4 A10](AUDIT4.md)).
        */}
        <ErrorBoundary name="root" fallback={(_, reset) => <RootFallback reset={reset} />}>
          <Root />
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // Matches the board's own import overlay.
  receiving: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  receivingText: { color: '#fff', fontSize: 14 },
  // The splash navy: the one colour guaranteed to match whatever was on screen.
  crash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 12,
    backgroundColor: '#0e1a3b',
  },
  crashTitle: { color: '#ffffff', fontSize: 18, fontWeight: '600' },
  crashBody: { color: '#c8cde0', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  crashButton: {
    marginTop: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#2f4a8a',
  },
  crashButtonText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
})
