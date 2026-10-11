import { File, FileMode, Paths, type FileHandle } from 'expo-file-system'
import {
  Unzip,
  UnzipInflate,
  UnzipPassThrough,
  Zip,
  ZipPassThrough,
  strToU8,
  strFromU8,
} from 'fflate'

import type { Library } from '../types'
import { LIBRARY_DIR, RESTORE_STAGING_DIR, ensureLibraryDir } from './paths'
import { readLibrary } from './db'
import { isSafeStoredName, validateLibrary } from './validateLibrary'
import { flushLibrarySave, loadLibrary, replaceLibrary } from './library'
import { getScroll, getProgress, setScroll, setProgress } from '../store/scroll'

/**
 * Export and import the whole library as a single `.zip`.
 *
 * Copying files into app storage makes the library self-contained, but it also
 * means an uninstall takes it with it. This is the escape hatch: everything —
 * the index and every stored file — round-trips through one archive the user
 * controls.
 */

/*
 * There is deliberately no size cap on export any more.
 *
 * There used to be one — 400MB — because the whole archive was assembled in
 * memory with `zipSync` before being written, so a large library simply ran the
 * process out of memory. The cap was a guess at where that would happen, and it
 * was already past what a mid-range phone tolerates.
 *
 * `exportLibrary` now streams: one file is read, pushed through the zip, and
 * written out before the next is touched, so peak memory is roughly the largest
 * single file rather than the whole library. There is nothing left for a cap to
 * protect against except free disk space, which the filesystem reports far more
 * accurately than a constant here could.
 */

export interface ExportResult {
  uri: string
  fileCount: number
  bytes: number
}

/**
 * Bytes read per export chunk.
 *
 * 1MB: large enough that a 100MB book is a hundred native reads rather than the
 * hundred thousand `readableStream()`'s 1KB default would make, small enough
 * that holding one (plus the one read ahead) is nothing.
 */
const EXPORT_CHUNK_BYTES = 1024 * 1024

/**
 * Free space a restore always leaves untouched: the system, other apps and this
 * app's own database and caches need room after it finishes.
 */
const DISK_RESERVE_BYTES = 200 * 1024 * 1024

/** Far beyond any real library; refuses an archive built to exhaust the parser. */
const MAX_ARCHIVE_ENTRIES = 200_000

/**
 * The one entry still assembled in memory. A library of 100,000 files is a few
 * tens of megabytes of JSON; anything past this is not a backup.
 */
const MAX_INDEX_BYTES = 64 * 1024 * 1024

/** A restore refused for a reason worth telling the user, rather than "unreadable". */
class RestoreLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RestoreLimitError'
  }
}

/** Free space, or Infinity where the platform cannot say — never a reason to refuse. */
function availableDiskSpace(): number {
  try {
    const free = Paths.availableDiskSpace
    return typeof free === 'number' && Number.isFinite(free) && free > 0 ? free : Infinity
  } catch {
    return Infinity
  }
}

function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/**
 * Stamps each entry with its reading position, for transport.
 *
 * ## Why the archive needs this at all
 *
 * Positions, zoom and progress live in MMKV, because they are written on every
 * scroll settle and MMKV is synchronous and JSI-backed — putting them in the
 * debounced, journalled index would be a row write per frame. That split is
 * right, and it has one consequence nobody had closed: **MMKV is not in the
 * archive.** An export carried `library.json` and the file bytes, so restoring
 * a backup on a new phone reopened every book at page one, with every card at
 * 0%. For a reading app that is the most valuable thing after the files.
 *
 * So the position is copied into the entry here, at the one moment it has to
 * leave MMKV, and read back out on restore. `lastScroll` existed in the type
 * and the schema for exactly this and had no writer until now — it was carried
 * through the column, both INSERTs and the diff comparator while nothing ever
 * assigned it.
 *
 * Read from MMKV rather than from the loaded rows deliberately: MMKV is the
 * live source of truth, and the row's copy is only ever as fresh as the last
 * export.
 */
