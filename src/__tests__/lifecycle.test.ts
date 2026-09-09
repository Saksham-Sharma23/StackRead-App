import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { MAX_PREPARE_BYTES } from '../storage/formats.ts'
import { diffLibrary, shadowOf } from '../storage/libraryDiff.ts'
import { usePageNav } from '../store/pageNav.ts'
import { useSearch } from '../store/search.ts'
import type { FileEntry, Library } from '../types.ts'

/*
 * P8 — file-id lifetime.
 *
 * The bugs this phase fixed share a property that makes them nearly invisible:
 * every one of them is a *missing call*, not a wrong one. `forgetFile` was
 * well-written, well-commented and correct — and unreachable. Deleting a group
 * dropped its index entries and left the bytes. Restore invalidated nothing.
 *
 * Reading the code does not catch that class of fault, which is why the checks
 * below are mostly structural: they assert that a call site *exists*, in the
 * same spirit as `viewerHtml.test.ts` asserting the emitted script parses.
 * `expo-sqlite`, MMKV and `expo-file-system` cannot load under Node, so the
 * modules themselves cannot be imported here — the source is read instead.
 *
 * Structural tests are weaker than behavioural ones and are not a substitute
 * for the on-device verification listed in TASKS.md. They are, however, the
 * only thing that fails when someone deletes a call and the app still compiles.
 */

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

test('every id-keyed cache is invalidated by the lifecycle owner', () => {
  const lifecycle = source('storage/lifecycle.ts')

  // The five caches identified in the audit, plus `useSnippet`'s preview cache,
  // which was added later and registered in the same change. A seventh added
  // without a line here is the way this class of bug returns.
  for (const call of [
    'forgetPrepared',
    'forgetFile',
    'forgetSize',
    'resetThumbnailAttempt',
    'forgetPrefetchFailure',
    'forgetSnippet',
  ]) {
    assert.ok(
      lifecycle.includes(`${call}(fileId)`),
      `forgetFileEverywhere must call ${call} — a cache with no invalidation is how a restore serves the wrong document`,
    )
  }

  for (const call of [
    'clearPrepared',
    'clearSizeCache',
    'resetAllThumbnailAttempts',
    'resetPrefetchFailures',
    'forgetAllScroll',
    'clearSnippets',
  ]) {
    assert.ok(lifecycle.includes(`${call}()`), `resetAllCaches must call ${call}`)
  }

  /*
   * The two id-keyed *stores*, which is the form this rule was broken in.
   *
   * Being a Zustand store rather than a module-level Map is not an exemption —
   * both are keyed by file id, so both describe the wrong document after a
   * restore, which preserves ids by design. They survived four audits because
   * renderers call `forget()` on unmount, hiding the case that matters: a
   * restore while a reader is open.
   */
  /*
   * Matched per keyed map rather than as one pattern over the whole call.
   *
   * The obvious regex — `setState\(\{[^}]*byFile[^}]*toc` — cannot work: each
   * value is itself `{}`, so `[^}]*` stops at the first one and the assertion
   * fails on correct code. Naming the maps individually also gives a precise
   * failure when a *new* keyed map is added to either store and missed here,
   * which is the case this test exists to catch.
   */
  const pageNavReset = /usePageNav\.setState\(\{([\s\S]*?)\}\)/.exec(lifecycle)?.[1] ?? ''
  for (const map of ['byFile', 'jump', 'hrefJump', 'toc']) {
    assert.ok(
      pageNavReset.includes(`${map}:`),
      `resetAllCaches must clear usePageNav.${map} — a survivor describes the document that id used to hold`,
    )
  }

  const searchReset = /useSearch\.setState\(\{([\s\S]*?)\}\)/.exec(lifecycle)?.[1] ?? ''
  for (const map of ['byFile', 'request', 'step']) {
    assert.ok(
      searchReset.includes(`${map}:`),
      `resetAllCaches must clear useSearch.${map} — a survivor counts matches in bytes that are gone`,
    )
  }

  // The bar's own state is not keyed by file and must not be swept up with the
  // maps: a restore invalidates documents, not the search UI.
  assert.ok(
    !/\bopen:/.test(searchReset) && !/\bquery:/.test(searchReset),
    'resetAllCaches must not close the search bar — `open` and `query` describe the UI, not any file',
  )
})

