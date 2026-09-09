import { InteractionManager } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import { nanoid } from 'nanoid/non-secure'

import type { FileEntry } from '../types'
import { extensionOf, formatOf, isKnownExtension } from './formats'
import { storage, LAST_PRUNE_KEY } from './mmkv'
import { LIBRARY_DIR, ensureLibraryDir, storedFile, thumbFile } from './paths'

/**
 * Import: pick files, then **copy** them into app-managed storage.
 *
 * Copying (rather than referencing the original `content://` URI) mirrors the
 * desktop app and is what makes the library self-contained: it cannot break
 * because the user moved, renamed or deleted the original, and it does not
 * depend on a SAF permission grant surviving a reboot.
 *
 * `nanoid/non-secure` is deliberate — these ids are not security-sensitive, and
 * the secure variant would drag in a crypto polyfill for no benefit.
 */

export interface ImportResult {
  entries: FileEntry[]
  /** Files the user picked whose extension we have no format for. */
  skipped: string[]
  cancelled: boolean
}

/**
 * Opens the system picker and copies every accepted file into the library.
 *
 * Note we pass a wildcard type rather than a MIME allow-list. Android picker
 * filters unevenly across vendors and a strict list silently hides files the
 * app can actually open (a `.md` served as `application/octet-stream`, say).
 * We filter by extension after the fact instead, which is predictable.
 */
export async function importFiles(groupId: string, startOrder: number): Promise<ImportResult> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    multiple: true,
    copyToCacheDirectory: true,
  })

  if (result.canceled) return { entries: [], skipped: [], cancelled: true }

  ensureLibraryDir()

  const entries: FileEntry[] = []
  const skipped: string[] = []
  let order = startOrder

  for (const asset of result.assets) {
    if (!isKnownExtension(asset.name)) {
      skipped.push(asset.name)
      continue
    }

    try {
      entries.push(copyIntoLibrary(asset.uri, asset.name, groupId, order))
      order += 1
    } catch (err) {
      console.warn(`[stackread] failed to import ${asset.name}`, err)
      skipped.push(asset.name)
    }
  }

  return { entries, skipped, cancelled: false }
}

/**
 * Copies one file into the library dir under a generated id, returning its entry.
 * The original filename is kept only as display metadata.
 */
export function copyIntoLibrary(
  sourceUri: string,
  originalName: string,
  groupId: string,
  orderInGroup: number,
): FileEntry {
  ensureLibraryDir()

  const id = nanoid(12)
  const ext = extensionOf(originalName)
  const target = storedFile(id, ext)

  new File(sourceUri).copySync(target)

  return {
    id,
    name: originalName,
    storedName: `${id}.${ext}`,
    format: formatOf(originalName),
    groupId,
    orderInGroup,
    // Read from the destination, not the source: this is the copy the library
    // owns and the only one whose size stays true.
    size: target.size ?? undefined,
    addedAt: Date.now(),
  }
}

/**
 * Size of a stored file in bytes, or undefined if it cannot be read.
 *
 * Only for entries imported before `FileEntry.size` existed — new imports carry
 * it and never reach here. Synchronous because `File.size` is a stat, and the
 * callers are render paths that cannot await; the result is cached below so a
 * list of twenty files does not stat twenty times per render.
 */
const sizeCache = new Map<string, number | undefined>()

/**
 * Bound on memoized sizes.
 *
 * 200, matching `useSnippet`'s `MAX_CACHED`: both are per-file memoizations
 * fed by the same scrolling board, so a shared number keeps their working sets
 * aligned rather than having one hold entries the other has already dropped.
 *
 * `forgetSize` and `clearSizeCache` already cover deletion and restore; this
 * covers ordinary growth, which is otherwise unbounded — one entry per file
 * ever rendered, for the life of the process.
 *
 * Oldest-first rather than least-recently-used. An LRU would need a `delete`
 * and re-`set` on every read to keep insertion order meaningful, which is real
 * work on a render path this sits on; a stale eviction here costs one `stat`.
 */
const MAX_CACHED_SIZES = 200

