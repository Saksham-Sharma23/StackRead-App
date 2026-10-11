import { EMPTY_LIBRARY, type Library } from '../types'
import { INDEX_BACKUP, INDEX_FILE, ensureLibraryDir } from './paths'
import {
  applyDiff,
  hasMigratedFromJson,
  markMigratedFromJson,
  readLibrary,
  replaceAll,
} from './db'
import {
  diffLibrary,
  hashFile,
  hashGroup,
  isEmptyDiff,
  shadowOf,
  EMPTY_DIFF,
  EMPTY_SHADOW,
  type LibraryDiff,
  type LibraryShadow,
} from './libraryDiff'
import { storage, LAST_FULL_SAVE_KEY } from './mmkv'

/**
 * Loads and saves the library index.
 *
 * ## The index is a SQLite database now
 *
 * It used to be `library.json`, rewritten in full — and then copied to a `.bak`
 * — on every mutation. That cost megabytes of `JSON.stringify` on the JS thread
 * inside every debounce once a library got large, and the double write was the
 * only crash protection available, because Android's `moveSync` made
 * temp-then-rename unusable ([DETAIL.md §6.3](../../DETAIL.md)).
 *
 * WAL replaces the `.bak` with real journalled, atomic commits, and
 * [libraryDiff.ts](libraryDiff.ts) turns each save into the handful of rows
 * that actually changed.
 *
 * ## What did not change
 *
 * The public shape of this module. Callers still hand over a whole `Library`
 * and still get one back, so the store, the backup exporter and the restore
 * path are untouched by the move. `library.json` also remains the **portable**
 * format: it is what an export contains and what an import reads, because a zip
 * a user might carry between devices should not be a database file with a
 * schema version in it.
 *
 * ## The shadow copy
 *
 * A diff needs to know what the database already holds. Rather than reading it
 * back before every write, this module keeps a snapshot of what it last
 * successfully wrote. Two rules make that safe, and both are load-bearing:
 *
 *  - it is a set of **content hashes**, not a copy of the library — a value, so
 *    it cannot alias a live store object and silently track the very changes it
 *    exists to detect, and it costs a fraction of the memory a second copy of
 *    the index did;
 *  - it is updated **only after a write succeeds**, so a failed write is
 *    retried on the next save instead of being silently skipped.
 */

const SAVE_DEBOUNCE_MS = 400

let saveTimer: ReturnType<typeof setTimeout> | null = null

/**
 * The pending save, as a **thunk** rather than a flattened library.
 *
 * The debounce coalesced the *write* and never the work that produced its
 * argument. Flattening the normalized store rebuilds every `FileEntry` in the
 * library (`{ ...entry, orderInGroup: index }`), and the store called it
 * synchronously inside all eleven of its reducers — so importing fifty files
 * with thumbnails rebuilt the whole library fifty times, on the JS thread,
 * while the board was animating those cards in.
 *
 * Deferring it means the flatten happens once per settled burst instead of once
 * per mutation. The thunk closes over the state references the reducer already
 * produced, and Zustand reducers return fresh objects rather than mutating, so
 * what it captures cannot change underneath it.
 */
let pending: (() => Library) | null = null

/** What the database is believed to contain. See "The shadow copy" above. */
let shadow: LibraryShadow = EMPTY_SHADOW

function isLibraryShape(value: unknown): value is Library {
  if (typeof value !== 'object' || value === null) return false
  const lib = value as Partial<Library>
  return Array.isArray(lib.groups) && Array.isArray(lib.files)
}

/**
 * Reads the whole library.
 *
 * ## Why a failure here returns empty instead of throwing
 *
 * Nothing upstream catches this — the store awaits it inside its `load()` —
 * so throwing would leave the board permanently blank with no way forward. An
 * unopenable database is already unrecoverable for *writing*, and every save
 * will report its own failure loudly, so the useful behaviour is to come up
 * degraded rather than not at all.
 *
 * **This is only safe because `schedulePruneOrphans` refuses to run on an empty
 * library.** An empty result here is indistinguishable from a fresh install,
 * and pruning against it would delete every file on disk — the
 * [DETAIL.md §6.3](../../DETAIL.md) incident by a new route. The two rules are
 * a pair; neither should be changed without the other.
 */
