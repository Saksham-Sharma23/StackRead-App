import { canReceive } from './incomingName.ts'

/**
 * Pure rules for importing a whole folder or ZIP as one group — testable
 * without a device. The import itself is `storage/bulkImport.ts`.
 */

/**
 * Most files one import adds.
 *
 * A group of 1,000 is already far past browsable on a phone, and the cap also
 * bounds a ZIP bomb's *count* the way the disk budget bounds its size: a
 * crafted archive of a million tiny entries would otherwise be a million index
 * rows and a board that never renders.
 */
export const MAX_IMPORT_FILES = 1000

/** How deep a folder import walks. Real libraries are 2–3 levels; a symlink loop is not. */
export const MAX_FOLDER_DEPTH = 8

/**
 * Most entries a folder walk visits, files and folders alike, before giving
 * up. Bounds the listing itself — a picked folder could be the whole shared
 * storage — separately from how many files are kept.
 */
export const MAX_FOLDER_ENTRIES = 20_000

/** Space left free after an import: a full disk breaks MMKV and SQLite, which are the library. */
export const DISK_HEADROOM_BYTES = 200 * 1024 * 1024

const MAX_TITLE = 60

/** The last segment of a path from a folder walk or a ZIP entry. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? ''
}

/**
 * Clutter that is never a document: hidden files and folders (any segment
 * starting with a dot), macOS's `__MACOSX` resource forks, and Windows'
 * thumbnail caches. Skipped silently — reporting "skipped 40 files" for
 * `.DS_Store` and friends would be noise.
 *
 * A `..` segment starts with a dot too, so a path-traversal entry
 * (`../../evil.pdf`) is dropped here before its name is ever used — no real
 * archive contains one. Names are reduced to their last segment regardless.
 */
export function isJunkPath(path: string): boolean {
  const segments = path.split(/[\\/]/).filter(Boolean)
  if (segments.some((s) => s.startsWith('.') || s === '__MACOSX')) return true
  const last = (segments[segments.length - 1] ?? '').toLowerCase()
  return last === 'thumbs.db' || last === 'desktop.ini'
}

export type EntryVerdict = 'import' | 'junk' | 'unsupported'

/** What to do with one file found in a folder or ZIP. */
export function verdictFor(path: string): EntryVerdict {
  if (isJunkPath(path)) return 'junk'
  return canReceive(baseName(path)) ? 'import' : 'unsupported'
}

/**
 * Natural order: `vol2` before `vol10`, case-insensitive, compared on the full
 * path so files keep their folder's grouping after the folders are flattened.
 *
 * Hand-rolled rather than `Intl.Collator({ numeric: true })`, so the order is
 * the same on every Hermes build and in the Node tests.
 */
export function naturalCompare(a: string, b: string): number {
  const ta = a.toLowerCase().match(/\d+|\D+/g) ?? []
  const tb = b.toLowerCase().match(/\d+|\D+/g) ?? []
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i]
    const y = tb[i]
    if (x === y) continue
    const nx = /^\d/.test(x)
    const ny = /^\d/.test(y)
    if (nx && ny) {
      // Compare digit strings by length first: no overflow for long runs.
      const sx = x.replace(/^0+(?=\d)/, '')
      const sy = y.replace(/^0+(?=\d)/, '')
      if (sx.length !== sy.length) return sx.length - sy.length
      if (sx !== sy) return sx < sy ? -1 : 1
      // Equal value, different padding: fewer leading zeros first, then go on.
      if (x.length !== y.length) return x.length - y.length
      continue
    }
    return x < y ? -1 : 1
  }
  return ta.length - tb.length
}

/**
 * The new group's title: the folder's or ZIP's name, cleaned, made unique
 * among existing groups with " (2)", " (3)"…
 *
 * A folder picked through Android's picker can report a name such as
 * `primary:Download/Comics`, so everything up to the last `/` or `:` goes.
 */
export function groupTitleFor(sourceName: string, existingTitles: Iterable<string>): string {
  let title = sourceName.split(/[\\/:]/).pop() ?? ''
  title = title.replace(/\.zip$/i, '')
  // eslint-disable-next-line no-control-regex
  title = title.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()
  if (!title) title = 'Imported'
  if (title.length > MAX_TITLE) title = title.slice(0, MAX_TITLE).trimEnd()

  const taken = new Set([...existingTitles].map((t) => t.trim().toLowerCase()))
  if (!taken.has(title.toLowerCase())) return title
  for (let n = 2; ; n++) {
    const candidate = `${title} (${n})`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/** What an import found and did, for the message afterwards. */
export interface BulkImportSummary {
  groupTitle: string
  added: number
  /**
   * Files of a type StackRead cannot open. Counts, not names: a crafted ZIP of
   * a million unsupported entries must not become a million-string array.
   */
  unsupported: number
  /** Could not be copied or unpacked. */
  failed: number
  /** Importable files left out by `MAX_IMPORT_FILES`. */
  overLimit: number
}

/** The one-line-per-problem message after an import, or null when there is nothing to say. */
export function summaryMessage(s: BulkImportSummary): string | null {
  const lines: string[] = []
  if (s.unsupported) lines.push(`${s.unsupported} file(s) skipped — unsupported type.`)
  if (s.failed) lines.push(`${s.failed} file(s) couldn’t be read.`)
  if (s.overLimit) lines.push(`${s.overLimit} more file(s) left out — one import adds at most ${MAX_IMPORT_FILES}.`)
  return lines.length ? lines.join('\n') : null
}

/** The user cancelled. Everything copied has been removed. */
export class ImportCancelled extends Error {
  constructor() {
    super('Import cancelled')
    this.name = 'ImportCancelled'
  }
}

/** A limit was hit; the message is written for the user. Everything copied has been removed. */
export class ImportLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportLimitError'
  }
}

export const NO_SPACE = 'There isn’t enough free space on this device for this import.'