export function fileSize(entry: { id: string; storedName: string }): number | undefined {
  // `has` rather than a truthiness check on `get`: `undefined` is a cached
  // value here — it means "this file could not be read" — and must not be
  // mistaken for a miss, or an unreadable file re-stats on every render.
  if (sizeCache.has(entry.id)) return sizeCache.get(entry.id)

  let size: number | undefined
  try {
    size = new File(LIBRARY_DIR, entry.storedName).size ?? undefined
  } catch {
    // A missing file is not an error here — the row simply shows no size.
    size = undefined
  }

  if (sizeCache.size >= MAX_CACHED_SIZES) {
    const oldest = sizeCache.keys().next().value
    if (oldest !== undefined) sizeCache.delete(oldest)
  }
  sizeCache.set(entry.id, size)
  return size
}

/**
 * Drops one file's memoized size.
 *
 * The cache above is justified by "the library owns its copy, so the bytes
 * never change" — true for a given id, and *not* true across a restore, which
 * writes different bytes under ids the archive preserved. Without this the file
 * menu would report the previous file's size indefinitely.
 *
 * Call it through `forgetFileEverywhere` rather than directly; this exists so
 * that function has something to call.
 */
export function forgetSize(fileId: string): void {
  sizeCache.delete(fileId)
}

/** Drops every memoized size. For a restore, which invalidates all of them. */
export function clearSizeCache(): void {
  sizeCache.clear()
}

/**
 * Deletes a file's bytes and its thumbnail.
 *
 * Only called once the 5-second undo window has elapsed — until then the entry
 * is merely hidden, so an undo costs nothing and touches no disk.
 */
export function deleteFromLibrary(entry: FileEntry): void {
  try {
    const f = new File(LIBRARY_DIR, entry.storedName)
    if (f.exists) f.delete()
  } catch (err) {
    console.warn(`[stackread] failed to delete ${entry.storedName}`, err)
  }

  try {
    const t = thumbFile(entry.id)
    if (t.exists) t.delete()
  } catch {
    // A missing thumbnail is not an error.
  }
}

/**
 * How often orphan cleanup actually runs. Once a day is ample.
 *
 * The cost of skipping it is disk space that is already wasted; the cost of
 * running it is a full directory enumeration before the board can paint. That
 * asymmetry is why this is throttled rather than made faster.
 */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * Runs `pruneOrphans` at most once a day, off the startup path.
 *
 * ## Why this is deferred rather than simply called
 *
 * `pruneOrphans` enumerates the entire library directory — at 5,000 files that
 * is ~10,000 entries (files plus thumbnails) walked synchronously on the JS
 * thread, before first paint, on every single launch.
 *
 * `runAfterInteractions` moves it behind the first frames, and the timestamp
 * keeps it from repeating on every cold start. Both matter: deferring alone
 * would still pay the full cost on a device that launches the app often.
 *
 * ## Why it is not removed
 *
 * It is the safety net for a crash between "copy succeeded" and "index saved",
 * which leaves bytes on disk that no entry references. Without it the library
 * directory grows forever. Note that this routine was the *amplifier* in the
 * data-loss incident in DETAIL.md 6.3, not its cause — it behaved correctly on
 * an index that had silently failed to save. Keeping it is right; running it
 * before the app is even interactive is not.
 */
export function schedulePruneOrphans(liveEntries: () => FileEntry[]): void {
  /*
   * An empty library never prunes. This is a safety interlock, not an
   * optimization.
   *
   * "The index says there are no files" and "the index failed to load" are
   * indistinguishable here, and the second one is real: the index is a database
   * now, and a database that cannot be opened yields an empty library exactly
   * like a fresh install does. Pruning on that reading would delete every file
   * on disk because nothing referenced them — which is precisely the
   * [DETAIL.md §6.3](../../DETAIL.md) incident, reached by a new route.
   *
   * The asymmetry decides it. Skipping a prune costs disk space that is already
   * wasted and is reclaimed the moment one file exists again. Running one
   * against a failed load costs the user their entire library. A genuinely
   * empty library also has nothing worth reclaiming: `removeFile` deletes bytes
   * directly, so this routine only ever mops up after a crash mid-import.
   */
  if (!liveEntries().length) return

  const last = storage.getNumber(LAST_PRUNE_KEY) ?? 0
  if (Date.now() - last < PRUNE_INTERVAL_MS) return

  void InteractionManager.runAfterInteractions(async () => {
    try {
      await pruneOrphansChunked(liveEntries)
      // Recorded only on success, so a failed pass is retried next launch
      // rather than being silently skipped for a day.
      storage.set(LAST_PRUNE_KEY, Date.now())
    } catch {
      // Housekeeping must never break startup.
    }
  })
}