async function withPositions(library: Library): Promise<Library> {
  return {
    groups: library.groups,
    files: library.files.map((file) => {
      const scroll = getScroll(file.id)
      const progress = getProgress(file.id)
      // Zero is the default for a file never opened, and writing it would grow
      // every archive with fields that mean "no position". Omitted instead, so
      // an unread file round-trips as unread.
      return {
        ...file,
        ...(scroll ? { lastScroll: scroll } : {}),
        ...(progress ? { lastProgress: progress } : {}),
      }
    }),
  }
}

/**
 * Builds the archive in the cache directory and returns its URI.
 *
 * The caller is expected to hand this to the share sheet — writing directly to
 * Downloads would need broad storage permissions we otherwise never ask for.
 */
export async function exportLibrary(current?: Library): Promise<ExportResult> {
  ensureLibraryDir()

  /*
   * What to back up: the library as it is *now*.
   *
   * This read the database, which lags memory by up to one debounce — and by
   * everything since the last good save when saving is failing, which is
   * precisely when the "back up your library" advice is given
   * ([AUDIT4 C4](../../AUDIT4.md)). The board passes its in-memory library;
   * the database is the fallback, flushed first so it is as current as it can
   * be.
   */
  flushLibrarySave()
  const library = await withPositions(current ?? (await loadLibrary()))

  const out = new File(Paths.cache, `stackread-${timestamp()}.zip`)
  if (out.exists) out.delete()
  out.create({ overwrite: true })

  const writer = out.writableStream().getWriter()
  let written = 0

  /*
   * Streaming rather than `zipSync`.
   *
   * The previous version built the entire archive in memory and wrote it in one
   * call, so peak usage was the whole library plus the assembled zip — which is
   * why it needed a size cap and still fell over on a large library. Here each
   * chunk fflate emits is written straight out, so peak is roughly one file.
   */
  const zip = new Zip()
  let failure: Error | null = null
  /** Every write fflate has emitted so far, in order. */
  let writeChain: Promise<void> = Promise.resolve()
  /** Resolves when fflate signals the central directory is written. */
  let finished: () => void
  const done = new Promise<void>((resolve) => {
    finished = resolve
  })

  zip.ondata = (err, chunk, final) => {
    if (err) {
      // Remembered rather than thrown: this fires from fflate's own callback,
      // where a throw would be unhandled. It is re-thrown on the main path.
      failure ??= err
      finished()
      return
    }
    written += chunk.length
    /*
     * Chained, and awaited by `addEntry` after every push.
     *
     * The write used to be fire-and-forget, on the grounds that the writer
     * queues. It does — without limit. Nothing ever waited, so every file was
     * read and queued as fast as the disk could supply it, and a 2GB library
     * tried to hold 2GB of pending writes ([AUDIT4 C4](../../AUDIT4.md)).
     * Awaiting the chain after each chunk is the backpressure: the next chunk
     * is not read until this one is on disk.
     */
    writeChain = writeChain.then(() => writer.write(chunk))
    if (final) finished()
  }

  /**
   * Adds one entry, streamed.
   *
   * `ZipPassThrough` stores rather than deflates, matching the previous
   * `level: 0`: the payload is overwhelmingly PDFs, images and already-zipped
   * EPUBs, so compression costs time and saves almost nothing.
   */
  const addEntry = async (name: string, bytes: Uint8Array): Promise<void> => {
    const entry = new ZipPassThrough(name)
    zip.add(entry)
    entry.push(bytes, true)
    await writeChain
  }

  /**
   * Adds one file, read and written a chunk at a time.
   *
   * `source.bytes()` read each file whole, so peak memory was the largest file
   * in the library plus whatever writes were still queued. Through a handle,
   * peak is one chunk. The previous chunk is held back by one read so the last
   * push can say `final` — the entry's size and CRC are settled then.
   */
  const addFileEntry = async (name: string, source: File): Promise<void> => {
    const entry = new ZipPassThrough(name)
    zip.add(entry)
    const handle = source.open(FileMode.ReadOnly)
    try {
      let held = handle.readBytes(EXPORT_CHUNK_BYTES)
      for (;;) {
        if (failure) return
        const next = handle.readBytes(EXPORT_CHUNK_BYTES)
        const last = next.length === 0
        entry.push(held, last)
        await writeChain
        if (last) return
        held = next
      }
    } finally {
      handle.close()
    }
  }

  try {
    // The index travels with the files so a restore needs nothing else.
    await addEntry('library.json', strToU8(JSON.stringify(library)))

    for (const file of library.files) {
      if (failure) break

      const source = new File(LIBRARY_DIR, file.storedName)
      if (!source.exists) continue

      // Streamed in chunks, each on disk before the next is read — this is
      // what keeps peak memory flat regardless of file or library size.
      await addFileEntry(`files/${file.storedName}`, source)

      if (file.thumb) {
        const thumb = new File(LIBRARY_DIR, file.thumb)
        if (thumb.exists) await addFileEntry(`files/${file.thumb}`, thumb)
      }
    }

    zip.end()
    await done
    // The central directory's writes, and a write error surfaces here rather
    // than as an unhandled rejection.
    await writeChain
    if (failure) throw failure
  } finally {
    // Closing drains anything still queued. In the failure path this also
    // leaves a well-formed (if incomplete) file rather than a locked handle.
    await writer.close()
  }

  return { uri: out.uri, fileCount: library.files.length, bytes: written }
}

