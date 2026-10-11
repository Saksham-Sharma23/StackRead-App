import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate'

import { incomingFileName } from './incomingName.ts'
import {
  ImportCancelled,
  ImportLimitError,
  MAX_IMPORT_FILES,
  NO_SPACE,
  baseName,
  verdictFor,
} from './bulkImportRules.ts'

/**
 * The streaming core of "Import ZIP as group": which entries to keep, written
 * as they inflate, within the limits.
 *
 * Storage is passed in (`ZipIo`), so the whole path — a ZIP bomb, `../` names,
 * a truncated archive — runs in the Node tests against real archives;
 * `storage/bulkImport.ts` supplies the device's files.
 *
 * Bounded three ways against a hostile archive: the byte budget, checked on
 * every chunk, so a bomb stops at free space; the file count
 * (`MAX_IMPORT_FILES`); and names — only an entry's last path segment is kept,
 * as display metadata, and where the bytes land is the caller's choice
 * (`<id>.<ext>` in the library), so `../../x` points nowhere.
 */

/** Somewhere one entry's bytes go. */
export interface ZipTarget {
  write(chunk: Uint8Array): void
  close(): void
  /** Deletes what was written. Must not throw. */
  remove(): void
}

export interface ZipIo<T extends ZipTarget> {
  /** The next chunk of the archive; empty at the end. */
  read(): Uint8Array
  /** A target for an entry with this display name. May throw; that entry fails. */
  create(name: string): T
  /** Bytes the unpacked files may use in total. */
  budget: number
  cancelled(): boolean
  onEntry?(written: number): void
  /** Yields to the UI between chunks. */
  pause(): Promise<void>
}

export interface Unpacked<T> {
  /** Path inside the ZIP (for ordering), display name, and where it went. */
  written: { path: string; name: string; target: T }[]
  unsupported: number
  failed: number
  overLimit: number
}

const UNREADABLE = 'This ZIP couldn’t be read. It may be damaged, encrypted, or larger than 4 GB.'

/**
 * Unpacks the supported entries. Throws `ImportCancelled` or `ImportLimitError`
 * after removing everything it wrote; otherwise returns only complete files.
 */
export async function unpackZipEntries<T extends ZipTarget>(io: ZipIo<T>): Promise<Unpacked<T>> {
  type Record = { path: string; name: string; target: T; done: boolean }
  const records: Record[] = []
  let unpackedBytes = 0
  let accepted = 0
  let unsupported = 0
  let failed = 0
  let overLimit = 0
  let fatal: Error | null = null

  const unzip = new Unzip()
  // Stored and deflated: the two methods real ZIPs use, and all fflate knows.
  unzip.register(UnzipPassThrough)
  unzip.register(UnzipInflate)

  unzip.onfile = (entry) => {
    if (fatal || entry.name.endsWith('/')) return
    const verdict = verdictFor(entry.name)
    if (verdict === 'junk') return
    if (verdict === 'unsupported') {
      unsupported += 1
      return
    }
    if (accepted >= MAX_IMPORT_FILES) {
      overLimit += 1
      return
    }
    accepted += 1

    const name = incomingFileName(baseName(entry.name), null)
    let target: T
    try {
      target = io.create(name)
    } catch {
      failed += 1
      return
    }
    const record: Record = { path: entry.name, name, target, done: false }
    records.push(record)

    let open = true
    const close = () => {
      if (!open) return
      open = false
      try {
        target.close()
      } catch {
        // Already closed.
      }
    }
    // One bad entry (corrupt data, encryption) costs that file, not the import.
    const drop = () => {
      close()
      target.remove()
      records.splice(records.indexOf(record), 1)
      failed += 1
    }

    entry.ondata = (err, chunk, final) => {
      if (fatal || !records.includes(record)) return close()
      if (err) return drop()
      try {
        unpackedBytes += chunk.length
        if (unpackedBytes > io.budget) {
          fatal = new ImportLimitError(NO_SPACE)
          return close()
        }
        if (chunk.length) target.write(chunk)
        if (final) {
          close()
          record.done = true
          io.onEntry?.(records.length)
        }
      } catch {
        drop()
      }
    }
    try {
      entry.start()
    } catch {
      drop()
    }
  }

  for (;;) {
    if (io.cancelled() || fatal) break
    const chunk = io.read()
    try {
      unzip.push(chunk, chunk.length === 0)
    } catch {
      fatal ??= new ImportLimitError(UNREADABLE)
    }
    if (chunk.length === 0) break
    await io.pause()
  }

  // Read through a typed alias: assigned in fflate's callbacks, so the
  // compiler narrows `fatal` to null here.
  const failure = fatal as Error | null
  if (io.cancelled() || failure) {
    for (const r of records) r.target.remove()
    throw failure ?? new ImportCancelled()
  }

  // An entry cut off by the end of the archive is a damaged file, not a document.
  const written: Unpacked<T>['written'] = []
  for (const r of records) {
    if (r.done) {
      written.push({ path: r.path, name: r.name, target: r.target })
    } else {
      r.target.remove()
      failed += 1
    }
  }
  return { written, unsupported, failed, overLimit }
}