/*
 * Q1 — the two id-keyed stores.
 *
 * Unlike the rest of this file these are behavioural, not structural: both
 * stores are pure Zustand with no native imports, so they load under Node and
 * the real reducers can be exercised. Where that is possible it is strictly
 * better — a structural test only proves a call was written.
 *
 * `lifecycle.ts` itself still cannot be imported here (it reaches MMKV,
 * expo-file-system and expo-sqlite transitively), so the wiring that calls
 * these remains covered structurally above.
 */

test('clearing the keyed maps drops every file, whatever populated them', () => {
  const nav = usePageNav.getState()

  // Four files, each reaching the store by a different route — so this cannot
  // pass by clearing only the map the obvious path happens to write.
  nav.report('reported', 3, 120, { label: 'iii', percent: 2 })
  nav.requestJump('jumped', 42)
  nav.requestHref('chaptered', 'ch7.xhtml#start')
  nav.setToc('tocd', [{ title: 'One', href: 'ch1.xhtml', depth: 0 }])

  const search = useSearch.getState()
  search.report('found', { query: 'whale', total: 9, current: 1 })
  search.submit('asked', 'whale')
  search.stepMatch('stepped', 1)

  // What `resetAllCaches` does, applied directly: the module cannot be imported
  // under Node, so the operation is reproduced rather than called.
  usePageNav.setState({ byFile: {}, jump: {}, hrefJump: {}, toc: {} })
  useSearch.setState({ byFile: {}, request: {}, step: {} })

  const after = usePageNav.getState()
  assert.deepEqual(after.byFile, {}, 'a surviving position describes a replaced document')
  assert.deepEqual(after.jump, {}, 'a surviving jump would seek the new document to the old page')
  assert.deepEqual(after.hrefJump, {}, 'a surviving href jump would seek to a chapter that no longer exists')
  assert.deepEqual(after.toc, {}, 'a surviving TOC is the previous book’s chapter list')

  const searchAfter = useSearch.getState()
  assert.deepEqual(searchAfter.byFile, {}, 'a surviving result counts matches in bytes that are gone')
  assert.deepEqual(searchAfter.request, {})
  assert.deepEqual(searchAfter.step, {})
})

test('the search bar’s own state survives a reset, because it is not keyed by file', () => {
  useSearch.setState({ open: true, query: 'whale' })
  useSearch.getState().report('f1', { query: 'whale', total: 4, current: 1 })

  useSearch.setState({ byFile: {}, request: {}, step: {} })

  const after = useSearch.getState()
  assert.equal(after.open, true, 'a restore invalidates documents, not the bar the user has open')
  assert.equal(after.query, 'whale')
  assert.deepEqual(after.byFile, {})

  // Left as found, so ordering between tests in this file cannot matter.
  useSearch.setState({ open: false, query: '' })
})

test('forget() drops a file whose only entry is a chapter jump', () => {
  const nav = usePageNav.getState()

  /*
   * The leak Q1-2 fixed, as behaviour.
   *
   * `hrefJump` was deleted in `forget`'s body but missing from its early-return
   * guard, so this exact sequence — open a book, tap a chapter, close — left an
   * entry behind for the life of the process. Jumping to a chapter and nothing
   * else is the only way to populate `hrefJump` alone, which is why it went
   * unnoticed.
   */
  nav.requestHref('chapter-only', 'ch3.xhtml#s2')
  assert.ok('chapter-only' in usePageNav.getState().hrefJump, 'precondition: the entry exists')

  nav.forget('chapter-only')

  assert.ok(
    !('chapter-only' in usePageNav.getState().hrefJump),
    'a file that only ever received a chapter jump must still be forgotten',
  )
})

test('forget() still clears every map for a file that reached all of them', () => {
  const nav = usePageNav.getState()

  nav.report('everything', 5, 200)
  nav.requestJump('everything', 5)
  nav.requestHref('everything', 'ch1.xhtml')
  nav.setToc('everything', [{ title: 'One', href: 'ch1.xhtml', depth: 0 }])

  nav.forget('everything')

  const s = usePageNav.getState()
  for (const [name, map] of [
    ['byFile', s.byFile],
    ['jump', s.jump],
    ['hrefJump', s.hrefJump],
    ['toc', s.toc],
  ] as const) {
    assert.ok(!('everything' in map), `${name} must not outlive the renderer that reported it`)
  }
})