export interface ImportResult {
  files: number
  groups: number
}

/**
 * Restores a previously exported archive, **replacing** the current library.
 *
 * Destructive by design: merging two libraries would need id-collision handling
 * and a conflict policy, which is a much bigger feature than "get my files
 * back". Callers must confirm before calling.
 */
export async function importLibraryArchive(archiveUri: string): Promise<ImportResult> {
  const archive = new File(archiveUri)
  if (!archive.exists) throw new Error('Backup file not found')

  ensureLibraryDir()

  /*
   * Stage, check, copy, commit ([AUDIT4 C3](../../AUDIT4.md)).
   *
   * The archive used to be written straight into the library directory with
   * `create({ overwrite: true })`. "Additive" held only while no archive entry
   * shared a name with a live file: one that did overwrote the live bytes
   * before `replaceLibrary` committed, so a failure mid-restore left the
   * *current* library pointing at foreign bytes — the one outcome a restore
   * must never have.
   *
   * Now nothing in the library directory is touched until the whole archive
   * has unpacked into staging and its index has parsed. Then:
   *
   *  - a staged name that is a **live** file belonging to a *different* entry
   *    aborts the restore before anything is copied;
   *  - one belonging to the *same* entry is left alone — library copies never
   *    change, so the live bytes are the backup's bytes;
   *  - everything else is copied in, one file at a time.
   *
   * `replaceLibrary` remains the single commit point. A kill before it leaves
   * the previous library intact, plus files no index references, which the
   * age-guarded prune reclaims.
   */
  let library: Library
  const written = new Set<string>()
  try {
    library = await unpackArchive(archive)
    commitStagedFiles(library, written)
  } finally {
    clearStaging()
  }

  /*
   * Commit, then reclaim.
   *
   * `replaceLibrary` is the commit point and everything before it is additive,
   * so this is the first irreversible line in the function. Up to here a kill
   * leaves the previous library entirely intact.
   */

  /*
   * Reading positions back into MMKV, before the rows land.
   *
   * MMKV is the live source of truth — every renderer reads `getScroll` on
   * mount and nothing consults `lastScroll` — so restoring the rows alone would
   * put the positions in the index and leave every book opening at page one.
   *
   * Before `replaceLibrary` rather than after, so the first render of the board
   * already has progress to draw: the cards subscribe to these keys through
   * `useMMKVNumber`, and writing them afterwards would paint 0% and then jump.
   *
   * Tolerates their absence. An archive written before this existed carries
   * neither field, and must still restore — it simply restores without
   * positions, which is what it has.
   */
  for (const file of library.files) {
    if (typeof file.lastScroll === 'number') setScroll(file.id, file.lastScroll)
    if (typeof file.lastProgress === 'number') setProgress(file.id, file.lastProgress)
  }

  // A restore replaces the library wholesale rather than editing it, so the
  // rows are written directly instead of being diffed against what was there.
  replaceLibrary(library)

  /*
   * Reclaim what the previous library left behind.
   *
   * Deliberately **after** the commit, and deliberately by manifest rather than
   * by wiping the directory first. Everything the archive wrote is already on
   * disk and the index now describes it, so this is pure housekeeping — a kill
   * here costs disk space, not files, and `pruneOrphans` would finish the job
   * on its own within the day.
   *
   * `written` is what this restore actually produced, so an entry the archive
   * did not carry is not mistaken for an orphan and deleted out from under an
   * index that still references it.
   */
  pruneToManifest(library, written)

  return { files: library.files.length, groups: library.groups.length }
}

