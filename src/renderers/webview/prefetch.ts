import { InteractionManager } from 'react-native'
import { File } from 'expo-file-system'

import type { FileEntry } from '../../types'
import { LIBRARY_DIR } from '../../storage/paths'
import { isWebViewFormat } from '../types'
import { prepareFile } from './prepare'
import { hasPrepared, setPrepared, setPinned } from './prepareCache'
import { writePrepared } from './diskCache'

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
 *  - A module-level `busy` flag serialises the work: at most one parse is ever
 *    in flight, app-wide.
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
 * Serialises prefetching: at most one background parse in flight.
 *
 * Note what this does and does not cover now that parsing genuinely yields
 * (see `offload.ts`). It serialises *prefetches* against each other, which is
 * what stops a fast swipe through a group queuing a backlog of parses. It does
 * not block a parse the user actually asked for: opening a file goes through
 * `WebViewRenderer`, which does not consult this flag, so a prefetch and a real
 * open can overlap.
 *
 * That overlap is safe and deliberate, and it is now genuinely concurrent:
 * prefetches run on their own worklet runtime (`offload.ts`), so a speculative
 * parse cannot queue ahead of a file the user actually opened. Previously both
 * shared one runtime that processes in order, which meant this module's promise
 * — never block the user's open — held at this level and was broken one level
 * down.
 */
let busy = false

/**
 * Generation counter, bumped whenever the target changes.
 *
 * A prefetch that was queued for the previous file must not consume the slot
 * once the user has moved on — otherwise a fast swipe through a group leaves a
 * backlog of parses for files nobody is looking at any more.
 */
let generation = 0

/** Files that failed to prepare, so a broken file is not retried forever. */
const failed = new Set<string>()

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
      if (hasPrepared(file.id) || failed.has(file.id)) continue
      targets.push(file)
    }
  }

  if (!targets.length) return

  void InteractionManager.runAfterInteractions(async () => {
    for (const file of targets) {
      // Abandon the moment the user moves, or another prefetch takes the slot.
      if (mine !== generation || busy) return
      // Re-check: the user may have visited this file while we waited, which
      // caches it through the normal path.
      if (hasPrepared(file.id)) continue

      busy = true
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
        const prepared = await prepareFile(file, 'prefetch')
        // Cached even if the generation moved on: the work is already paid for,
        // and the result is just as valid for whenever the user arrives.
        setPrepared(file.id, prepared)
        // Persisted too, so the work survives the next backgrounding rather
        // than being thrown away with the memory cache.
        writePrepared(file.id, new File(LIBRARY_DIR, file.storedName), prepared)
      } catch {
        // A file that cannot be prepared is remembered as such rather than
        // retried on every page turn. Opening it directly still surfaces the
        // real error through the renderer.
        failed.add(file.id)
      } finally {
        busy = false
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
  setPinned([])
}

/**
 * Forgets that one file failed to prepare, so it is tried again.
 *
 * The memo exists so a broken file is not reparsed on every page turn. That is
 * right while the bytes stay the same — and wrong the moment they do not, which
 * is exactly what removing and re-importing a file, or restoring a backup over
 * it, does. Both reuse ids.
 */
export function forgetPrefetchFailure(fileId: string): void {
  failed.delete(fileId)
}

/** Clears the failure memo, so a re-imported file gets another chance. */
export function resetPrefetchFailures(): void {
  failed.clear()
}
