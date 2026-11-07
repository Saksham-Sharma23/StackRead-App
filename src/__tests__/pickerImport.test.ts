import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/*
 * Importing from the file picker froze the UI and left a duplicate behind: the
 * picker made a cache copy, then `copySync` copied that into the library on the
 * JS thread, and the cache copy was never deleted.
 *
 * `storage/files.ts` needs `expo-document-picker` and `expo-file-system`, which
 * cannot load under Node, so these read the source — the same approach as
 * `incoming.test.ts` for the "Open with" path this now shares.
 */

const files = readFileSync(new URL('../storage/files.ts', import.meta.url), 'utf8')
const importFiles = files.slice(files.indexOf('export async function importFiles'), files.indexOf('function discardPickerCopy'))
const discard = files.slice(files.indexOf('function discardPickerCopy'), files.indexOf('export async function copyIntoLibrary'))
const copy = files.slice(files.indexOf('export async function copyIntoLibrary'), files.indexOf('export interface LibrarySlot'))

test('no import copies a file synchronously on the JS thread', () => {
  // A call, not the word: the comment explaining the old bug names it.
  assert.doesNotMatch(files, /\.copySync\(/)
  assert.match(copy, /await Incoming\.copyTo\(sourceUri, slot\.target\.uri\)/, 'content:// goes through the native copier')
  assert.match(copy, /await new File\(sourceUri\)\.copy\(slot\.target\)/, 'the fallback copy is the async one')
  assert.match(importFiles, /await copyIntoLibrary\(/, 'each copy is awaited, so an entry never precedes its bytes')
})

test('the picker makes no cache copy when the native copier is in the build', () => {
  assert.match(importFiles, /const nativeCopy = Incoming\.isAvailable\(\)/)
  assert.match(importFiles, /copyToCacheDirectory: !nativeCopy/)
})

test('a fallback cache copy is deleted whatever happens to the file', () => {
  assert.match(importFiles, /\} finally \{\s*\n\s*discardPickerCopy\(asset\.uri\)/, 'after a copy, success or failure')
  assert.ok(
    importFiles.indexOf('discardPickerCopy(asset.uri)') < importFiles.indexOf('continue'),
    'and for a file skipped as unsupported',
  )
})

test('only the app’s own cache is ever deleted — never the user’s original', () => {
  assert.match(discard, /if \(!uri\.startsWith\(Paths\.cache\.uri\)\) return/)
})

test('a failed copy leaves no partial file in the library', () => {
  assert.match(copy, /catch \(err\) \{[\s\S]{0,120}slot\.target\.delete\(\)[\s\S]{0,120}throw err/)
})