test('forget() on an unknown file changes nothing', () => {
  usePageNav.setState({ byFile: {}, jump: {}, hrefJump: {}, toc: {} })
  const before = usePageNav.getState()

  usePageNav.getState().forget('never-seen')

  // The guard is an optimisation: an unknown id must take the early return and
  // leave the existing map references untouched, or every unmount allocates
  // four new objects and re-renders every subscriber.
  const after = usePageNav.getState()
  assert.equal(after.byFile, before.byFile, 'an unknown id must not allocate a new map')
  assert.equal(after.jump, before.jump)
  assert.equal(after.hrefJump, before.hrefJump)
  assert.equal(after.toc, before.toc)
})

test('committing a removal forgets the file everywhere, not just its parsed copy', () => {
  const pending = source('store/pendingRemoval.ts')

  assert.ok(
    pending.includes('forgetFileEverywhere(fileId)'),
    'commit must clear every id-keyed cache; forgetPrepared alone leaked three MMKV keys per deleted file, permanently',
  )
  assert.ok(
    pending.includes('forgetFileEverywhere(id)'),
    'resumeInterrupted must do the same for removals finished after a process kill',
  )
})

test('reload drops every cache before re-reading', () => {
  const store = source('store/library.ts')

  assert.ok(
    /reload:[\s\S]{0,900}?resetAllCaches\(\)/.test(store),
    'reload is the restore path; an export preserves file ids, so stale caches point at replaced bytes',
  )
})

test('deleting a group routes its files through the undo path', () => {
  const screen = source('screens/LibraryScreen.tsx')

  assert.ok(
    screen.includes('queueGroupRemoval('),
    'group deletion must queue its files for removal — the store only drops index entries, so nothing else deletes the bytes',
  )
  assert.ok(
    !/onPress: \(\) => removeGroup\(group\.id\)/.test(screen),
    'the bare removeGroup call is the bug: it stranded every file of the group on disk',
  )
})

test('the group-deletion comment no longer asserts an obligation nobody has', () => {
  const store = source('store/library.ts')

  // Matched as the original comment line, not as a substring: the replacement
  // text quotes the old wording to explain what it replaced, and a test that
  // cannot tell an explanation from the thing it explains is a test that
  // punishes documenting the fix.
  assert.ok(
    !/^\s*\/\/ Files in a removed group go with it; callers delete the bytes\.$/m.test(store),
    'that comment described a contract the single caller never honoured, which is worse than no comment',
  )
})

test('a batch removal is undone as a whole', () => {
  const pending = source('store/pendingRemoval.ts')

  assert.ok(
    pending.includes('batchId'),
    'group deletions share a batch id so one toast represents them',
  )
  assert.ok(
    /undo:[\s\S]{0,1200}?p\.batchId === batch/.test(pending),
    'undoing any member of a batch must restore all of it — half a restored group is a state the user cannot get out of',
  )
})

test('every format that loads bytes into JS has a size ceiling', () => {
  // EPUB streams chapter by chapter and budgets its own images; PDF and image
  // are drawn by native views straight from disk and never reach JS.
  for (const format of ['text', 'markdown', 'html', 'docx', 'xlsx', 'csv', 'comic', 'archive']) {
    const limit = MAX_PREPARE_BYTES[format as FileEntry['format']]
    assert.equal(typeof limit, 'number', `${format} must declare a ceiling`)
    assert.ok(limit! > 0, `${format} ceiling must be positive`)
  }

  assert.equal(
    MAX_PREPARE_BYTES.pdf,
    undefined,
    'PDF is rendered natively from disk and must not be gated on a JS read limit',
  )
  assert.equal(MAX_PREPARE_BYTES.image, undefined, 'images are rendered natively too')
})