export async function loadLibrary(): Promise<Library> {
  ensureLibraryDir()

  try {
    await migrateFromJsonIfNeeded()

    const library = readLibrary()
    shadow = shadowOf(library)
    return library
  } catch (err) {
    console.error('[stackread] could not open the library index', err)
    // Left as an empty shadow deliberately: the next save then computes inserts
    // rather than deletes, so a recovered database is repopulated instead of
    // being emptied to match a library that failed to load.
    shadow = EMPTY_SHADOW
    return { ...EMPTY_LIBRARY }
  }
}

/**
 * One-time import of a pre-SQLite `library.json`.
 *
 * Gated on a flag in the database, **not** on the tables being empty. An empty
 * table is not evidence of a fresh install — it is also what a user who deleted
 * everything has — and treating it as one would resurrect their whole old
 * library from a stale JSON file on the next launch. The flag is set even when
 * there was nothing to import, so the question is asked exactly once.
 *
 * The JSON files are read but deliberately **not deleted**. They are the only
 * copy of a pre-upgrade library, they are small, and leaving them costs a few
 * hundred kilobytes against the chance of needing them if this migration ever
 * turns out to be wrong. `pruneOrphans` already skips them by name.
 */
async function migrateFromJsonIfNeeded(): Promise<void> {
  if (hasMigratedFromJson()) return

  const legacy = (await readIndex(INDEX_FILE)) ?? (await readIndex(INDEX_BACKUP))

  if (legacy && (legacy.groups.length || legacy.files.length)) {
    // `replaceAll` rather than a diff: there is nothing to diff against, and a
    // restore-shaped write is exactly what this is.
    replaceAll(legacy)
    console.warn(
      `[stackread] migrated ${legacy.files.length} files and ${legacy.groups.length} groups from library.json`,
    )
  }

  markMigratedFromJson()
}

