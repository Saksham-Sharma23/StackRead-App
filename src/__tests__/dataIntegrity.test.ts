import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { isOldEnoughToPrune, PRUNE_GRACE_MS } from '../storage/pruneGuard.ts'

/*
 * AUDIT4 C1–C4: the paths where a failure loses or corrupts the user's library.
 *
 * The age guard is pure and runs here for real. The rest live in modules that
 * import SQLite, MMKV and expo-file-system, so — as elsewhere in this suite —
 * the structure that carries each property is pinned from source.
 */

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

/* ==================== C1: the prune guard ==================== */

const SAVED = 1_700_000_000_000

test('C1: a file older than the last full save may be pruned', () => {
  assert.equal(isOldEnoughToPrune(SAVED - PRUNE_GRACE_MS - 1, SAVED), true)
})

test('C1: a file newer than the last full save is kept — the index may not have it', () => {
  assert.equal(isOldEnoughToPrune(SAVED + 5_000, SAVED), false, 'imported after the save')
  assert.equal(isOldEnoughToPrune(SAVED - 1_000, SAVED), false, 'inside the grace window')
})

test('C1: with no full save recorded, nothing is deleted', () => {
  // An upgrade from before the guard, or a fresh install: nothing is provably old enough.
  assert.equal(isOldEnoughToPrune(0, 0), false)
  assert.equal(isOldEnoughToPrune(SAVED - 10 ** 9, 0), false)
})

test('C1: an unreadable timestamp keeps the file', () => {
  assert.equal(isOldEnoughToPrune(null, SAVED), false)
  assert.equal(isOldEnoughToPrune(undefined, SAVED), false)
  assert.equal(isOldEnoughToPrune(Number.NaN, SAVED), false)
})

