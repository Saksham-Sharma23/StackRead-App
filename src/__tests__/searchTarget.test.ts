import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { openTarget, visibleResults } from '../store/searchTarget.ts'
import type { FileEntry } from '../types.ts'

/*
 * Search answers from SQLite, which keeps a removed file's row until its undo
 * window closes. A just-removed file was listed, and opening it fell back to
 * the first file of its group — a different file. Results are now checked
 * against the store before they are shown or opened.
 */

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

function entry(id: string, groupId = 'g1'): FileEntry {
  return { id, name: `${id}.pdf`, storedName: `${id}.pdf`, format: 'pdf', groupId, orderInGroup: 0, addedAt: 0 }
}

test('a file inside its undo window is not listed', () => {
  const page = { files: [entry('a'), entry('b'), entry('c')], total: 3 }
  const shown = visibleResults(page, new Set(['b']))
  assert.deepEqual(shown.files.map((f) => f.id), ['a', 'c'])
  assert.equal(shown.total, 2)
})

test('nothing hidden returns the same page, so memos keep their identity', () => {
  const page = { files: [entry('a')], total: 1 }
  assert.equal(visibleResults(page, new Set()), page)
  assert.equal(visibleResults(page, new Set(['unrelated'])), page)
})

test('the total never drops below what is shown', () => {
  const page = { files: [entry('a'), entry('b')], total: 2 }
  const shown = visibleResults(page, new Set(['a', 'b']))
  assert.deepEqual(shown, { files: [], total: 0 })

  // More matches than were fetched: only the fetched hidden one is subtracted.
  const big = { files: [entry('a'), entry('b')], total: 70 }
  assert.equal(visibleResults(big, new Set(['a'])).total, 69)
})

test('a hidden or deleted result does not open', () => {
  const live = { a: entry('a') }
  assert.equal(openTarget(entry('a'), live, new Set(['a'])), null, 'mid-removal')
  assert.equal(openTarget(entry('gone'), live, new Set()), null, 'already removed')
})

test('a result opens as the store’s entry, in the group it is in now', () => {
  const moved = entry('a', 'new-group')
  const stale = entry('a', 'old-group') // as SQLite returned it, before the move landed
  assert.equal(openTarget(stale, { a: moved }, new Set()), moved)
})

test('the board shows and opens search results through these checks', () => {
  const board = source('screens/LibraryScreen.tsx')
  assert.match(board, /visibleResults\(results, hiddenIds\)/)
  assert.match(board, /openTarget\(file, useLibrary\.getState\(\)\.filesById, usePendingRemoval\.getState\(\)\.hiddenIds\)/)
  // Both search components — Classic's and the looks' — get the checked props.
  assert.equal((board.match(/results=\{shownResults\}/g) ?? []).length, 2)
  assert.equal((board.match(/onOpenFile=\{openSearchResult\}/g) ?? []).length, 2)
  assert.doesNotMatch(board, /results=\{results\}/, 'no search component may get the raw SQLite page')

  const reader = source('screens/ReaderScreen.tsx')
  assert.match(reader, /useLibrary\.getState\(\)\.filesById\[initialFile\.id\]\?\.groupId \?\? initialFile\.groupId/,
    'the reader opens a file into the group the store says it is in')
})
