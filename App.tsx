import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
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

  const handleClosed = useCallback(() => {
    setReading(null)
    setClosing(false)
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
          <Suspense fallback={null}>
            <ReaderScreen key={reading.id} initialFile={reading} onClose={handleClose} />
          </Suspense>
        </ReaderTransition>
      ) : (
        <LibraryScreen onOpenFile={handleOpenFile} />
      )}
    </>
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
        <Root />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
