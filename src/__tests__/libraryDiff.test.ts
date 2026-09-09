import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  diffLibrary,
  isEmptyDiff,
  shadowOf,
  hashFile,
  hashGroup,
  EMPTY_DIFF,
} from '../storage/libraryDiff.ts'
import type { FileEntry, Group, Library } from '../types.ts'

/*
 * The diff decides which rows are written and, more importantly, which are
 * *deleted*. It is the only part of the new SQLite index that can be tested
 * off-device — `expo-sqlite` does not load under Node — which is exactly why
 * the decision logic was put here rather than in the SQL layer.
 *
 * The failure this guards against is specific and has happened to this codebase
 * before: a write path that looks correct in memory, saves nothing, and is
 * discovered only after a process kill.
 */

function file(id: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    id,
    name: `${id}.pdf`,
    storedName: `${id}.pdf`,
    format: 'pdf',
    groupId: 'g1',
    orderInGroup: 0,
    addedAt: 1000,
    ...over,
  }
}

function group(id: string, over: Partial<Group> = {}): Group {
  return { id, title: id, order: 0, ...over }
}

function lib(groups: Group[], files: FileEntry[]): Library {
  return { groups, files }
}

const EMPTY: Library = { groups: [], files: [] }

test('an unchanged library produces no writes at all', () => {
  // The whole point of the move: a save that changes nothing must touch no
  // rows. The previous implementation rewrote the entire index regardless.
  const a = lib([group('g1')], [file('f1'), file('f2', { orderInGroup: 1 })])
  const diff = diffLibrary(shadowOf(a), a)
  assert.ok(isEmptyDiff(diff), 'an identical library produced writes')
})

test('a first save inserts everything', () => {
  const next = lib([group('g1')], [file('f1'), file('f2')])
  const diff = diffLibrary(shadowOf(EMPTY), next)

  assert.equal(diff.groupsUpserted.length, 1)
  assert.equal(diff.filesUpserted.length, 2)
  assert.equal(diff.groupIdsDeleted.length, 0)
  assert.equal(diff.fileIdsDeleted.length, 0)
})

test('renaming a group writes one row and nothing else', () => {
  // The motivating case. This used to re-serialise every file in the library.
  const before = lib([group('g1'), group('g2', { order: 1 })], [file('f1'), file('f2')])
  const after = lib(
    [group('g1', { title: 'Renamed' }), group('g2', { order: 1 })],
    [file('f1'), file('f2')],
  )

  const diff = diffLibrary(shadowOf(before), after)
  assert.equal(diff.filesUpserted.length, 0, 'a group rename rewrote files')
  assert.deepEqual(
    diff.groupsUpserted.map((g) => g.id),
    ['g1'],
  )
})

test('reordering within a group writes only the files that moved', () => {
  const before = lib(
    [group('g1')],
    [file('a', { orderInGroup: 0 }), file('b', { orderInGroup: 1 }), file('c', { orderInGroup: 2 })],
  )
  // 'c' moves to the front: a and b shift by one, so all three genuinely change.
  const after = lib(
    [group('g1')],
    [file('c', { orderInGroup: 0 }), file('a', { orderInGroup: 1 }), file('b', { orderInGroup: 2 })],
  )

  const diff = diffLibrary(shadowOf(before), after)
  assert.deepEqual(new Set(diff.filesUpserted.map((f) => f.id)), new Set(['a', 'b', 'c']))
  assert.equal(diff.fileIdsDeleted.length, 0, 'a reorder deleted a file')
})

test('moving a file to another group is an update, never a delete plus insert', () => {
  // A group is a logical tag. If this ever produced a delete, a crash between
  // the two halves would lose the file — and the bytes on disk would then be
  // collected as an orphan.
  const before = lib([group('g1'), group('g2')], [file('f1', { groupId: 'g1' })])
  const after = lib([group('g1'), group('g2')], [file('f1', { groupId: 'g2' })])

  const diff = diffLibrary(shadowOf(before), after)
  assert.equal(diff.fileIdsDeleted.length, 0, 'a cross-group move deleted the file')
  assert.deepEqual(
    diff.filesUpserted.map((f) => f.groupId),
    ['g2'],
  )
})

