import { File, Paths } from 'expo-file-system'
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
import { LIBRARY_DIR, ensureLibraryDir } from './paths'
import { loadLibrary, replaceLibrary } from './library'
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
export async function exportLibrary(): Promise<ExportResult> {
  ensureLibraryDir()

  const library = await withPositions(await loadLibrary())

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
    // The writer queues, so awaiting is not required for correctness here; the
    // final drain below is what guarantees everything reached disk.
    void writer.write(chunk)
    if (final) finished()
  }

  /**
   * Adds one entry, streamed.
   *
   * `ZipPassThrough` stores rather than deflates, matching the previous
   * `level: 0`: the payload is overwhelmingly PDFs, images and already-zipped
   * EPUBs, so compression costs time and saves almost nothing.
   */
  const addEntry = (name: string, bytes: Uint8Array): void => {
    const entry = new ZipPassThrough(name)
    zip.add(entry)
    entry.push(bytes, true)
  }

  try {
    // The index travels with the files so a restore needs nothing else.
    addEntry('library.json', strToU8(JSON.stringify(library)))

    for (const file of library.files) {
      if (failure) break

      const source = new File(LIBRARY_DIR, file.storedName)
      if (!source.exists) continue

      // Read, pushed, and released before the next file is touched — this is
      // what keeps peak memory flat regardless of library size.
      addEntry(`files/${file.storedName}`, await source.bytes())

      if (file.thumb) {
        const thumb = new File(LIBRARY_DIR, file.thumb)
        if (thumb.exists) addEntry(`files/${file.thumb}`, await thumb.bytes())
      }
    }

    zip.end()
    await done
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

  const { library, written } = await unpackArchive(archive)

  /*
   * Commit, then reclaim.
   *
   * `replaceLibrary` is the commit point and everything before it is additive,
   * so this is the first irreversible line in the function. Up to here a kill
   * leaves the previous library entirely intact — see `unpackArchive`.
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
 * Streams the archive into the library directory, returning its index.
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
 * So nothing is deleted here at all. Entries are streamed straight into
 * `LIBRARY_DIR`, which is **additive**: until `replaceLibrary` commits the new
 * index, the old index and every file it references are still present and still
 * consistent. A kill at any point during this function leaves the previous
 * library working, plus some unreferenced bytes that `pruneOrphans` reclaims.
 *
 * ## Why not unpack to a sibling directory and rename it into place
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
async function unpackArchive(archive: File): Promise<{ library: Library; written: Set<string> }> {
  let indexJson: string | null = null
  let library: Library | null = null
  /** Basenames this restore wrote, so the prune below cannot delete them. */
  const written = new Set<string>()
  let failure: Error | null = null

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
        parts.push(chunk)
        if (final) indexJson = strFromU8(concat(parts))
      }
      entry.start()
      return
    }

    if (!entry.name.startsWith('files/')) return

    const name = entry.name.slice('files/'.length)
    // Never let a crafted archive write outside the library directory.
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return

    /*
     * Buffered per entry, then written once.
     *
     * `expo-file-system` has no append, so incremental writes would mean
     * holding a `writableStream` per entry — and fflate delivers chunks
     * synchronously inside `push`, so those writes could not be awaited in
     * order without stalling the parser. One file in memory at a time is the
     * bound that matters: peak is the largest single file rather than the whole
     * library, which is the entire point of this rewrite.
     */
    const parts: Uint8Array[] = []
    entry.ondata = (err, chunk, final) => {
      if (err) {
        failure ??= err
        return
      }
      parts.push(chunk)
      if (!final) return

      const bytes = concat(parts)
      // Length is cleared so the buffer is collectable before the next entry
      // starts, rather than at the end of the archive.
      parts.length = 0

      /*
       * Written synchronously, inside fflate's own callback.
       *
       * `File.write` is synchronous, so there is nothing to await and no
       * ordering to manage — and blocking the parser on the disk write is the
       * behaviour worth having: it is what stops a fast archive queueing
       * decompressed entries faster than they can be written, which would put
       * the whole library back in memory by a different route.
       */
      try {
        const target = new File(LIBRARY_DIR, name)
        target.create({ overwrite: true })
        target.write(bytes)
        written.add(name)
      } catch (err) {
        failure ??= err instanceof Error ? err : new Error(String(err))
      }
    }
    entry.start()
  }

  /*
   * The compressed side streams too.
   *
   * Reading the archive with `bytes()` would put the whole thing in memory
   * before the first entry was even seen, which is half of what this function
   * exists to stop.
   */
  const reader = archive.readableStream().getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        unzip.push(new Uint8Array(0), true)
        break
      }
      if (value) unzip.push(value, false)
      if (failure) break
    }
  } finally {
    reader.releaseLock()
  }

  if (failure) throw new Error('This backup could not be read')
  if (indexJson === null) throw new Error('This is not a StackRead backup')

  try {
    const parsed = JSON.parse(indexJson) as Library
    if (!Array.isArray(parsed.groups) || !Array.isArray(parsed.files)) {
      throw new Error('shape')
    }
    library = parsed
  } catch {
    throw new Error('This backup’s index is unreadable')
  }

  return { library, written }
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