test('C1: both prune walks consult the guard before deleting', () => {
  const files = source('storage/files.ts')
  const walks = [...files.matchAll(/if \(keep\.has\(name\)\) continue\s*\n\s*if \(!mayDelete\(item, lastFullSave\)\) continue\s*\n\s*try \{\s*\n\s*item\.delete\(\)/g)]
  assert.equal(walks.length, 2, 'pruneOrphans and pruneOrphansChunked must both be guarded')
  assert.ok(/if \(!\(item instanceof File\)\) return false/.test(files), 'only plain files may be pruned')
})

test('C1: one bad row no longer blocks the rest, and only a full save advances the guard', () => {
  const library = source('storage/library.ts')
  const save = library.slice(library.indexOf('export function saveLibraryNow'), library.indexOf('function applyRowByRow'))
  assert.ok(/catch \(err\) \{[\s\S]*applyRowByRow\(diff\)/.test(save), 'a failed batch must be retried row by row')

  const rows = library.slice(library.indexOf('function applyRowByRow'), library.indexOf('let consecutiveFailures'))
  assert.ok(/applyDiff\(\{ \.\.\.EMPTY_DIFF, \.\.\.one \}\)\s*\n\s*onSuccess\(\)/.test(rows), 'the shadow advances only for rows that landed')

  const outcome = library.slice(library.indexOf('function noteSaveOutcome'), library.indexOf('export function lastFullSaveAt'))
  assert.ok(/if \(ok\) \{[\s\S]{0,300}storage\.set\(LAST_FULL_SAVE_KEY, Date\.now\(\)\)/.test(outcome))
  assert.ok(/noteSaveOutcome\(failed === 0\)/.test(save), 'a partial save must not count as full')
})

test('C1: a failed save stays queued for the next flush', () => {
  const library = source('storage/library.ts')
  const flush = library.slice(library.indexOf('export function flushLibrarySave'))
  assert.ok(/if \(!saved\) retryLater\(build\)/.test(flush))
  assert.ok(/if \(!saveLibraryNow\(build\(\)\)\) retryLater\(build\)/.test(library), 'the debounced path too')
  assert.ok(/function retryLater[\s\S]{0,80}if \(!pending\) pending = build/.test(library), 'never over a newer state')
})

test('C1: the user is told once when saving fails', () => {
  const lifecycle = source('ui/useAppLifecycle.ts')
  assert.ok(/onSaveHealthChange\(\(failing\) => \{\s*\n\s*if \(!failing \|\| warned\) return/.test(lifecycle))
})

/* ==================== C2: removal order ==================== */

test('C2: bytes are deleted only after the index write is confirmed', () => {
  const pending = source('store/pendingRemoval.ts')
  const finish = pending.slice(pending.indexOf('function finishRemovals'), pending.indexOf('onSaveHealthChange('))
  const remove = finish.indexOf('removeFile(entry.id)')
  const flush = finish.indexOf('if (!flushLibrarySave()) return false')
  const settle = finish.indexOf('settleAwaiting()')
  assert.ok(remove > 0 && flush > remove && settle > flush, 'rows, then a confirmed save, then the bytes')
})

test('C2: ids awaiting a save stay in the crash marker', () => {
  const pending = source('store/pendingRemoval.ts')
  assert.ok(
    /const all = \[\.\.\.new Set\(\[\.\.\.ids, \.\.\.awaitingSave\.keys\(\)\]\)\]/.test(pending),
    'the marker must cover unconfirmed removals, so resumeInterrupted finishes them after a kill',
  )
  // A recovered save finishes whatever was waiting on it.
  assert.ok(/onSaveHealthChange\(\(failing\) => \{\s*\n\s*if \(failing \|\| !awaitingSave\.size\) return\s*\n\s*settleAwaiting\(\)/.test(pending))
})

/* ==================== C3: restore staging ==================== */

test('C3: a restore unpacks into staging, never into the library', () => {
  const backup = source('storage/backup.ts')
  const unpack = backup.slice(backup.indexOf('async function unpackArchive'), backup.indexOf('function commitStagedFiles'))
  assert.ok(unpack.includes('new File(RESTORE_STAGING_DIR, name)'))
  assert.doesNotMatch(unpack, /new File\(LIBRARY_DIR/, 'nothing may be written to the library while unpacking')

  const paths = source('storage/paths.ts')
  assert.ok(
    /RESTORE_STAGING_DIR = new Directory\(Paths\.document, 'restore-staging'\)/.test(paths),
    'staging must be outside LIBRARY_DIR, where the orphan prune would delete it',
  )
})

test('C3: conflicts are checked before anything is copied, and live files are never replaced', () => {
  const backup = source('storage/backup.ts')
  const commit = backup.slice(backup.indexOf('function commitStagedFiles'), backup.indexOf('function clearStaging'))

  const check = commit.indexOf('throw new Error(')
  const copy = commit.indexOf('copySync(')
  assert.ok(check > 0 && copy > check, 'every conflict must be found before the first copy')
  assert.ok(/liveOwner !== undefined && liveOwner !== restored\.get\(item\.name\)/.test(commit))
  assert.ok(
    /if \(live\.has\(item\.name\) && target\.exists\) \{[\s\S]{0,160}continue/.test(commit),
    "a live entry's own file must be kept, not overwritten",
  )
})

test('C3: the commit order is unpack, copy, then replaceLibrary; staging is always cleared', () => {
  const backup = source('storage/backup.ts')
  const restore = backup.slice(backup.indexOf('export async function importLibraryArchive'), backup.indexOf('async function unpackArchive'))
  const unpack = restore.indexOf('await unpackArchive(archive)')
  const copy = restore.indexOf('commitStagedFiles(library, written)')
  const commit = restore.indexOf('replaceLibrary(library)')
  assert.ok(unpack > 0 && copy > unpack && commit > copy)
  assert.ok(/\} finally \{\s*\n\s*clearStaging\(\)/.test(restore))
})

/* ==================== C4: export ==================== */

test('C4: export streams each file in chunks and waits for every write', () => {
  const backup = source('storage/backup.ts')
  const exp = backup.slice(backup.indexOf('export async function exportLibrary'), backup.indexOf('export interface ImportResult'))

  assert.doesNotMatch(exp, /await source\.bytes\(\)|await thumb\.bytes\(\)/, 'no file may be read whole')
  assert.ok(exp.includes('handle.readBytes(EXPORT_CHUNK_BYTES)'))
  assert.ok(/writeChain = writeChain\.then\(\(\) => writer\.write\(chunk\)\)/.test(exp))
  assert.doesNotMatch(exp, /void writer\.write/, 'writes must not be fire-and-forget')
  assert.ok(
    /entry\.push\(held, last\)\s*\n\s*await writeChain/.test(exp),
    'each chunk must be on disk before the next is read',
  )
})

test('C4: export backs up the library as it is in memory', () => {
  const backup = source('storage/backup.ts')
  assert.ok(/export async function exportLibrary\(current\?: Library\)/.test(backup))
  assert.ok(/flushLibrarySave\(\)\s*\n\s*const library = await withPositions\(current \?\? \(await loadLibrary\(\)\)\)/.test(backup))

  const screen = source('screens/LibraryScreen.tsx')
  assert.ok(screen.includes('exportLibrary(snapshotLibrary())'), 'the board must pass its in-memory library')
})
