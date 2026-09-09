import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { FileEntry, Group, Library } from '../types.ts'

/*
 * The library store keeps files normalized at runtime — `filesById` plus
 * `groupOrder` — while `library.json` stays a flat `{ groups, files }`. That
 * split is what removed the O(groups x files) re-filter per mutation, and it
 * introduces exactly one hazard worth testing: the two shapes must agree.
 *
 * A `orderInGroup` that drifts from the position in `groupOrder` would reorder
 * a user's row on next launch — silently, and only after a restart, which is
 * the worst way to find out.
 *
 * `store/library.ts` cannot be imported here (it pulls in `expo-file-system`
 * through the storage layer), so the two pure functions are mirrored and run
 * against real fixtures. They are small and self-contained, which is why this
 * is worth doing rather than deferring entirely to the device.
 */

/** Mirrors `normalize()` in store/library.ts. */
function normalize(lib: Library): {
  filesById: Record<string, FileEntry>
  groupOrder: Record<string, string[]>
} {
  const filesById: Record<string, FileEntry> = {}
  const byGroup = new Map<string, FileEntry[]>()

  for (const file of lib.files) {
    filesById[file.id] = file
    const list = byGroup.get(file.groupId) ?? []
    list.push(file)
    byGroup.set(file.groupId, list)
  }

  const groupOrder: Record<string, string[]> = {}
  for (const group of lib.groups) groupOrder[group.id] = []
  for (const [groupId, list] of byGroup) {
    groupOrder[groupId] = list.sort((a, b) => a.orderInGroup - b.orderInGroup).map((f) => f.id)
  }

  return { filesById, groupOrder }
}

/** Mirrors `toLibrary()` in store/library.ts. */
function toLibrary(state: {
  groups: Group[]
  filesById: Record<string, FileEntry>
  groupOrder: Record<string, string[]>
}): Library {
  const files: FileEntry[] = []
  for (const group of state.groups) {
    const ids = state.groupOrder[group.id] ?? []
    ids.forEach((id, index) => {
      const entry = state.filesById[id]
      if (entry) files.push({ ...entry, orderInGroup: index })
    })
  }
  return { groups: state.groups, files }
}

function file(id: string, groupId: string, orderInGroup: number): FileEntry {
  return {
    id,
    name: `${id}.epub`,
    storedName: `${id}.epub`,
    format: 'epub',
    groupId,
    orderInGroup,
    addedAt: 0,
  }
}

const GROUPS: Group[] = [
  { id: 'g1', title: 'Papers', order: 0 },
  { id: 'g2', title: 'Books', order: 1 },
]

test('normalize then flatten round-trips a library unchanged', () => {
  const lib: Library = {
    groups: GROUPS,
    files: [
      file('a', 'g1', 0),
      file('b', 'g1', 1),
      file('c', 'g2', 0),
    ],
  }

  const round = toLibrary({ groups: lib.groups, ...normalize(lib) })

  assert.deepEqual(round.groups, lib.groups)
  assert.deepEqual(
    round.files.map((f) => [f.id, f.groupId, f.orderInGroup]),
    [
      ['a', 'g1', 0],
      ['b', 'g1', 1],
      ['c', 'g2', 0],
    ],
  )
})

test('normalize sorts by orderInGroup, not by array position', () => {
  // The persisted array carries no ordering guarantee — only the field does.
  // Trusting position would shuffle a row whose JSON happens to be out of order.
  const lib: Library = {
    groups: [GROUPS[0]],
    files: [file('third', 'g1', 2), file('first', 'g1', 0), file('second', 'g1', 1)],
  }

  assert.deepEqual(normalize(lib).groupOrder.g1, ['first', 'second', 'third'])
})

test('flattening renumbers orderInGroup from array position', () => {
  /*
   * `groupOrder` is authoritative at runtime; `orderInGroup` is derived on the
   * way out. So a reorder only has to rewrite one array, and the field cannot
   * drift from it — this asserts stale field values are overwritten rather than
   * persisted.
   */
  const state = {
    groups: [GROUPS[0]],
    filesById: {
      a: file('a', 'g1', 99),
      b: file('b', 'g1', 99),
    },
    groupOrder: { g1: ['b', 'a'] },
  }

  const out = toLibrary(state)
  assert.deepEqual(
    out.files.map((f) => [f.id, f.orderInGroup]),
    [
      ['b', 0],
      ['a', 1],
    ],
  )
})

test('an empty group survives the round trip', () => {
  // Every group gets a `groupOrder` entry, including empty ones, so a row's
  // selector never distinguishes "no such group" from "group with no files".
  const lib: Library = { groups: GROUPS, files: [file('a', 'g1', 0)] }
  const { groupOrder } = normalize(lib)

  assert.deepEqual(groupOrder.g2, [], 'empty group lost its membership array')
  assert.equal(toLibrary({ groups: lib.groups, ...normalize(lib) }).groups.length, 2)
})

test('a file whose group no longer exists is dropped on flatten', () => {
  /*
   * Deleting a group removes its `groupOrder` entry. Flattening walks groups,
   * so an orphaned file cannot be resurrected into the index — which matters
   * because `pruneOrphans` then reclaims its bytes on next launch.
   */
  const state = {
    groups: [GROUPS[0]],
    filesById: { a: file('a', 'g1', 0), ghost: file('ghost', 'gone', 0) },
    groupOrder: { g1: ['a'] },
  }

  const out = toLibrary(state)
  assert.deepEqual(out.files.map((f) => f.id), ['a'])
})

test('membership order is independent of the id map', () => {
  // The invariant that makes the split safe: reordering a row rewrites one
  // array and touches no entry, so cards do not re-render on a reorder of
  // their siblings.
  const filesById = { a: file('a', 'g1', 0), b: file('b', 'g1', 1) }
  const before = toLibrary({ groups: [GROUPS[0]], filesById, groupOrder: { g1: ['a', 'b'] } })
  const after = toLibrary({ groups: [GROUPS[0]], filesById, groupOrder: { g1: ['b', 'a'] } })

  assert.deepEqual(before.files.map((f) => f.id), ['a', 'b'])
  assert.deepEqual(after.files.map((f) => f.id), ['b', 'a'])
  // The entries themselves were never mutated.
  assert.equal(filesById.a.orderInGroup, 0)
})