/**
 * Removes library files that no entry references any more.
 *
 * Prefer `schedulePruneOrphans` — calling this directly runs a full directory
 * enumeration synchronously on the caller's thread.
 */
export function pruneOrphans(entries: FileEntry[]): number {
  ensureLibraryDir()

  const keep = new Set<string>()
  for (const e of entries) {
    keep.add(e.storedName)
    if (e.thumb) keep.add(e.thumb)
  }

  let removed = 0
  for (const item of LIBRARY_DIR.list()) {
    const name = item.name
    if (name.startsWith('library.json')) continue
    if (keep.has(name)) continue
    try {
      item.delete()
      removed += 1
    } catch {
      // Leave anything we cannot delete; it will be retried next launch.
    }
  }
  return removed
}

/**
 * How long the chunked walk may hold the JS thread before yielding.
 *
 * 8 ms is one frame's budget at 120 Hz, which is the rate the board's scroll
 * animation runs at on the devices this targets. A chunk that fits inside one
 * frame cannot drop one; a chunk measured against 60 Hz would drop every other
 * frame on a 120 Hz panel while looking correct on paper.
 *
 * Checked *between* deletions rather than predicted ahead of them: a single
 * `delete` on a large file can overrun on its own, and there is nothing useful
 * to do about that except not start another one.
 */
const PRUNE_SLICE_MS = 8

/**
 * `pruneOrphans`, sliced so it cannot freeze the board.
 *
 * Same result as the synchronous version, reached in `PRUNE_SLICE_MS` bursts
 * with a yield between them. At 10,000 entries the synchronous walk is a
 * multi-second stall — and because the prune is deferred behind
 * `runAfterInteractions`, that stall lands *after* the user has started
 * scrolling, which is the worst possible moment for it.
 *
 * ## Why the entry list is a function
 *
 * Yielding makes the caller's list stale. An import that completes during a
 * yield writes bytes that the `keep` set captured at call time does not know
 * about — and this routine's whole job is deleting files that nothing
 * references, so it would delete the file the user just added. Re-reading live
 * state at each boundary closes that window; the cost is rebuilding a `Set`
 * a handful of times, against deleting a user's file.
 *
 * The empty-library interlock in `schedulePruneOrphans` is re-checked here for
 * the same reason. If the library empties mid-walk — a restore, a clear — the
 * remaining passes must stop rather than treat "nothing is referenced" as
 * "delete everything", which is [DETAIL.md §6.3](../../DETAIL.md) reached by a
 * new route.
 */
async function pruneOrphansChunked(liveEntries: () => FileEntry[]): Promise<number> {
  ensureLibraryDir()

  const keepFrom = (entries: FileEntry[]): Set<string> => {
    const keep = new Set<string>()
    for (const e of entries) {
      keep.add(e.storedName)
      if (e.thumb) keep.add(e.thumb)
    }
    return keep
  }

  // The listing itself is one unavoidable synchronous call — there is no
  // streaming directory API here. Only the per-entry work below is sliced.
  const items = LIBRARY_DIR.list()

  let entries = liveEntries()
  if (!entries.length) return 0
  let keep = keepFrom(entries)

  let removed = 0
  let sliceStart = Date.now()

  for (const item of items) {
    if (Date.now() - sliceStart >= PRUNE_SLICE_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      entries = liveEntries()
      // Re-checked every slice, not just at the start: see the interlock note above.
      if (!entries.length) return removed
      keep = keepFrom(entries)
      sliceStart = Date.now()
    }

    const name = item.name
    if (name.startsWith('library.json')) continue
    if (keep.has(name)) continue
    try {
      item.delete()
      removed += 1
    } catch {
      // Leave anything we cannot delete; it will be retried next launch.
    }
  }
  return removed
}
