import { EMPTY_LIBRARY, type Library } from '../types'
import { INDEX_BACKUP, INDEX_FILE, ensureLibraryDir } from './paths'
import {
  applyDiff,
  hasMigratedFromJson,
  markMigratedFromJson,
  readLibrary,
  replaceAll,
} from './db'
import { diffLibrary, isEmptyDiff, shadowOf, EMPTY_SHADOW, type LibraryShadow } from './libraryDiff'

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
export function saveLibraryNow(library: Library): void {
  const diff = diffLibrary(shadow, library)
  if (isEmptyDiff(diff)) return

  try {
    applyDiff(diff)
  } catch (err) {
    // Deliberately not rethrown: a save runs from a debounce timer and from the
    // backgrounding path, where there is no caller to handle it. Logged as an
    // error rather than a warning, and the shadow is left alone so the next
    // save retries rather than assuming this one landed.
    console.error('[stackread] failed to save library index', err)
    return
  }

  shadow = shadowOf(library)
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
      saveLibraryNow(build())
    }
  }, SAVE_DEBOUNCE_MS)
}

/**
 * Forces any debounced write to land immediately.
 *
 * Desktop calls this on reader close, group switch and quit. The mobile
 * equivalents are app backgrounding and reader dismissal — a phone can have the
 * process killed at any moment, so never leave the index only in memory.
 */
export function flushLibrarySave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (pending) {
    // Cleared before the flatten, not after: `saveLibraryNow` can throw, and a
    // thunk left in place would be re-run by the next flush against state that
    // has since moved on.
    const build = pending
    pending = null
    saveLibraryNow(build())
  }
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
  // A restore invalidates anything the debounce was about to write.
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  pending = null
}
