import { InteractionManager } from 'react-native'

import type { FileEntry } from '../../types'
import { isWebViewFormat } from '../types'
import { hasPrepared, setPinned } from './prepareCache'
import { preparing } from './inflight'
import { prepareAndCache } from './prepareOnce'
import { createLatestQueue } from './latestQueue'
import { hasPrefetchFailed, notePrefetchFailure } from './prefetchState'

/**
 * Warms the prepared-document cache for files near the one being read.
 *
 * ## Why this is not "mount the neighbours"
 *
 * Mounting neighbouring renderers is the obvious version of this idea and it is
 * the thing that had to be removed: three live pdfium documents crashed inside
 * `FPDF_LoadPage` when one was unmounted mid-render, and three EPUB renderers
 * parsed three whole books at once. This warms the *cache* instead. No renderer
 * is mounted, no native view exists, no WebView is created — the result is a
 * string sitting in a Map, and the pager still mounts exactly one file.
 *
 * ## Why one at a time, and only when idle
 *
 * Parsing an EPUB is seconds of synchronous-ish work: unzip, assemble every
 * chapter, base64-encode every image. Running two at once is what made the app
 * hang when an EPUB was merely *near* the current file, and running one during
 * a swipe animation is what drops frames. So:
 *
 *  - `InteractionManager.runAfterInteractions` defers until animations settle,
 *    so a prefetch never competes with the swipe that triggered it.
 *  - A one-at-a-time queue serialises the work: at most one prefetch parse is
 *    ever in flight, and the newest request runs when it ends.
 *  - Each step re-checks whether its target is still wanted, so changing files
 *    mid-prefetch abandons the old queue instead of finishing it.
 *
 * The net effect is that reading a file quietly prepares its neighbours during
 * the seconds you spend on the page, and the cache turns the next swipe into a
 * synchronous hit.
 */

/**
 * How far either side of the active file to warm.
 *
 * One is deliberate. Two would triple the memory a single group can pin and
 * mostly warm files the reader will never reach — people move through a group a
 * page at a time, not by teleporting four files ahead. The cache's byte budget
 * would evict the far ones anyway, so the extra parses would be pure cost.
 */
const RADIUS = 1

/**
 * Serialises prefetching: at most one background parse in flight, and the
 * newest request runs as soon as the current parse ends.
 *
 * This was a `busy` flag, and a request that found it set returned for good —
 * so after a fast swipe the new neighbours were never warmed, and the next
 * swipe re-parsed in front of the user. The queue keeps the flag's guarantee
 * (no two speculative parses at once, no backlog for files swiped past) and
 * runs the latest request instead of dropping it. See `latestQueue.ts`.
 *
 * It does not block a parse the user actually asked for: opening a file goes
 * through `WebViewRenderer`, which joins a prefetch already parsing that file
 * (`prepareOnce.ts`) and otherwise parses on its own worklet runtime
 * (`offload.ts`), so a speculative parse never queues ahead of a real open.
 */
const queue = createLatestQueue()

/**
 * Generation counter, bumped whenever the target changes.
 *
 * A prefetch that was queued for the previous file must not consume the slot
 * once the user has moved on — otherwise a fast swipe through a group leaves a
 * backlog of parses for files nobody is looking at any more.
 */
let generation = 0

// The failure memo lives in `prefetchState.ts`, which imports nothing — see
// there for why it cannot live here.

/**
 * Queues background preparation of the files around `index` in `files`.
 *
 * Safe to call on every page turn: it is cheap when everything nearby is
 * already cached, and it cancels any older queue.
 */
export function prefetchAround(files: FileEntry[], index: number): void {
  generation += 1
  const mine = generation

  /*
   * Pin the window before doing any work.
   *
   * This is what makes the neighbours stay resident: without it they are the
   * least recently used entries in the cache the moment they finish preparing,
   * so the next insert evicts them and the "instant" swipe reparses anyway.
   * Set synchronously, ahead of the deferred parse, so the pins are already in
   * place when results start landing.
   */
  setPinned(
    [files[index - 1], files[index], files[index + 1]]
      .filter((f): f is FileEntry => Boolean(f))
      .map((f) => f.id),
  )

  // Nearest-first, so the file one swipe away is ready before the one two away.
  const targets: FileEntry[] = []
  for (let d = 1; d <= RADIUS; d++) {
    for (const i of [index + d, index - d]) {
      const file = files[i]
      if (!file) continue
      // PDFs and images are drawn natively from disk, so there is no prepared
      // string for them to cache and nothing for a prefetch to do.
      if (!isWebViewFormat(file.format)) continue
      // Already being parsed — usually because the user opened it — needs no second run.
      if (hasPrepared(file.id) || preparing.has(file.id) || hasPrefetchFailed(file.id)) continue
      targets.push(file)
    }
  }

  if (!targets.length) return

  queue.schedule(async () => {
    // Behind any animation in progress, so a prefetch never competes with the
    // swipe that triggered it.
    await new Promise<void>((resolve) => {
      void InteractionManager.runAfterInteractions(() => resolve())
    })

    for (const file of targets) {
      // Abandon the moment the user moves: the newer request is waiting in the
      // queue and starts as soon as this returns.
      if (mine !== generation) return
      // Re-check: the user may have visited this file while we waited, which
      // caches it through the normal path.
      if (hasPrepared(file.id) || preparing.has(file.id)) continue

      try {
        /*
         * On the prefetch runtime, not the user's.
         *
         * Both are awaited and neither shares state, so this was always safe —
         * but a single runtime processes in order, so a 30MB comic being warmed
         * here would queue a file the user actually opened behind it. That is
         * the head-of-line blocking the `busy` flag above never covered,
         * because the contention was one level down.
         */
        /*
         * Cached and persisted by `prepareAndCache`, even if the generation
         * moved on: the work is already paid for, and the result is just as
         * valid for whenever the user arrives. A user who opens this file
         * meanwhile joins this run instead of starting a second parse.
         */
        await prepareAndCache(file, 'prefetch')
      } catch {
        // A file that cannot be prepared is remembered as such rather than
        // retried on every page turn. Opening it directly still surfaces the
        // real error through the renderer.
        notePrefetchFailure(file.id)
      }
    }
  })
}

/**
 * Stops any queued prefetching — call when leaving the reader.
 *
 * Clearing the pins is not housekeeping, it is the whole point of the second
 * line. Pinned entries are deliberately **exempt from the tail budget**
 * (`prepareCache.ts`), because the pinned window is a guarantee rather than an
 * optimisation. That exemption is only safe while something is responsible for
 * releasing it: without this, leaving the reader left up to three documents —
 * potentially tens of megabytes — permanently un-evictable, since nothing else
 * ever calls `setPinned` once the reader has closed.
 *
 * They are not discarded, only demoted. Each becomes an ordinary tail entry and
 * survives until the budget needs its bytes, so reopening the file you just
 * closed is still a cache hit.
 */
export function cancelPrefetch(): void {
  generation += 1
  // A request still waiting would only check the generation and return.
  queue.cancel()
  setPinned([])
}

// `forgetPrefetchFailure` and `resetPrefetchFailures` moved to `prefetchState.ts`.