test('the size ceiling is checked before the file is read', () => {
  const prepare = source('renderers/webview/prepare.ts')

  const guard = prepare.indexOf('MAX_PREPARE_BYTES[entry.format]')
  assert.ok(guard > 0, 'prepareFile must consult the per-format ceiling')

  /*
   * The reads now live in `prepareByFormat`, which `prepareFile` calls only
   * after the guard — so the property is expressed structurally rather than by
   * textual ordering alone, and both halves are asserted.
   *
   * The earlier version of this test matched `await target.bytes()` at each of
   * the seven branches. That stopped matching when the branches were changed to
   * go through one timed helper (R0-1), and it is worth being clear that the
   * test was right to fail: it had been pinned to *how* the reads were spelled
   * rather than to *when* they happen. What follows pins the latter.
   */
  const dispatch = prepare.indexOf('async function prepareByFormat')
  assert.ok(dispatch > 0, 'the format switch must be reachable as its own function')
  assert.ok(
    guard < dispatch,
    'the ceiling is checked in prepareFile, before the switch that reads anything',
  )

  /*
   * Compared against the first read that is *code*.
   *
   * A plain `indexOf('await target.bytes()')` finds the phrase inside the
   * comment above the guard explaining which formats used to reach it
   * unguarded — so the naive version of this test fails on correct code and
   * would be "fixed" by deleting the explanation.
   */
  const reads = [...prepare.matchAll(/^\s+const \w+ = await target\.(?:bytes|text)\(\)/gm)]
  assert.ok(reads.length >= 2, 'prepareFile must actually read the file somewhere')
  assert.ok(
    guard < reads[0].index!,
    'the check must precede every read — as a per-branch check it missed DOCX, XLSX, CBZ and ZIP entirely',
  )

  /*
   * No branch may reach around the funnel.
   *
   * With every read behind `readBytes()`, a future format added with its own
   * `await target.bytes()` inline would be both untimed and — if it were ever
   * added above the guard — unguarded. There should be exactly one bytes read
   * in the whole file.
   *
   * Anchored to a code-shaped line, for the reason given above: an unanchored
   * match also finds the phrase inside the explanatory comment — the same trap,
   * walked into twice.
   */
  const byteReads = [...prepare.matchAll(/^\s+const \w+ = await target\.bytes\(\)/gm)]
  assert.equal(
    byteReads.length,
    1,
    'every branch reads through the one helper, so a new format cannot read unguarded',
  )
})

test('lastScroll and lastProgress are compared, so an exported position persists', () => {
  const base: FileEntry = {
    id: 'f1',
    name: 'a.epub',
    storedName: 'f1.epub',
    format: 'epub',
    groupId: 'g1',
    orderInGroup: 0,
    addedAt: 1,
  }
  const lib = (files: FileEntry[]): Library => ({ groups: [], files })

  const withScroll = diffLibrary(shadowOf(lib([base])), lib([{ ...base, lastScroll: 4200 }]))
  assert.equal(
    withScroll.filesUpserted.length,
    1,
    'a changed lastScroll must be written, or an exported position never reaches the index',
  )

  const withProgress = diffLibrary(shadowOf(lib([base])), lib([{ ...base, lastProgress: 63 }]))
  assert.equal(withProgress.filesUpserted.length, 1, 'a changed lastProgress must be written')

  // The guard `hashFile`'s own docstring asks for: a field absent from the
  // hash is a field whose changes silently never persist.
  const unchanged = diffLibrary(
    shadowOf(lib([{ ...base, lastScroll: 10, lastProgress: 5 }])),
    lib([{ ...base, lastScroll: 10, lastProgress: 5 }]),
  )
  assert.equal(unchanged.filesUpserted.length, 0, 'an unchanged entry must not be rewritten')
})

test('a backup carries reading positions in both directions', () => {
  const backup = source('storage/backup.ts')

  assert.ok(
    backup.includes('withPositions'),
    'export must stamp positions onto entries — MMKV is not in the archive',
  )
  assert.ok(
    backup.includes('setScroll(file.id, file.lastScroll)'),
    'restore must write positions back into MMKV, which is what the renderers actually read',
  )

  const write = backup.indexOf('setScroll(file.id, file.lastScroll)')
  const replace = backup.indexOf('replaceLibrary(library)')
  assert.ok(
    write < replace,
    'positions must land before the rows, or the board paints 0% and then jumps',
  )
})

test('restoring an archive written before positions existed still works', () => {
  const backup = source('storage/backup.ts')

  // Guarded on the field being a number rather than truthy or merely present,
  // so an older archive restores without them instead of throwing.
  assert.ok(
    backup.includes("typeof file.lastScroll === 'number'"),
    'an archive with no positions must restore without them',
  )
})

