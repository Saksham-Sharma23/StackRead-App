import { useEffect } from 'react'
import { AppState } from 'react-native'

import { flushLibrarySave } from '../storage/library'
import { clearPrepared } from '../renderers/webview/prepareCache'
import { releaseAllArchives } from '../renderers/webview/offload'
import { usePendingRemoval } from '../store/pendingRemoval'

/**
 * Process-level shutdown handling.
 *
 * ## Why this is at the root and not in a screen
 *
 * This logic used to live in `LibraryScreen`, and that was a real data-loss
 * bug rather than an untidy placement. `App.tsx` swaps between the library and
 * the reader conditionally, so while a file is open `LibraryScreen` is
 * *unmounted* and its listener removed with it — meaning the single most common
 * way a phone app dies, "open a file, press Home, the OS reclaims the process",
 * ran none of the shutdown path:
 *
 *  - a debounced index write inside its 400ms window was lost;
 *  - a removal inside its 5-second undo window never committed, so the file the
 *    user deleted quietly came back;
 *  - the parsed-document cache stayed resident, which is actively harmful — a
 *    backgrounded app holding tens of megabytes is what Android chooses first
 *    when it reclaims memory, so keeping it *raised* the chance of being killed.
 *
 * Mounted in `Root()` above the screen swap, this lives for the life of the
 * process, which is the only scope that matches what it protects.
 *
 * ## Why `inactive` counts as backgrounding
 *
 * On Android `inactive` is a brief transitional state, and treating it as a
 * shutdown means an occasional redundant flush. That is the right trade: a
 * redundant `File.write` costs a millisecond, while a missed one costs the
 * user's reading position. Both operations are idempotent.
 *
 * ## Scope
 *
 * Deliberately narrow — this is the "we might not run again" path, not a place
 * for general app coordination. `resumeInterrupted()` is its counterpart on
 * startup and stays in `LibraryScreen`, gated on `loaded`, because it needs the
 * library in memory to act on.
 */
export function useAppLifecycle(): void {
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'background' && next !== 'inactive') return

      /*
       * Order matters. `commitAll` mutates the library — it drops removed
       * entries from the index — so it has to run before the index is written,
       * or the flush persists a library that still contains files the user
       * deleted and the removal is lost.
       */
      usePendingRemoval.getState().commitAll()
      flushLibrarySave()

      // Reparsing on return costs a second; being killed loses the user's
      // place. Dropping the cache is the cheaper side of that trade.
      clearPrepared()
      // Same trade for the archives parked on the worker runtimes: whole books
      // in native memory. A reader still open re-parks its book from disk the
      // next time it needs a chapter.
      releaseAllArchives()
    })

    return () => sub.remove()
  }, [])
}
