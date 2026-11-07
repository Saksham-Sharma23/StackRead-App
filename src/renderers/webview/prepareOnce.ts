import { File } from 'expo-file-system'

import type { FileEntry } from '../../types'
import { LIBRARY_DIR } from '../../storage/paths'
import { prepareFile, type Prepared } from './prepare'
import { setPrepared } from './prepareCache'
import { writePrepared } from './diskCache'
import { preparing } from './inflight'
import type { OffloadLane } from './offload'

/**
 * Prepares a file at most once at a time, and caches the result.
 *
 * The one entry point for both callers that parse: the renderer opening a file
 * and the prefetch warming its neighbours. Whichever asks first starts the
 * parse, on its own lane; the other joins it ([inflight.ts](inflight.ts)).
 *
 * Cached here rather than by each caller, so the result is stored and written
 * to disk once — and **only if the run is still current**. A file removed or
 * replaced by a restore while it was parsing must not have the old parse cached
 * under its id; the renderer that asked still gets it, which is harmless for
 * the moment it is on screen.
 *
 * Cached before the caller sees it, deliberately: a renderer that was swiped
 * away mid-parse discards the result, and the next visit should still be a hit.
 */
export function prepareAndCache(file: FileEntry, lane: OffloadLane): Promise<Prepared> {
  return preparing.run(file.id, async (stillCurrent) => {
    const prepared = await prepareFile(file, lane)
    if (stillCurrent()) {
      setPrepared(file.id, prepared)
      // The memory cache is dropped on backgrounding; this survives it.
      // `writePrepared` declines documents that cannot be persisted.
      writePrepared(file.id, new File(LIBRARY_DIR, file.storedName), prepared)
    }
    return prepared
  })
}