test('removing a file deletes exactly that row', () => {
  const before = lib([group('g1')], [file('f1'), file('f2')])
  const after = lib([group('g1')], [file('f1')])

  const diff = diffLibrary(shadowOf(before), after)
  assert.deepEqual(diff.fileIdsDeleted, ['f2'])
  assert.equal(diff.filesUpserted.length, 0)
})

test('removing a group deletes the group and its files', () => {
  const before = lib(
    [group('g1'), group('g2', { order: 1 })],
    [file('f1', { groupId: 'g1' }), file('f2', { groupId: 'g2' })],
  )
  // The store drops files whose group has gone, so they are absent here too.
  const after = lib([group('g1')], [file('f1', { groupId: 'g1' })])

  const diff = diffLibrary(shadowOf(before), after)
  assert.deepEqual(diff.groupIdsDeleted, ['g2'])
  assert.deepEqual(diff.fileIdsDeleted, ['f2'])
})

test('every persisted field is compared', () => {
  /*
   * The one that matters most. A field missing from the comparison is a field
   * whose changes never reach disk — invisible in memory for the whole session,
   * and discovered only after a process kill. `thumbhash` and `size` are the
   * live risk: both were added to `FileEntry` after this subsystem was written.
   */
  const base = file('f1')
  const changes: Array<Partial<FileEntry>> = [
    { name: 'other.pdf' },
    { storedName: 'other.pdf' },
    { format: 'epub' },
    { groupId: 'g2' },
    { orderInGroup: 7 },
    { lastScroll: 42 },
    { thumb: 'f1.thumb.jpg' },
    { thumbhash: 'abc123' },
    { size: 999 },
    { addedAt: 2000 },
  ]

  for (const change of changes) {
    const key = Object.keys(change)[0]
    const diff = diffLibrary(shadowOf(lib([], [base])), lib([], [{ ...base, ...change }]))
    assert.equal(diff.filesUpserted.length, 1, `a change to "${key}" was not detected`)
  }
})

test('both group fields are compared', () => {
  for (const change of [{ title: 'x' }, { order: 3 }]) {
    const key = Object.keys(change)[0]
    const diff = diffLibrary(shadowOf(lib([group('g1')], [])), lib([group('g1', change)], []))
    assert.equal(diff.groupsUpserted.length, 1, `a change to group "${key}" was not detected`)
  }
})

test('clearing an optional field is a change', () => {
  // `undefined` on both sides is equal; present-then-absent is not. Getting
  // this wrong would make a cleared thumbnail impossible to persist.
  const withThumb = file('f1', { thumb: 'f1.thumb.jpg' })
  const without = file('f1')

  assert.equal(diffLibrary(shadowOf(lib([], [withThumb])), lib([], [without])).filesUpserted.length, 1)
  assert.equal(diffLibrary(shadowOf(lib([], [without])), lib([], [withThumb])).filesUpserted.length, 1)
  assert.ok(isEmptyDiff(diffLibrary(shadowOf(lib([], [without])), lib([], [without]))))
})

test('the shadow does not alias the library it was taken from', () => {
  /*
   * The shadow's load-bearing property, unchanged by the move from a deep copy
   * to content hashes — and in fact strengthened by it.
   *
   * If the shadow aliased the caller's objects it would track the very
   * mutations it exists to detect, every subsequent diff would come back empty,
   * and *nothing would ever be written again* — with the library looking
   * perfectly correct in memory until the process died. A hash is a value, so
   * it cannot alias anything; this asserts that directly.
   */
  const original = lib([group('g1')], [file('f1')])
  const shadow = shadowOf(original)

  original.files[0].name = 'mutated.pdf'
  original.groups[0].title = 'mutated'

  // And the mutation is therefore visible as a diff, which is the point.
  const diff = diffLibrary(shadow, original)
  assert.equal(diff.filesUpserted.length, 1, 'the shadow tracked the mutation')
  assert.equal(diff.groupsUpserted.length, 1)
})