/**
 * Streams the archive into the staging directory, returning its index.
 *
 * ## Why this does not clear the library first
 *
 * The previous version decompressed the entire archive into memory, deleted
 * `LIBRARY_DIR`, and then wrote the files. Both halves were dangerous and they
 * compounded: peak memory was `archive + whole decompressed library`, so the
 * likely failure was an OOM kill — *after* the delete and partway through the
 * writes, leaving the directory gone, the new one half-populated, and the
 * SQLite index still describing the old library
 * ([AUDIT2 §1.1](../../AUDIT2.md), [AUDIT §1.2](../../AUDIT.md)).
 *
 * So nothing is deleted here at all. Entries are streamed into
 * `RESTORE_STAGING_DIR`, outside the library: until `commitStagedFiles` and then
 * `replaceLibrary` run, the old index and every file it references are
 * untouched. (They used to stream straight into `LIBRARY_DIR`, which was
 * additive only until an entry shared a live file's name and overwrote it —
 * [AUDIT4 C3](../../AUDIT4.md).)
 *
 * ## Why staging is copied in, not renamed into place
 *
 * That was the plan ([TASKS2 R1-2](../../TASKS2.md)) and it is the textbook
 * answer, but the swap needs a directory rename onto a destination that does
 * not exist — which is precisely the operation Android's `moveSync` refuses
 * with `NoSuchFileException` naming the destination, even when it has just been
 * created ([DETAIL.md §6.3](../../DETAIL.md)). That failure is the reason
 * temp-then-rename was abandoned for the index, and building the one path that
 * protects the user's whole library on top of it would be repeating a mistake
 * this project has already paid for.
 *
 * Additive-then-commit reaches the same guarantee — no window in which the
 * library is neither the old one nor the new one — using only writes and one
 * transactional index update, both of which this platform does reliably.
 *
 * ## Why the index is validated mid-stream
 *
 * `exportLibrary` writes `library.json` as the first entry, so in practice it
 * is validated before a single file is written and a malformed backup is
 * rejected having touched nothing. The check cannot be hoisted out of the
 * stream entirely — the entry's position is a property of the archive, not
 * something we control — so a hand-made archive that puts it last is validated
 * last, and rejecting one of those leaves a few orphans behind. That is the
 * honest trade for never holding the whole library in memory.
 */