/*
 * P12-3 — windowed group rows.
 *
 * The component cannot be rendered under Node, so these check the invariants
 * that make the window safe rather than that it draws: the window must be a
 * prefix (so a card's index still addresses the full list), and the drag bounds
 * must stay the true group size.
 */

test('a windowed row mounts a prefix, so card indices still address the full list', () => {
  const src = source('components/GroupRow.tsx')

  /*
   * `slice(0, windowSize)` and nothing else. Any window that is not a prefix —
   * a centred window, a paged one — breaks `index={i}`, because the card's
   * index is what `reorderWithinGroup` uses to move it in the real array. A
   * drag would then reorder the wrong file, silently.
   */
  assert.ok(
    /files\.slice\(0, windowSize\)/.test(src),
    'the window must be a prefix of the group',
  )
  assert.ok(
    /index=\{i\}/.test(src),
    'cards are indexed by their position in the visible prefix, which equals their real index',
  )
})

test('drag bounds use the true group size, not the window', () => {
  const src = source('components/GroupRow.tsx')

  // `count` is what clamps a drag to [0, count-1]. Passing the window size
  // would make the last cards of a long row undraggable past the window edge.
  assert.ok(
    /count=\{files\.length\}/.test(src),
    'a drag must be bounded by the whole group, not by what is mounted',
  )
})

test('the window resets when the row changes identity', () => {
  const src = source('components/GroupRow.tsx')

  // Without this, expanding one long row and switching groups leaves the next
  // row mounted at the expanded size — paying the cost for a row nobody
  // expanded.
  assert.ok(
    /useEffect\(\(\) => setWindowSize\(INITIAL_WINDOW\), \[group\.id\]\)/.test(src),
    'the window must reset per group',
  )
})

test('the row still uses a plain ScrollView', () => {
  const src = source('components/GroupRow.tsx')

  /*
   * P3-4 virtualized the vertical axis only, on the explicit reasoning that
   * nesting a virtualized list inside another costs more than it saves. The
   * window exists so that decision can stand at large row sizes — it must not
   * quietly become the thing it was avoiding.
   */
  assert.ok(src.includes('<ScrollView'), 'the row must stay a plain ScrollView')

  // Matched as JSX, not as prose: the docstring legitimately mentions the
  // FlatList on the vertical axis while explaining why this row is not one.
  assert.ok(
    !/<(FlatList|FlashList)/.test(src),
    'the row must not become a nested virtualized list',
  )
})

/*
 * R6-1 — the chunked orphan walk.
 *
 * Both checks below guard silent failures. Neither shows up as an error: the
 * first deletes a file the user just imported, the second disables orphan
 * cleanup entirely while still writing the "completed" timestamp. Both are
 * invisible on a small library and only appear at scale.
 */
test('the chunked prune re-reads live entries at every slice boundary', () => {
  const files = source('storage/files.ts')

  assert.match(
    files,
    /async function pruneOrphansChunked\(liveEntries: \(\) => FileEntry\[\]\)/,
    'the chunked walk must take a function, not a captured list — it yields, so a snapshot goes stale',
  )

  const body = files.slice(files.indexOf('async function pruneOrphansChunked'))
  const loop = body.slice(body.indexOf('for (const item of items)'))
  const yieldPoint = loop.indexOf('await new Promise')
  assert.ok(yieldPoint > 0, 'the walk must yield inside the loop')

  const afterYield = loop.slice(yieldPoint, loop.indexOf('const name = item.name'))
  assert.ok(
    afterYield.includes('liveEntries()'),
    'entries must be re-read after each yield, or an import during the walk is deleted as an orphan',
  )
  assert.ok(
    afterYield.includes('keepFrom('),
    'the keep set must be rebuilt from the re-read entries, not left stale',
  )
  assert.ok(
    afterYield.includes('if (!entries.length) return'),
    'the empty-library interlock must be re-checked per slice, not only before the walk',
  )
})

test('the prune is scheduled only after the store holds the loaded files', () => {
  const store = source('store/library.ts')

  const setAt = store.indexOf('loaded: true })')
  const scheduleAt = store.indexOf('schedulePruneOrphans(')
  assert.ok(setAt > 0 && scheduleAt > 0, 'both call sites must exist')
  assert.ok(
    scheduleAt > setAt,
    'scheduling before `set` makes the interlock read an empty store, which silently ' +
      'disables pruning forever while still recording the pass as done',
  )
})
