import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/*
 * AUDIT4 E1, E3, E4, E5. E2 has its own file (`startupBundle.test.ts`), which
 * walks the real import graph.
 *
 * Everything here lives in a build script or in modules that import React
 * Native, so the structure carrying each property is pinned from source.
 */

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

/* ==================== E1: release keep rules ==================== */

test('E1: pdfium and the local Expo module are kept in minified builds', () => {
  const script = source('../scripts/tune-gradle.mjs')
  const v2 = script.slice(script.indexOf('const KEEP_MARKER_V2'))
  assert.ok(v2.includes('-keep class io.legere.pdfiumandroid.** { *; }'), 'Gson reads the outline model reflectively')
  assert.ok(v2.includes('-keep class expo.modules.pdftext.** { *; }'))
  assert.ok(v2.includes('-keepattributes Signature'))
})

test('E1: the new rules reach files that already carry the first block', () => {
  /*
   * The first block is appended only when its marker is absent. Rules added
   * inside it would never reach an existing checkout — so the second block has
   * its own marker and its own check, outside the first one's `if`.
   */
  const script = source('../scripts/tune-gradle.mjs')
  const firstIf = script.indexOf('if (!pg.includes(KEEP_MARKER))')
  const secondIf = script.indexOf('if (!pg.includes(KEEP_MARKER_V2))')
  assert.ok(firstIf > 0 && secondIf > firstIf)
  const between = script.slice(firstIf, secondIf)
  // The first `if` must have closed before the second check: count braces.
  const opens = (between.match(/\{/g) ?? []).length
  const closes = (between.match(/\}/g) ?? []).length
  assert.ok(closes >= opens, 'the v2 check must not be nested inside the v1 check')
})

/* ==================== E3: disk cache off the first frame ==================== */

test('E3: only small disk entries are read during the first render', () => {
  const disk = source('renderers/webview/diskCache.ts')
  const sync = disk.slice(disk.indexOf('export function readPrepared'), disk.indexOf('export async function readPreparedAsync'))
  const sizeCheck = sync.indexOf('> SYNC_READ_MAX_BYTES) return null')
  const read = sync.indexOf('textSync()')
  assert.ok(sizeCheck > 0 && read > sizeCheck, 'the size must be checked before the synchronous read')

  const async = disk.slice(disk.indexOf('export async function readPreparedAsync'))
  assert.ok(async.includes('await file.text()'), 'large entries are read asynchronously')
  assert.ok(/SYNC_READ_MAX_BYTES = 1_000_000/.test(disk))
})

test('E3: a large disk entry still beats a re-parse', () => {
  const renderer = source('renderers/WebViewRenderer.tsx')
  const disk = renderer.indexOf('await readPreparedAsync(file.id')
  const parse = renderer.indexOf('await prepareFile(file)')
  assert.ok(disk > 0 && parse > disk, 'the async disk read must come before preparing from scratch')
})

/* ==================== E4: backgrounding keeps the undo ==================== */

test('E4: backgrounding does not commit pending removals', () => {
  const lifecycle = source('ui/useAppLifecycle.ts')
  assert.doesNotMatch(lifecycle, /commitAll\(\)/, 'opening the file picker must not throw away the undo')
  assert.ok(lifecycle.includes('flushLibrarySave()'), 'the index is still flushed')
})

test('E4: removals a dead process left are hidden from the first frame, then finished', () => {
  const pending = source('store/pendingRemoval.ts')
  assert.ok(/hiddenIds: new Set\(markedIds\(\)\)/.test(pending), 'marked ids start hidden')
  // lastIndexOf: the interface declares `resumeInterrupted: () => void` first.
  const resume = pending.slice(pending.lastIndexOf('resumeInterrupted: () =>'))
  assert.ok(resume.indexOf('finishRemovals(entries)') < resume.indexOf('hiddenIds.delete(id)'), 'unhidden only after finishing')
})

/* ==================== E5: no ref captured by a worklet ==================== */

test('E5: the close worklet calls a stable function, not a captured ref', () => {
  const transition = source('components/ReaderTransition.tsx')
  const worklet = transition.slice(
    transition.indexOf('t.value = withTiming(0, Timing.exit'),
    transition.indexOf('}, [closing, reduced, t, finishClose])'),
  )
  assert.ok(worklet.length > 0)
  assert.doesNotMatch(worklet, /onClosedRef/, 'a ref captured by a worklet is frozen in development builds')
  assert.ok(worklet.includes('runOnJS(finishClose)()'))
  assert.ok(/const finishClose = useCallback\(\(\) => \{\s*onClosedRef\.current\(\)\s*\}, \[\]\)/.test(transition))
})