async function unpackArchive(archive: File): Promise<Library> {
  let indexJson: string | null = null
  let library: Library | null = null
  let failure: Error | null = null

  // A fresh staging directory: anything left by an interrupted restore is stale.
  clearStaging()

  /*
   * How much this restore may write ([AUDIT4 D4](../../AUDIT4.md)).
   *
   * Free space less a reserve, so a restore can never fill the device — a phone
   * with no free storage misbehaves far beyond this app. Checked up front
   * against the archive's own size (what is staged is at least that, since our
   * backups store rather than compress), and again as every chunk is written.
   */
  const diskBudget = availableDiskSpace() - DISK_RESERVE_BYTES
  if (diskBudget < (archive.size ?? 0)) {
    throw new RestoreLimitError('There isn’t enough free space on this device to restore this backup.')
  }
  let stagedBytes = 0
  let entryCount = 0
  let indexBytes = 0

  RESTORE_STAGING_DIR.create({ intermediates: true })

  const unzip = new Unzip()
  // Stored *and* deflated. Our own exports use `ZipPassThrough`, but a user can
  // hand us any zip, and an unregistered method makes `start()` throw.
  unzip.register(UnzipPassThrough)
  unzip.register(UnzipInflate)

  unzip.onfile = (entry) => {
    if (entry.name === 'library.json') {
      // Small — an index, not a payload — so it is assembled in memory rather
      // than staged to disk.
      const parts: Uint8Array[] = []
      entry.ondata = (err, chunk, final) => {
        if (err) {
          failure ??= err
          return
        }
        indexBytes += chunk.length
        if (indexBytes > MAX_INDEX_BYTES) {
          failure ??= new RestoreLimitError('This backup’s index is too large to restore.')
          return
        }
        parts.push(chunk)
        if (final) indexJson = strFromU8(concat(parts))
      }
      entry.start()
      return
    }

    if (!entry.name.startsWith('files/')) return

    const name = entry.name.slice('files/'.length)
    // Never let a crafted archive write outside the library directory.
    // The same rule the index's stored names must pass (`validateLibrary`), so
    // the two inputs reaching the library directory cannot drift apart.
    if (!isSafeStoredName(name)) return

    entryCount += 1
    if (entryCount > MAX_ARCHIVE_ENTRIES) {
      failure ??= new RestoreLimitError('This backup has more entries than StackRead can restore.')
      return
    }

    /*
     * Written chunk by chunk, synchronously, inside fflate's own callback
     * ([AUDIT4 D4](../../AUDIT4.md)).
     *
     * Each entry used to be gathered whole in memory and written once, on the
     * grounds that `expo-file-system` had no append. It has a `FileHandle`,
     * whose `writeBytes` is synchronous and advances its own offset — so a
     * chunk can go to disk the moment fflate emits it, and no entry is ever in
     * memory whole. A crafted backup with one enormous entry used to be an
     * out-of-memory kill; now it is bounded by disk space, checked below.
     *
     * Blocking the parser on the write is still the behaviour worth having: it
     * stops a fast archive queueing decompressed data faster than the disk can
     * take it.
     */
    // Into staging, never the library: see `importLibraryArchive`.
    const target = new File(RESTORE_STAGING_DIR, name)
    let handle: FileHandle | null = null
    const closeHandle = (): void => {
      try {
        handle?.close()
      } catch {
        // Already closed or never opened.
      }
      handle = null
    }

    entry.ondata = (err, chunk, final) => {
      if (failure) {
        closeHandle()
        return
      }
      if (err) {
        failure = err
        closeHandle()
        return
      }
      try {
        if (!handle) {
          target.create({ overwrite: true })
          handle = target.open(FileMode.WriteOnly)
        }
        stagedBytes += chunk.length
        if (stagedBytes > diskBudget) {
          throw new RestoreLimitError('There isn’t enough free space on this device to restore this backup.')
        }
        if (chunk.length) handle.writeBytes(chunk)
        if (final) closeHandle()
      } catch (e) {
        failure = e instanceof Error ? e : new Error(String(e))
        closeHandle()
      }
    }
    entry.start()
  }

  /*
   * The compressed side streams too.
   *
   * Reading the archive with `bytes()` would put the whole thing in memory
   * before the first entry was even seen, which is half of what this function
   * exists to stop. Read through a handle in 1MB chunks rather than
   * `readableStream()`, whose 1KB default made a 1GB backup a million reads;
   * the yield between chunks keeps the UI responsive.
   */
  const reader = archive.open(FileMode.ReadOnly)
  try {
    for (;;) {
      const chunk = reader.readBytes(EXPORT_CHUNK_BYTES)
      if (chunk.length === 0) {
        unzip.push(new Uint8Array(0), true)
        break
      }
      unzip.push(chunk, false)
      if (failure) break
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  } finally {
    reader.close()
  }

  // A limit is worth naming; anything else is "could not be read". Read through
  // a typed alias: `failure` is only assigned inside fflate's callbacks, so the
  // compiler narrows it to null here.
  const failed = failure as Error | null
  if (failed instanceof RestoreLimitError) throw failed
  if (failed) throw new Error('This backup could not be read')
  if (indexJson === null) throw new Error('This is not a StackRead backup')

  let parsed: unknown
  try {
    parsed = JSON.parse(indexJson)
  } catch {
    throw new Error('This backup’s index is unreadable')
  }
  /*
   * Field by field, not just "two arrays" ([AUDIT4 D2](../../AUDIT4.md)).
   * Stored names become paths, ids become keys, formats pick renderers — the
   * validator rejects the whole archive on the first entry that would misuse
   * any of them, before a single staged file is copied into the library.
   */
  library = validateLibrary(parsed)

  return library
}

/**
 * Moves the staged files into the library, refusing any that would replace a
 * live file belonging to a different entry. Adds every name the restored index
 * may rely on to `written`. Throws before copying anything if there is a
 * conflict.
 *
 * Copy-then-delete per file rather than a move: Android's `moveSync` cannot be
 * trusted with a destination that does not exist yet (DETAIL.md §6.3), while
 * `copySync` is what every import already uses. Deleting each staged file once
 * copied keeps the extra disk the restore needs to about one file.
 */
function commitStagedFiles(library: Library, written: Set<string>): void {
  const owners = (lib: Library): Map<string, string> => {
    const map = new Map<string, string>()
    for (const f of lib.files) {
      map.set(f.storedName, f.id)
      if (f.thumb) map.set(f.thumb, f.id)
    }
    return map
  }
  const live = owners(readLibrary())
  const restored = owners(library)
  const staged = RESTORE_STAGING_DIR.list().filter((item): item is File => item instanceof File)

  // Check everything before copying anything, so a refusal changes nothing.
  for (const item of staged) {
    const liveOwner = live.get(item.name)
    if (liveOwner !== undefined && liveOwner !== restored.get(item.name)) {
      throw new Error('This backup conflicts with files already in your library, so nothing was changed.')
    }
  }

  for (const item of staged) {
    const target = new File(LIBRARY_DIR, item.name)
    if (live.has(item.name) && target.exists) {
      // The same entry's own file: identical bytes, already in place.
      written.add(item.name)
      continue
    }
    // Not referenced by the live index: an orphan at most, safe to replace.
    if (target.exists) target.delete()
    item.copySync(target)
    written.add(item.name)
    item.delete()
  }
}

/** Removes the staging directory, whatever state it is in. Never throws. */
function clearStaging(): void {
  try {
    if (RESTORE_STAGING_DIR.exists) RESTORE_STAGING_DIR.delete()
  } catch {
    // Left for the next restore, which clears it before starting.
  }
}

/** Joins streamed chunks. One allocation, sized once. */
function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/**
 * Deletes library files the freshly committed index does not reference.
 *
 * The counterpart to not clearing the directory up front. `pruneOrphans` would
 * eventually do this, but it is throttled to once a day and refuses to run on
 * an empty library, so leaving it to chance would mean a restore silently
 * doubling the app's storage until tomorrow.
 *
 * Failures are swallowed per entry: this runs *after* the commit, so anything
 * it cannot delete is wasted space rather than a broken restore, and the daily
 * prune gets another attempt at it.
 */
function pruneToManifest(library: Library, written: Set<string>): void {
  const keep = new Set<string>(written)
  for (const file of library.files) {
    keep.add(file.storedName)
    if (file.thumb) keep.add(file.thumb)
  }

  try {
    for (const item of LIBRARY_DIR.list()) {
      // The legacy JSON index and its backup are read during migration and are
      // skipped by `pruneOrphans` for the same reason.
      if (item.name.startsWith('library.json')) continue
      if (keep.has(item.name)) continue
      try {
        item.delete()
      } catch {
        // Leave it; the daily prune will try again.
      }
    }
  } catch {
    // A directory listing that fails is not a reason to fail a restore that has
    // already committed.
  }
}