/** Parses one legacy index file, or returns null if absent, unreadable or malformed. */
async function readIndex(file: typeof INDEX_FILE): Promise<Library | null> {
  if (!file.exists) return null
  try {
    const parsed: unknown = JSON.parse(await file.text())
    return isLibraryShape(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Writes the library, as the rows that actually changed.
 *
 * **A failure here is loud and is not swallowed.** The old version caught the
 * error, logged it and returned, which is precisely how a write failure became
 * invisible: the library looked correct in memory for the rest of the session,
 * and `pruneOrphans` deleted the unreferenced files on the next launch. The
 * shadow is left untouched on failure so the same rows are attempted again on
 * the next save.
 */
export function saveLibraryNow(library: Library): boolean {
  const diff = diffLibrary(shadow, library)
  if (isEmptyDiff(diff)) return true

  try {
    applyDiff(diff)
  } catch (err) {
    /*
     * One bad row must not take every other row down with it
     * ([AUDIT4 C1](../../AUDIT4.md)).
     *
     * `applyDiff` is one transaction, so a single row SQLite refuses — a
     * `format` of undefined in a NOT NULL column, say — rolled back the whole
     * batch. And because the shadow is left unchanged on failure, that row was
     * in every later diff too: **every save failed for the rest of the
     * session**, silently, while the library looked fine in memory. Retrying
     * row by row lets everything else land; the rows that still fail stay out
     * of the shadow and are retried each save.
     */
    console.error('[stackread] library save failed as a batch; retrying row by row', err)
    const failed = applyRowByRow(diff)
    noteSaveOutcome(failed === 0)
    return failed === 0
  }

  shadow = shadowOf(library)
  noteSaveOutcome(true)
  return true
}

/**
 * Applies a diff one row per transaction, advancing the shadow only for rows
 * that landed. Returns how many rows failed.
 *
 * Deletes before upserts, matching `applyDiff`, so a file moved between groups
 * in the same batch cannot collide with itself.
 */
function applyRowByRow(diff: LibraryDiff): number {
  const next: LibraryShadow = { groups: new Map(shadow.groups), files: new Map(shadow.files) }
  let failed = 0

  const attempt = (one: Partial<LibraryDiff>, onSuccess: () => void, id: string): void => {
    try {
      applyDiff({ ...EMPTY_DIFF, ...one })
      onSuccess()
    } catch (err) {
      failed += 1
      // The id, never the name: AUDIT3 §2.4.
      console.error(`[stackread] library row ${id} could not be saved; isolated and retried next save`, err)
    }
  }

  for (const id of diff.fileIdsDeleted) {
    attempt({ fileIdsDeleted: [id] }, () => next.files.delete(id), id)
  }
  for (const id of diff.groupIdsDeleted) {
    attempt({ groupIdsDeleted: [id] }, () => next.groups.delete(id), id)
  }
  for (const group of diff.groupsUpserted) {
    attempt({ groupsUpserted: [group] }, () => next.groups.set(group.id, hashGroup(group)), group.id)
  }
  for (const file of diff.filesUpserted) {
    attempt({ filesUpserted: [file] }, () => next.files.set(file.id, hashFile(file)), file.id)
  }

  shadow = next
  return failed
}

/*
 * ---- save health -----------------------------------------------------------
 *
 * Two consumers need to know whether saving works:
 *
 *  - `pruneOrphans` must never delete a file the index might not have recorded
 *    yet. It reads `lastFullSaveAt` and leaves alone anything newer.
 *  - The user, once. A library that cannot be saved will lose everything since
 *    the last good save on the next launch; saying nothing is how DETAIL.md
 *    §6.3 happened.
 */

let consecutiveFailures = 0
const healthListeners = new Set<(failing: boolean) => void>()

function noteSaveOutcome(ok: boolean): void {
  if (ok) {
    // Only a save with *nothing* left behind proves the index matches memory.
    // A partial one must not advance this, or the prune would treat the
    // isolated rows' files as orphans.
    storage.set(LAST_FULL_SAVE_KEY, Date.now())
    if (consecutiveFailures > 0) {
      consecutiveFailures = 0
      for (const listener of healthListeners) listener(false)
    }
    return
  }
  consecutiveFailures += 1
  if (consecutiveFailures === 1) {
    for (const listener of healthListeners) listener(true)
  }
}

/** When the index last matched memory completely, or 0 if never on this install. */
export function lastFullSaveAt(): number {
  return storage.getNumber(LAST_FULL_SAVE_KEY) ?? 0
}

/** Called with `true` when saving starts failing and `false` when it recovers. */
export function onSaveHealthChange(listener: (failing: boolean) => void): () => void {
  healthListeners.add(listener)
  return () => {
    healthListeners.delete(listener)
  }
}

/** Coalesces rapid mutations into a single write. */
export function scheduleSave(build: () => Library): void {
  // Only the most recent thunk survives, so a burst of mutations flattens once.
  pending = build
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (pending) {
      const build = pending
      pending = null
      if (!saveLibraryNow(build())) retryLater(build)
    }
  }, SAVE_DEBOUNCE_MS)
}

/**
 * Keeps a failed save's state queued, unless something newer already is.
 *
 * The thunk used to be dropped once tried, so after a failure nothing was
 * retried until the user changed something else — not even by the
 * backgrounding flush, which found nothing pending. Now the last state stays
 * queued, and every flush (reader close, backgrounding) tries it again.
 */
function retryLater(build: () => Library): void {
  if (!pending) pending = build
}

/**
 * Forces any debounced write to land immediately.
 *
 * Desktop calls this on reader close, group switch and quit. The mobile
 * equivalents are app backgrounding and reader dismissal — a phone can have the
 * process killed at any moment, so never leave the index only in memory.
 *
 * Returns true when the index now matches memory — nothing was pending, or the
 * pending write landed in full. Callers about to do something irreversible on
 * the strength of a save (deleting a removed file's bytes) must check it.
 */
export function flushLibrarySave(): boolean {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (!pending) return true

  // Taken before saving so a mutation made during the save queues on its own;
  // put back only if the save failed and nothing newer arrived meanwhile.
  const build = pending
  pending = null
  const saved = saveLibraryNow(build())
  if (!saved) retryLater(build)
  return saved
}

/**
 * Replaces the whole library, for a restore from an archive.
 *
 * Distinct from `saveLibraryNow` because the incoming library bears no relation
 * to what is there: diffing would compute a delete for every existing row and
 * an insert for every new one, which is the same work with more steps and a
 * worse name.
 */
export function replaceLibrary(library: Library): void {
  replaceAll(library)
  shadow = shadowOf(library)
  noteSaveOutcome(true)
  // A restore invalidates anything the debounce was about to write.
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  pending = null
}
