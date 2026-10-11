import type { FileEntry, FileFormat, Group, Library } from '../types'

/**
 * Validates a restored `library.json` field by field ([AUDIT4 D2](../../AUDIT4.md),
 * AUDIT3 §2.1).
 *
 * ## Why
 *
 * A backup is the one input to this app wholly authored by someone else, and
 * the restore used to check only that `groups` and `files` were arrays. Every
 * field inside flowed onward untouched:
 *
 *  - `storedName` and `thumb` become filesystem paths — `new File(LIBRARY_DIR,
 *    storedName)` in a dozen places — so `../../databases/stackread.db` was a
 *    read primitive against the app sandbox, and entered the prune's keep set.
 *  - `id` becomes an MMKV key and a primary key.
 *  - `format` picks a renderer, and `undefined` in a NOT NULL column made every
 *    later save fail.
 *  - `lastScroll` / `lastProgress` were `typeof`-checked, which admits `NaN` and
 *    `Infinity`; both were written to MMKV and read by every renderer.
 *
 * ## Policy
 *
 * The whole archive is rejected on the first bad entry, never repaired. A backup
 * with one malformed entry is not a backup anyone made with this app, and
 * partial acceptance is how a hostile file gets a foothold.
 *
 * Returns a fresh object holding only the known fields, so nothing extra rides
 * along into the database or MMKV. Pure; tested directly.
 */

/** Thrown for any rejected index. The message is safe to show the user. */
export class InvalidBackupError extends Error {
  constructor(detail: string) {
    super(`This backup’s index is invalid (${detail}), so nothing was changed.`)
    this.name = 'InvalidBackupError'
  }
}

/** Every format the app knows. A `satisfies` check keeps it in step with the type. */
const FORMATS = [
  'pdf', 'epub', 'image', 'text', 'markdown', 'docx', 'xlsx', 'csv', 'html', 'comic', 'archive',
] as const satisfies readonly FileFormat[]
const FORMAT_SET: ReadonlySet<string> = new Set(FORMATS)

/** nanoid's alphabet, which every id this app has ever generated uses. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Generous bounds; they exist to refuse absurd input, not to judge taste. */
const MAX_ENTRIES = 100_000
const MAX_NAME_CHARS = 1_000
const MAX_TITLE_CHARS = 500
const MAX_THUMBHASH_CHARS = 200

/**
 * Whether a basename is safe to resolve inside the library directory.
 *
 * Shared with the archive-entry check in `backup.ts`, so the two inputs that
 * reach the same sink — entry names and index fields — cannot drift apart. That
 * drift is exactly the failure mode `sanitize.ts`' header documents for the two
 * HTML passes.
 *
 * A plain basename: letters, digits, `.`, `_`, `-`; not starting with `.`; no
 * `..`; at most 255 characters. Every stored name the app generates
 * (`<id>.<ext>`, `<id>.thumb.jpg`) fits.
 */
export function isSafeStoredName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 255 &&
    /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name) &&
    !name.includes('..')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

export function validateLibrary(raw: unknown): Library {
  if (!isRecord(raw) || !Array.isArray(raw.groups) || !Array.isArray(raw.files)) {
    throw new InvalidBackupError('not a library')
  }
  if (raw.groups.length > MAX_ENTRIES || raw.files.length > MAX_ENTRIES) {
    throw new InvalidBackupError('too many entries')
  }

  const groups: Group[] = []
  const groupIds = new Set<string>()
  for (const g of raw.groups as unknown[]) {
    if (!isRecord(g)) throw new InvalidBackupError('malformed group')
    if (typeof g.id !== 'string' || !ID_RE.test(g.id)) throw new InvalidBackupError('bad group id')
    if (groupIds.has(g.id)) throw new InvalidBackupError('duplicate group id')
    if (typeof g.title !== 'string' || g.title.length > MAX_TITLE_CHARS) {
      throw new InvalidBackupError('bad group title')
    }
    if (!finite(g.order)) throw new InvalidBackupError('bad group order')
    groupIds.add(g.id)
    groups.push({ id: g.id, title: g.title, order: g.order })
  }

  const files: FileEntry[] = []
  const fileIds = new Set<string>()
  const storedNames = new Set<string>()
  for (const f of raw.files as unknown[]) {
    if (!isRecord(f)) throw new InvalidBackupError('malformed file')
    if (typeof f.id !== 'string' || !ID_RE.test(f.id)) throw new InvalidBackupError('bad file id')
    if (fileIds.has(f.id)) throw new InvalidBackupError('duplicate file id')
    if (!boundedString(f.name, MAX_NAME_CHARS)) throw new InvalidBackupError('bad file name')
    if (!isSafeStoredName(f.storedName)) throw new InvalidBackupError('unsafe stored name')
    if (storedNames.has(f.storedName)) throw new InvalidBackupError('duplicate stored name')
    if (typeof f.format !== 'string' || !FORMAT_SET.has(f.format)) throw new InvalidBackupError('unknown format')
    // A file in no group would be on disk and in the index and on no row of the board.
    if (typeof f.groupId !== 'string' || !groupIds.has(f.groupId)) throw new InvalidBackupError('file in a missing group')
    if (!finite(f.orderInGroup)) throw new InvalidBackupError('bad file order')
    if (!finite(f.addedAt)) throw new InvalidBackupError('bad date')

    const entry: FileEntry = {
      id: f.id,
      name: f.name,
      storedName: f.storedName,
      format: f.format as FileFormat,
      groupId: f.groupId,
      orderInGroup: f.orderInGroup,
      addedAt: f.addedAt,
    }

    // Optional fields: absent is fine; present must be well-formed.
    if (f.lastScroll !== undefined && f.lastScroll !== null) {
      if (!finite(f.lastScroll)) throw new InvalidBackupError('bad reading position')
      entry.lastScroll = f.lastScroll
    }
    if (f.lastProgress !== undefined && f.lastProgress !== null) {
      if (!finite(f.lastProgress)) throw new InvalidBackupError('bad reading progress')
      entry.lastProgress = Math.max(0, Math.min(100, f.lastProgress))
    }
    if (f.thumb !== undefined && f.thumb !== null) {
      if (!isSafeStoredName(f.thumb)) throw new InvalidBackupError('unsafe thumbnail name')
      entry.thumb = f.thumb
    }
    if (f.thumbhash !== undefined && f.thumbhash !== null) {
      if (!boundedString(f.thumbhash, MAX_THUMBHASH_CHARS)) throw new InvalidBackupError('bad thumbnail hash')
      entry.thumbhash = f.thumbhash
    }
    if (f.size !== undefined && f.size !== null) {
      if (!finite(f.size) || f.size < 0) throw new InvalidBackupError('bad file size')
      entry.size = f.size
    }

    fileIds.add(f.id)
    storedNames.add(f.storedName)
    files.push(entry)
  }

  return { groups, files }
}
