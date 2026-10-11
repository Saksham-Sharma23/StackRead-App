import { useEffect } from 'react'
import { Alert, AppState } from 'react-native'

import { flushLibrarySave, onSaveHealthChange } from '../storage/library'
import { clearPrepared } from '../renderers/webview/prepareCache'
import { releaseAllArchives } from '../renderers/webview/offload'

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
       * Pending removals are deliberately **not** committed here
       * ([AUDIT4 E4](../../AUDIT4.md)).
       *
       * They used to be, on the reasoning that a kill in the background would
       * otherwise lose them. It does not: every queued removal is already in
       * the MMKV marker, and `resumeInterrupted` finishes it on the next launch
       * — with the file hidden from the first frame. Committing here bought
       * nothing and cost the undo, because opening the system file picker or
       * the share sheet backgrounds the app: "delete, then tap Add files" threw
       * away the five seconds the user had to change their mind. The undo
       * timers keep running, so a removal still commits on schedule.
       *
       * The flush stays. Pending files are still in the library until they
       * commit, so the index it writes is the correct one either way.
       */
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

  /*
   * Say so, once, when the library stops saving ([AUDIT4 C1](../../AUDIT4.md)).
   *
   * Saving used to fail silently: the library looked right in memory all
   * session, and everything since the last good save was gone on the next
   * launch. Once per session, because a dialog per failed debounce would be
   * unusable; the save keeps retrying underneath either way, and a recovery is
   * silent.
   */
  useEffect(() => {
    let warned = false
    return onSaveHealthChange((failing) => {
      if (!failing || warned) return
      warned = true
      Alert.alert(
        'Changes aren’t being saved',
        'StackRead couldn’t save your library. It will keep trying. Back up your library from the ⋯ menu to be safe, and restart the app if this continues.',
      )
    })
  }, [])
}
