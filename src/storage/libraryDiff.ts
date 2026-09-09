import type { FileEntry, Group, Library } from '../types'

/**
 * Works out the smallest set of row writes that turns one library into another.
 *
 * ## Why this exists
 *
 * The index used to be one JSON blob: every mutation re-serialised the whole
 * library and rewrote the file twice (index plus `.bak`). At a few thousand
 * files that is megabytes of `JSON.stringify` on the JS thread inside every
 * 400ms debounce, which is a dropped frame every time a card is dragged.
 *
 * SQLite can write one row instead — but only if something knows *which* row
 * changed, and the store deliberately hands down a whole library rather than a
 * list of edits. That is the right shape for a store (reducers stay pure and
 * total, and the on-disk format stays independent of them), so the diff happens
 * here instead.
 *
 * ## Why it is a separate, dependency-free module
 *
 * This is the part that decides what gets written and what gets *deleted*, in
 * the subsystem where a silent mistake once cost real files
 * ([DETAIL.md §6.3](../../DETAIL.md)). It is pure and imports nothing, so it
 * can be tested exhaustively in Node — `expo-sqlite` cannot load outside a
 * device runtime, and the SQL layer on top of this is deliberately thin enough
 * to read in one sitting.
 */

export interface LibraryDiff {
  groupsUpserted: Group[]
  groupIdsDeleted: string[]
  /** Entries to write. `orderInGroup` is already resolved by the caller. */
  filesUpserted: FileEntry[]
  fileIdsDeleted: string[]
}

export const EMPTY_DIFF: LibraryDiff = {
  groupsUpserted: [],
  groupIdsDeleted: [],
  filesUpserted: [],
  fileIdsDeleted: [],
}

export function isEmptyDiff(diff: LibraryDiff): boolean {
  return (
    diff.groupsUpserted.length === 0 &&
    diff.groupIdsDeleted.length === 0 &&
    diff.filesUpserted.length === 0 &&
    diff.fileIdsDeleted.length === 0
  )
}

/**
 * The row operations that take `prev` to `next`.
 *
 * `prev` is what the database is believed to hold. Passing an empty library
 * yields "insert everything", which is what a first run and a restore both
 * want.
 */
export function diffLibrary(prev: LibraryShadow, next: Library): LibraryDiff {
  // Copied so the originals are not consumed: the shadow belongs to the caller
  // and must survive a failed write unchanged, which is the whole mechanism
  // that makes a failed save retry rather than silently skip.
  const prevGroups = new Map(prev.groups)
  const prevFiles = new Map(prev.files)

  const groupsUpserted: Group[] = []
  for (const group of next.groups) {
    const before = prevGroups.get(group.id)
    if (before === undefined || before !== hashGroup(group)) groupsUpserted.push(group)
    prevGroups.delete(group.id)
  }
  // Whatever is left was in the database and is not in the new library.
  const groupIdsDeleted = [...prevGroups.keys()]

  const filesUpserted: FileEntry[] = []
  for (const file of next.files) {
    const before = prevFiles.get(file.id)
    if (before === undefined || before !== hashFile(file)) filesUpserted.push(file)
    prevFiles.delete(file.id)
  }
  const fileIdsDeleted = [...prevFiles.keys()]

  return { groupsUpserted, groupIdsDeleted, filesUpserted, fileIdsDeleted }
}

/**
 * What the database is believed to contain, as one hash per row.
 *
 * ## Why not a copy of the library
 *
 * This used to be `snapshot()`, a deep copy of every group and file. That
 * **doubled** the library's resident memory — at a few thousand files the
 * process held two complete copies of the index at all times — and the diff
 * then compared ten fields per entry on every save.
 *
 * A diff only ever needs to answer "did this row change", which a content hash
 * answers with one string comparison and a fraction of the memory. The rows
 * themselves are not needed: `diffLibrary` reads its *upserts* from the
 * incoming library, and its *deletes* from the set of ids that have gone —
 * which a map of hashes carries just as well as a map of entries.
 *
 * ## Why this is still safe
 *
 * The property the shadow must have is that it changes **only** when a write
 * succeeds. Copying was one way to guarantee it; hashing is another, and a
 * stronger one — a hash is a value, so it cannot alias a live store object and
 * silently track the very changes it exists to detect. That failure was
 * invisible in memory and only appeared after a process kill, which is the
 * worst possible way to find it.
 */
export interface LibraryShadow {
  groups: Map<string, string>
  files: Map<string, string>
}

export const EMPTY_SHADOW: LibraryShadow = { groups: new Map(), files: new Map() }

/**
 * Content hash of one file row.
 *
 * A joined string of every persisted field, in a fixed order. Not a
 * cryptographic digest: this is compared against another hash of the same
 * construction, never stored or transmitted, so collision resistance against an
 * adversary is irrelevant — and a real hash function would cost more than the
 * comparison it replaces.
 *
 * Hashed field by field rather than compared by reference. The store does keep
 * unchanged entries reference-stable, which would make a reference check
 * tempting — but the flattening step that produces a `Library` rebuilds every
 * entry to stamp `orderInGroup`, so by the time a library reaches this module
 * every object is new. A reference check would therefore report *everything* as
 * changed and quietly reinstate the full rewrite this module exists to avoid.
 *
 * Listing the fields explicitly is also what makes adding one to `FileEntry` a
 * visible decision: a new field that is not hashed here is a field whose
 * changes never persist, which is precisely the kind of silent write failure
 * that caused the incident this subsystem is careful about.
 *
 * The separator matters. Without it, moving a character between two adjacent
 * fields would produce the same string, so a rename from `ab`/`c` to `a`/`bc`
 * would hash identically and never persist.
 */
/**
 * Field separator for the hashes below.
 *
 * A unit separator (U+001F) rather than a comma or a pipe: it is a control
 * character, so it cannot appear in a filename, a group title or any other
 * value being joined — which is what makes the join unambiguous.
 */
const SEP = String.fromCharCode(31)

export function hashFile(f: FileEntry): string {
  return [
    f.name,
    f.storedName,
    f.format,
    f.groupId,
    f.orderInGroup,
    f.lastScroll,
    f.lastProgress,
    f.thumb,
    f.thumbhash,
    f.size,
    f.addedAt,
  ].join(SEP)
}

export function hashGroup(g: Group): string {
  return [g.title, g.order].join(SEP)
}

/**
 * Builds the shadow for a library that has just been written.
 *
 * Replaces `snapshot()`. Same contract — call it only after a successful write
 * — at a fraction of the memory.
 */
export function shadowOf(library: Library): LibraryShadow {
  const groups = new Map<string, string>()
  for (const g of library.groups) groups.set(g.id, hashGroup(g))

  const files = new Map<string, string>()
  for (const f of library.files) files.set(f.id, hashFile(f))

  return { groups, files }
}