test('pushing to the source array does not reach the shadow', () => {
  const original = lib([group('g1')], [file('f1')])
  const shadow = shadowOf(original)

  original.files.push(file('f2'))
  assert.equal(shadow.files.size, 1, 'the shadow shared the files array')

  // The new file shows up as an insert rather than being invisible.
  assert.equal(diffLibrary(shadow, original).filesUpserted.length, 1)
})

test('a hash changes when any compared field changes', () => {
  /*
   * The hash replaces a field-by-field comparison, so it has to be sensitive to
   * exactly the same set of fields. A field missing from the hash is a field
   * whose changes never persist — the silent write failure this whole subsystem
   * is careful about.
   */
  const base = file('f1')
  const changes: Partial<FileEntry>[] = [
    { name: 'other.pdf' },
    { storedName: 'other.pdf' },
    { format: 'epub' },
    { groupId: 'g2' },
    { orderInGroup: 5 },
    { lastScroll: 42 },
    { lastProgress: 7 },
    { thumb: 't.jpg' },
    { thumbhash: 'abc' },
    { size: 99 },
    { addedAt: 2000 },
  ]

  for (const change of changes) {
    assert.notEqual(
      hashFile({ ...base, ...change }),
      hashFile(base),
      `changing ${Object.keys(change)[0]} must change the hash, or it never persists`,
    )
  }

  assert.notEqual(hashGroup(group('g1', { title: 'x' })), hashGroup(group('g1')))
  assert.notEqual(hashGroup(group('g1', { order: 3 })), hashGroup(group('g1')))
})

test('the hash separator prevents adjacent fields from running together', () => {
  /*
   * Without a separator, moving a character across a field boundary produces
   * the same joined string: name 'ab' + storedName 'c' hashes identically to
   * name 'a' + storedName 'bc', so a rename between those two would never be
   * written.
   */
  const a = file('f1', { name: 'ab', storedName: 'c' })
  const b = file('f1', { name: 'a', storedName: 'bc' })
  assert.notEqual(hashFile(a), hashFile(b))
})

test('an unchanged entry hashes identically, so nothing is rewritten', () => {
  const a = file('f1')
  const b = file('f1')
  assert.equal(hashFile(a), hashFile(b))
  assert.ok(isEmptyDiff(diffLibrary(shadowOf(lib([], [a])), lib([], [b]))))
})

test('an empty diff is empty', () => {
  assert.ok(isEmptyDiff(EMPTY_DIFF))
  assert.ok(isEmptyDiff(diffLibrary(shadowOf(EMPTY), EMPTY)))
})

test('a full replacement swaps every row', () => {
  // What a restore from an archive looks like if it went through the diff.
  const before = lib([group('g1')], [file('f1'), file('f2')])
  const after = lib([group('g9')], [file('f9')])

  const diff = diffLibrary(shadowOf(before), after)
  assert.deepEqual(diff.groupIdsDeleted, ['g1'])
  assert.deepEqual(new Set(diff.fileIdsDeleted), new Set(['f1', 'f2']))
  assert.deepEqual(
    diff.groupsUpserted.map((g) => g.id),
    ['g9'],
  )
  assert.deepEqual(
    diff.filesUpserted.map((f) => f.id),
    ['f9'],
  )
})

test('a large library with one edit writes one row', () => {
  /*
   * The scaling claim, stated as a test. At 5,000 files the old path
   * stringified and wrote the entire index twice; this must touch exactly the
   * row that changed.
   */
  const files = Array.from({ length: 5000 }, (_, i) => file(`f${i}`, { orderInGroup: i }))
  const before = lib([group('g1')], files)
  // A deep copy made here rather than by the module: `snapshot` is gone, and
  // the point of this test is a large library where exactly one row differs.
  const after: Library = {
    groups: before.groups.map((g) => ({ ...g })),
    files: before.files.map((f) => ({ ...f })),
  }
  after.files[2500].name = 'edited.pdf'

  const diff = diffLibrary(shadowOf(before), after)
  assert.equal(diff.filesUpserted.length, 1)
  assert.equal(diff.filesUpserted[0].id, 'f2500')
  assert.equal(diff.fileIdsDeleted.length, 0)
  assert.equal(diff.groupsUpserted.length, 0)
})
