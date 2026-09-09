import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { buildViewerHtml } from '../renderers/webview/viewerHtml.ts'

/*
 * P9 — perceived speed.
 *
 * Two of the four tasks are testable off-device in a real sense, and two are
 * not. The split is worth stating plainly rather than pretending otherwise:
 *
 *  - **P9-4 (cached scrollHeight)** is pure browser-side logic inside the
 *    viewer's template literal, so the emitted function can be extracted and
 *    *executed* against a stubbed DOM — the strongest check available here, and
 *    the same technique `viewerHtml.test.ts` uses.
 *  - **P9-2 (disk cache)** has a pure decision — *what* is worth persisting —
 *    which is tested directly. Its file I/O needs `expo-file-system` and so
 *    cannot run under Node.
 *  - **P9-1 (ThumbHash cover)** and **P9-3 (PDF covers)** are React components
 *    over native views. Only their wiring is checked structurally; whether they
 *    actually paint is a device question.
 */

const THEME = {
  bg: '#000',
  fg: '#fff',
  fgDim: '#888',
  accent: '#09f',
  border: '#333',
  surfaceAlt: '#111',
  surface: '#222',
  gutter: '#0a0a0a',
}

function viewerScript(): string {
  const html = buildViewerHtml(THEME, 0)
  const match = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(match, 'viewer HTML contains no script block')
  return match[1]
}

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

/**
 * Extracts the real `progress()` and runs it against a stubbed window.
 *
 * `scrollRange` is exposed so a test can simulate `measure()` having run, and
 * the stub counts reads of `document.body.scrollHeight` — which is the whole
 * point: the assertion is that the per-frame path performs **zero** of them.
 */
function progressHarness() {
  const js = viewerScript()
  const src = js.slice(js.indexOf('  function progress()'), js.indexOf('  /**\n   * The anchor array'))
  assert.ok(src.includes('scrollRange'), 'progress() no longer reads the cached range')

  const layoutReads = { count: 0 }
  const state = { scrollY: 0, scrollRange: 0 }

  const factory = new Function(
    'deps',
    `
    var scrollRange = 0;
    var window = deps.window;
    var document = deps.document;
    ${src}
    return {
      progress: progress,
      setRange: function (v) { scrollRange = v; },
    };
    `,
  ) as (deps: Record<string, unknown>) => {
    progress: () => number
    setRange: (v: number) => void
  }

  const api = factory({
    window: {
      get scrollY() {
        return state.scrollY
      },
      innerHeight: 800,
    },
    document: {
      body: {
        // Any read from the per-frame path is a regression: this property is
        // what forces the browser to flush layout.
        get scrollHeight() {
          layoutReads.count += 1
          return 10_000
        },
      },
    },
  })

  return { ...api, state, layoutReads }
}

test('progress() never touches scrollHeight, so a scroll frame forces no layout', () => {
  const { progress, setRange, state, layoutReads } = progressHarness()

  setRange(9_200)
  state.scrollY = 4_600

  // A flick is hundreds of these. Each `scrollHeight` read would be a forced
  // synchronous layout — the expensive half of the scroll handler, and the part
  // that survived the change which stopped *posting* unchanged frames.
  for (let i = 0; i < 120; i++) progress()

  assert.equal(
    layoutReads.count,
    0,
    'progress() read document.body.scrollHeight; that forces a layout flush on every scroll frame',
  )
})

test('progress() still computes the right fraction from the cached range', () => {
  const { progress, setRange, state } = progressHarness()

  setRange(1_000)

  state.scrollY = 0
  assert.equal(progress(), 0, 'top of the document is 0')

  state.scrollY = 500
  assert.equal(progress(), 0.5, 'halfway through the range is 0.5')

  state.scrollY = 1_000
  assert.equal(progress(), 1, 'the end is 1')
})

test('progress() clamps rather than reporting past the ends', () => {
  const { progress, setRange, state } = progressHarness()
  setRange(1_000)

  // Overscroll produces a negative offset on Android and one past the end at
  // the bottom; neither should escape 0..1 and reach the page indicator.
  state.scrollY = -220
  assert.equal(progress(), 0)

  state.scrollY = 4_000
  assert.equal(progress(), 1)
})

test('a document shorter than the screen reports 0 rather than dividing by zero', () => {
  const { progress, setRange, state } = progressHarness()

  // `measure()` computes scrollHeight - innerHeight, which is <= 0 here.
  setRange(0)
  state.scrollY = 0
  assert.equal(progress(), 0)

  setRange(-400)
  assert.equal(progress(), 0, 'a negative range must not produce a negative percentage')
})

test('measure() is what refreshes the cached range', () => {
  const js = viewerScript()

  // The cache is only correct if every path that changes layout re-measures.
  // measure() already forces layout by reading offsetTop, so the read is free
  // there and must not appear anywhere else.
  /*
   * Sliced from `measureImpl`, which is where the work is.
   *
   * `measure()` is now a thin wrapper that times the call (R0-1) and forwards
   * an incremental flag (R3-1). Slicing from it used to reach the body; it now
   * stops at the wrapper's closing brace, so this assertion started failing on
   * code that is still correct. The property is unchanged — the range must be
   * refreshed wherever layout is forced — only its address moved.
   */
  const measureBody = js.slice(js.indexOf('function measureImpl('), js.indexOf('function totalPages('))
  assert.ok(
    measureBody.includes('scrollRange = document.body.scrollHeight'),
    'measure() must refresh the cached scroll range',
  )

  /*
   * Counted as *code*, not as text.
   *
   * The comments explaining why this is cached naturally mention the property
   * by name, and a test that cannot tell an explanation from the thing it
   * explains would be "fixed" by deleting the explanation. So comment lines are
   * stripped before counting.
   */
  const code = js
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
    })
    .join('\n')

  const reads = [...code.matchAll(/document\.body\.scrollHeight/g)]
  assert.equal(
    reads.length,
    1,
    'scrollHeight should be read in exactly one place — measure() — and cached everywhere else',
  )
})

test('the settle loop re-measures once the layout it waited for has landed', () => {
  const js = viewerScript()
  const settle = js.slice(js.indexOf('(function settle()'), js.indexOf('reportPosition(true);\n    }'))

  // The loop exists because layout is still growing. The range measured before
  // it is therefore short, and a restored position would read as further
  // through the book than it is.
  assert.ok(
    /Math\.abs\(window\.scrollY - target\) <= 2\)\s*\{[\s\S]*?measure\(\)/.test(settle),
    'settling on a restored position must refresh the cached range',
  )
})

test('the viewer still parses after the caching change', () => {
  // The file is one template literal, so an edit can produce a perfectly valid
  // TypeScript string containing broken JavaScript. This is the only cheap
  // check that catches it — and it caught a raw backtick during P9-4.
  assert.doesNotThrow(() => new Function(viewerScript()))
})

test('the disk cache refuses to persist documents carrying images', () => {
  const disk = source('renderers/webview/diskCache.ts')

  /*
   * Images are `Uint8Array`s that do not survive JSON, and persisting them
   * would store a second copy of bytes already in the original file — undoing
   * the blob-streaming work that keeps the HTML proportional to the text.
   */
  assert.ok(
    /if \(prepared\.images && prepared\.images\.length\) return/.test(disk),
    'writePrepared must decline entries with images',
  )
  assert.ok(
    /if \(prepared\.images && prepared\.images\.length\) return null/.test(disk),
    'readPrepared must ignore an entry that somehow carries images',
  )
})

test('a disk cache key changes when the file bytes change', () => {
  const disk = source('renderers/webview/diskCache.ts')

  // Ids are reused by design — an export preserves them, and a re-import writes
  // new bytes under an existing id. Size and mtime in the name are what stop a
  // replaced file reading the previous parse.
  assert.ok(
    /return `\$\{fileId\}-\$\{size\}-\$\{mtime\}\.json`/.test(disk),
    'the entry name must include size and mtime, or a replaced file reads a stale parse',
  )
})

test('the disk cache is bounded and versioned', () => {
  const disk = source('renderers/webview/diskCache.ts')

  assert.ok(/MAX_TOTAL_BYTES/.test(disk), 'the directory must have a budget')
  assert.ok(/MAX_ENTRY_BYTES/.test(disk), 'a single entry must have a ceiling')
  assert.ok(/FORMAT_VERSION/.test(disk), 'the serialised shape must be versioned')
  assert.ok(
    /envelope\.v !== FORMAT_VERSION/.test(disk),
    'an entry from an older shape must be ignored rather than trusted',
  )
})

test('the disk cache is owned by the file-id lifecycle module', () => {
  const lifecycle = source('storage/lifecycle.ts')

  // P8 established that every cache keyed by file id is invalidated in one
  // place. A sixth cache added without a line there is how that bug returns —
  // and this is the sixth.
  assert.ok(
    lifecycle.includes('forgetPreparedOnDisk(fileId)'),
    'deleting a file must drop its persisted parse',
  )
  assert.ok(
    lifecycle.includes('clearPreparedOnDisk()'),
    'a restore must drop every persisted parse',
  )
})

test('a disk hit is promoted into the memory cache', () => {
  const renderer = source('renderers/WebViewRenderer.tsx')

  // Without promotion, a file swiped away from and back to would read the disk
  // every time and the pinned window — which exists to make that free — would
  // never hold it.
  assert.ok(
    /function readPreparedFromDisk[\s\S]*?setPrepared\(fileId, hit\)/.test(renderer),
    'a disk hit must populate the memory cache',
  )
  /*
   * The order is asserted inside the helper, not at the call sites.
   *
   * This used to match the whole expression literally at a call site, which
   * meant it failed the moment Q4-2 extracted the duplicated read into
   * `readCached()` — even though the invariant it protects was untouched. The
   * lookup order is the thing that matters, and it now lives in exactly one
   * place, which is the point of the extraction.
   */
  assert.ok(
    /function readCached[\s\S]*?getPrepared\(fileId\) \?\? readPreparedFromDisk\(fileId, storedName\)/.test(
      renderer,
    ),
    'memory must be consulted before disk, and both before parsing',
  )

  // And nothing may bypass it by re-inlining the pair at a call site, which is
  // how the two copies drifted in the first place.
  assert.ok(
    !renderer.includes('getPrepared(file.id) ?? readPreparedFromDisk'),
    'call sites must go through readCached() rather than re-inlining the lookup',
  )
})

test('a fresh parse is persisted from both the open and prefetch paths', () => {
  assert.ok(
    source('renderers/WebViewRenderer.tsx').includes('writePrepared(file.id,'),
    'opening a file must persist its parse',
  )
  assert.ok(
    source('renderers/webview/prefetch.ts').includes('writePrepared(file.id,'),
    'a speculative parse must survive backgrounding too, or the work is thrown away',
  )
})

test('the reader holds its loading cover until content is measured, not merely posted', () => {
  const renderer = source('renderers/WebViewRenderer.tsx')

  /*
   * `payload` means the document has been *posted*; `rendered` means it is in
   * the DOM and measured. Uncovering at `payload` shows a blank white page for
   * the frames in between — the exact gap this component exists to fill.
   */
  assert.ok(
    renderer.includes('{!rendered && active && <LoadingCover'),
    'the cover must be held until the viewer reports ready',
  )
  assert.ok(
    !/ActivityIndicator/.test(renderer),
    'the bare spinner should be gone; LoadingCover owns that state now',
  )
})

test('both renderers show the same loading treatment', () => {
  for (const path of ['renderers/WebViewRenderer.tsx', 'renderers/PdfRenderer.tsx']) {
    const src = source(path)
    assert.ok(src.includes('<LoadingCover'), `${path} must use the shared loading cover`)
    assert.ok(
      src.includes('thumbhash={file.thumbhash}'),
      `${path} must pass the ThumbHash, or the cover is just a spinner again`,
    )
  }
})

test('the loading cover degrades without a ThumbHash', () => {
  const cover = source('components/LoadingCover.tsx')

  // Most files have a hash, but a DOCX or spreadsheet never will. The spinner
  // has to stand alone rather than the component rendering an empty image.
  assert.ok(/thumbhash \? \(/.test(cover), 'the placeholder must be conditional')
  assert.ok(/ActivityIndicator/.test(cover), 'the spinner must render in both cases')
})

test('the PDF cover factory keeps one document live at a time', () => {
  const factory = source('components/PdfCoverFactory.tsx')

  /*
   * The pager mounts exactly one PDF because three live pdfium documents
   * crashed inside FPDF_LoadPage when one was unmounted mid-render. A cover
   * factory that mounted several would reintroduce that, on the board.
   */
  assert.ok(/busy\.current/.test(factory), 'the factory must serialise its captures')
  assert.ok(
    /if \(!enabled \|\| busy\.current \|\| target\) return/.test(factory),
    'no capture may start while one is in flight',
  )
  assert.ok(
    /setTarget\(null\)[\s\S]{0,120}busy\.current = false/.test(factory),
    'the document must be unmounted before the slot is released',
  )
})

test('the PDF cover factory stands down while the reader is open', () => {
  const factory = source('components/PdfCoverFactory.tsx')
  const screen = source('screens/LibraryScreen.tsx')

  assert.ok(
    /if \(!enabled && target\)/.test(factory),
    'an in-flight capture must be abandoned when disabled',
  )
  // LibraryScreen unmounts while the reader is open, which is the real guard —
  // but the explicit prop keeps it from running during an import or a restore.
  // Matched on the element and its prop separately rather than on one line of
  // JSX: R6-2 added a third prop and the element is now formatted across lines.
  const mount = screen.slice(screen.indexOf('<PdfCoverFactory'))
  assert.ok(
    mount.startsWith('<PdfCoverFactory') && mount.includes('fileIds={pdfsNeedingCovers}'),
    'the factory must be mounted on the board, not at the app root',
  )
})

test('the cover factory is driven by ids so its own writes do not re-drive it', () => {
  const selectors = source('store/selectors.ts')

  /*
   * The factory's job is to call `setThumb`. A selector returning entries would
   * see every one of those writes and re-run the effect that produced them —
   * the same shape as the thumbnail-effect churn found in the second audit.
   */
  assert.ok(
    /export function usePdfsNeedingCovers\(\): string\[\]/.test(selectors),
    'the selector must return ids, not entries',
  )

  /*
   * The identity guarantee moved, so this assertion had to move with it.
   *
   * It used to require `useShallow` within 400 characters of the function —
   * which passed for the wrong reason the moment the list became a maintained
   * store value: the match was landing on `useGroupPreviews`' docstring two
   * functions below, so the test asserted nothing at all while still going
   * green. A source-grep test that can be satisfied by a neighbouring comment
   * is worse than no test, because it reports coverage it does not have.
   *
   * The property itself is unchanged — the factory must not be handed a new
   * array when nothing changed — and it now lives in `dropIds`, which is pure
   * and tested behaviourally in `derived.test.ts` rather than by pattern.
   */
  assert.ok(
    /return useLibrary\(\(s\) => s\.pdfsNeedingCovers\)/.test(selectors),
    'the list must be read from the store, not rebuilt by a scanning selector',
  )
  assert.doesNotMatch(
    selectors,
    /usePdfsNeedingCovers\(\): string\[\] \{[\s\S]{0,200}Object\.keys/,
    'a scan over every file is the O(n)-per-mutation shape this replaced',
  )
})

test('the factory skips files a generator would decline anyway', () => {
  const factory = source('components/PdfCoverFactory.tsx')

  // Mounting a native view per candidate is far too expensive to spend on a
  // file `captureFirstPage` would refuse on its first line.
  assert.ok(
    factory.includes('hasAttemptedThumbnail(id)'),
    'the factory must consult the session-wide attempted set before mounting anything',
  )
})

/*
 * Q2 — re-render discipline.
 *
 * Structural, for the usual reason: the screen is a React component over native
 * views and cannot be rendered under Node. What these pin is the *shape* that
 * makes the memo real — every prop the list receives being a stable reference —
 * because the failure mode is silent. `GroupRow` was wrapped in `memo()` for
 * four audits while the call site defeated it completely, and nothing broke,
 * got slower in a way anyone could point at, or failed a test.
 */

test('the board passes no freshly-allocated props to its rows', () => {
  const screen = source('screens/LibraryScreen.tsx')

  /*
   * The three row callbacks, as identifiers rather than inline arrows.
   *
   * `onFileMenu={(file) => setSheet(...)}` allocates a new function per row per
   * render, so `memo()`'s shallow comparison fails every time and every mounted
   * row re-renders on every parent state change — each search keystroke, each
   * sheet toggle, each import.
   */
  for (const prop of ['onFileMenu', 'onAddFiles', 'onGroupMenu', 'onOpenFile']) {
    // A plain substring rather than a constructed regex: the pattern is two
    // regex metacharacters (`{`, `(`) and building it from a template literal
    // is how this test first went in broken.
    assert.ok(
      !screen.includes(`${prop}={(`),
      `${prop} must be a hoisted callback, not an inline arrow — an inline one makes GroupRow's memo() dead`,
    )
  }

  // `renderItem` itself: FlatList re-renders rows when it changes identity,
  // regardless of what the row props compare to. Both halves must be stable.
  assert.ok(
    /renderItem=\{renderGroup\}/.test(screen),
    'renderItem must be a memoised callback, not inline JSX',
  )

  // The object and element props, which have the same failure mode.
  assert.ok(
    /contentContainerStyle=\{listContentStyle\}/.test(screen),
    'contentContainerStyle must be hoisted — an inline object is a new identity per render',
  )
  assert.ok(
    /ListHeaderComponent=\{listHeader\}/.test(screen),
    'the header holds the search field and must not be re-created while it is typed into',
  )
  assert.ok(
    /ListFooterComponent=\{listFooter\}/.test(screen),
    'the footer must be hoisted for the same reason as the header',
  )
  assert.ok(
    /keyExtractor=\{groupKey\}/.test(screen),
    'keyExtractor must be a stable reference',
  )
})

test('the import handler does not depend on values that change on every mutation', () => {
  const screen = source('screens/LibraryScreen.tsx')

  /*
   * `handleAddFiles` is passed to every row, so its identity decides whether the
   * memo holds. Depending on `groupCounts` — a new object on *every* library
   * mutation — or on `importing` would mint a new function exactly when the
   * board is busiest, which is when the memo matters most.
   *
   * Both are read through refs instead, so the handler sees current values
   * without being re-created.
   */
  const deps = /const handleAddFiles = useCallback\(([\s\S]*?)\n  \)/.exec(screen)?.[1] ?? ''
  assert.ok(deps.length > 0, 'handleAddFiles must be a useCallback')
  assert.ok(
    /\[addFiles\],\s*$/.test(deps.trimEnd()),
    'handleAddFiles must depend only on the (stable) zustand action — groupCounts and importing belong in refs',
  )
  assert.ok(
    screen.includes('groupCountsRef.current[groupId]'),
    'the file count must be read through a ref at tap time, not captured as a dependency',
  )
  assert.ok(
    screen.includes('if (importingRef.current) return'),
    'the re-entrancy guard must read the ref, or `importing` becomes a dependency again',
  )
})

test('the library search is debounced, and an empty query clears immediately', () => {
  const screen = source('screens/LibraryScreen.tsx')

  /*
   * `searchFiles` is a blocking FTS5 query on the JS thread and was wired
   * straight to `onChangeText` — one synchronous SQLite round trip per
   * character, on the thread that also has to paint that character.
   */
  assert.ok(
    /const SEARCH_DEBOUNCE_MS = \d+/.test(screen),
    'the debounce interval must be a named constant',
  )

  const runSearch = /const runSearch = useCallback\(([\s\S]*?)\n  \}, \[\]\)/.exec(screen)?.[1] ?? ''
  assert.ok(runSearch.length > 0, 'runSearch must still be a stable callback')

  // The query text stays synchronous: the input is controlled, so deferring it
  // would make the field lag the keyboard and drop characters.
  const setQueryAt = runSearch.indexOf('setSearchQuery(text)')
  assert.ok(setQueryAt >= 0, 'the typed text must be applied immediately')

  // The query itself is deferred.
  assert.ok(
    /setTimeout\([\s\S]*?searchFiles\(text\)[\s\S]*?SEARCH_DEBOUNCE_MS\)/.test(runSearch),
    'searchFiles must run behind the debounce, not on every keystroke',
  )

  /*
   * An empty field clears synchronously and cancels anything pending. A field
   * the user has just emptied that still shows the previous results reads as a
   * bug — and it is the one case where the work is free anyway.
   */
  // Matched on the shape rather than on the empty value itself: R6-4 replaced
  // the inline `[]` with a shared `NO_RESULTS` constant, and pinning the
  // spelling would fail on that while the behaviour is unchanged. What must
  // hold is that the clear is synchronous and inside the early return.
  assert.ok(
    /if \(!text\.trim\(\)\) \{\s*setResults\([^)]*\)\s*return\s*\}/.test(runSearch),
    'an empty query must clear results immediately rather than after the delay',
  )

  const clearAt = runSearch.indexOf('clearTimeout')
  assert.ok(
    clearAt >= 0 && clearAt < runSearch.indexOf('if (!text.trim())'),
    'a pending query must be cancelled before the empty-query early return, or it lands after the clear',
  )

  // The board unmounts whenever a file is opened, so a pending query must not
  // outlive it and run during the reader's opening animation.
  assert.ok(
    /return \(\) => \{\s*if \(searchTimer\.current\) clearTimeout\(searchTimer\.current\)/.test(screen),
    'the pending query must be cancelled on unmount',
  )
})

test('the move sheet’s preview selector runs only while the sheet is alive', () => {
  const screen = source('screens/LibraryScreen.tsx')
  const sheet = source('components/MoveSheet.tsx')

  /*
   * `useGroupPreviews` walks every group building a string key on every store
   * update. That is correct and deliberate — but it was paid at screen level
   * for a sheet that is shut almost always.
   */
  assert.ok(
    !screen.includes('useGroupPreviews()'),
    'the screen must not run the preview selector unconditionally',
  )
  assert.ok(
    sheet.includes('useGroupPreviews()'),
    'the selector moves into the sheet, which is mounted only when needed',
  )

  /*
   * Still one *call*, not one per destination row — the reason it was hoisted
   * out of the rows in the first place still stands.
   *
   * Counted as assignments rather than as occurrences of the name: the
   * docstring above the container legitimately discusses `useGroupPreviews()`
   * while explaining why the call moved, and a test that cannot tell an
   * explanation from the thing it explains is a test that punishes documenting
   * the fix.
   */
  assert.equal(
    sheet.match(/=\s*useGroupPreviews\(\)/g)?.length,
    1,
    'a per-row version would be the O(groups x files) pattern this avoids',
  )
  assert.ok(
    !/Destination[\s\S]{0,600}useGroupPreviews/.test(sheet),
    'the selector must not be called from the per-row component',
  )

  /*
   * `SheetShell` stays mounted through its own exit animation, so a plain
   * `{visible && <MoveSheet/>}` would cut the slide-out. The container latches
   * past the dismissal instead.
   */
  assert.ok(
    /if \(!live\) return null/.test(sheet),
    'the container must stop rendering once the sheet is closed and settled',
  )
  assert.ok(
    /if \(props\.visible\) setLive\(true\)/.test(sheet),
    'opening must mount it before the selector is needed',
  )
})


/*
 * Seek responsiveness.
 *
 * The reported symptom: dragging the scrollbar to a new position sent the thumb
 * back to where it started, held it there, and only then jumped to the
 * requested page. Two independent faults produced it, and both are pinned here
 * because each is individually invisible - the control still "worked", it just
 * lied about where the reader was going.
 */

test('a seek in flight suppresses the follow effect, not just the drag', () => {
  const src = source('components/ScrollPageIndicator.tsx')

  /*
   * The snap-back, exactly.
   *
   * `dragging` goes false the instant the finger lifts, but the document has
   * not rendered the new page yet, so `current` still holds the *old* one. With
   * only `dragging` in the guard the follow effect fires in that window and
   * springs the thumb back to the page being left.
   */
  const follow = /if \(total < 2 \|\| dragging([^)]*)\) return/.exec(src)?.[1] ?? ''
  assert.ok(
    follow.includes('pendingPage !== null'),
    'the follow effect must also stand down while a seek is outstanding, or the thumb springs back to the page being left',
  )
})

test('the pending page is set before dragging is cleared', () => {
  const src = source('components/ScrollPageIndicator.tsx')

  /*
   * Ordering is the fix. If `setDragging(false)` ran first there would be a
   * render in which both flags are clear, and the follow effect would fire
   * against the stale position - reintroducing the snap-back through a gap of
   * one frame, which is exactly the kind of bug that reads as "sometimes".
   */
  const endDrag = /const endDrag = useCallback\(([\s\S]*?)\n  \}, \[/.exec(src)?.[1] ?? ''
  assert.ok(endDrag.length > 0, 'endDrag must still exist')

  const setPending = endDrag.indexOf('setPendingPage(page)')
  const clearDrag = endDrag.indexOf('setDragging(false)')
  assert.ok(setPending >= 0, 'releasing must record the requested page')
  assert.ok(clearDrag >= 0, 'releasing must clear the drag flag')
  assert.ok(
    setPending < clearDrag,
    'the pending page must be set first - the two flags are one handover, and a gap between them is a frame of snap-back',
  )

  // The throttle can swallow the last frames of a drag, so the final position
  // has to be sent unthrottled or a flick lands short of where it stopped.
  assert.ok(
    endDrag.includes('requestJump(fileId, page)'),
    'the final page must be committed on release, not left to the throttle',
  )
})

test('an outstanding seek is reconciled, abandoned or timed out - never permanent', () => {
  const src = source('components/ScrollPageIndicator.tsx')

  // Tolerant by a page: a PDF settles on whichever page the viewport lands on,
  // which after a seek to 443 can legitimately report 442 or 444. An exact
  // match would leave the request outstanding forever.
  assert.ok(
    /Math\.abs\(current - pendingPage\) <= 1/.test(src),
    'arrival must tolerate an off-by-one, or the control freezes waiting for an exact match',
  )
  // A file swipe must not carry one document's pending seek onto another.
  assert.ok(
    /setPendingPage\(null\)\s*\n\s*\}, \[fileId\]\)/.test(src),
    'a pending seek must be dropped when the file changes',
  )
  // And a renderer that never confirms must not pin the control forever.
  assert.ok(
    /setTimeout\(\(\) => setPendingPage\(null\), \d+\)/.test(src),
    'an unconfirmed seek must fall back to reality rather than freezing the control',
  )
})

test('dragging the scrollbar does not re-render on every frame', () => {
  const src = source('components/ScrollPageIndicator.tsx')

  /*
   * `setDragPage` sat *above* the throttle's early return, so it ran on every
   * frame of the drag - a React render of this component ~60 times a second,
   * for a number that can only change as fast as the eye reads it. The comment
   * claimed the throttle stopped a flood of re-renders while the component
   * itself was causing one.
   *
   * The thumb is unaffected either way: it is driven by `progress`, a shared
   * value on the UI thread, so it keeps tracking the finger at full frame rate.
   */
  const seekTo = /const seekTo = useCallback\(([\s\S]*?)\n    \},/.exec(src)?.[1] ?? ''
  assert.ok(seekTo.length > 0, 'seekTo must still exist')

  const throttle = seekTo.indexOf('lastSeekAt.current < SEEK_THROTTLE_MS')
  const setBadge = seekTo.indexOf('setDragPage(page)')
  assert.ok(throttle >= 0, 'the seek must stay throttled')
  assert.ok(setBadge >= 0, 'the badge page must still be set')
  assert.ok(
    throttle < setBadge,
    'the badge update must sit behind the throttle - above it, every frame of a drag is a React re-render',
  )

  // The live page still has to be exact on release, which the throttled state
  // cannot guarantee, so it is mirrored to a ref every frame instead.
  assert.ok(
    seekTo.includes('dragPageRef.current = page'),
    'the un-throttled page must be mirrored to a ref so release can read it exactly',
  )
})

test('the native document views are not handed fresh props on every render', () => {
  const pdf = source('renderers/PdfRenderer.tsx')
  const web = source('renderers/WebViewRenderer.tsx')

  /*
   * `PdfRenderer` re-renders on every seek - `targetPage` is state - so any
   * prop built inline here churns at exactly the moment the document is
   * busiest. `source` is the sharp one: handing a native PDF view a new
   * "open this document" descriptor mid-seek is the worst possible timing.
   */
  assert.ok(
    !/source=\{\{/.test(pdf),
    'the PDF source object must be memoised, not rebuilt inline on every seek',
  )
  assert.ok(
    /const source = useMemo\(/.test(pdf),
    'the PDF source must be memoised on the file it describes',
  )
  assert.ok(
    !/onScaleChanged=\{\(/.test(pdf) && !/onError=\{\(/.test(pdf),
    'native-view callbacks must be hoisted, not inline arrows',
  )

  assert.ok(
    !/onShouldStartLoadWithRequest=\{\(/.test(web),
    'the navigation guard must be a stable reference - it is handed to a native view',
  )
  assert.ok(
    /style=\{webViewStyle\}/.test(web),
    'the WebView style must be memoised rather than an inline object',
  )
})

test('the pager lays out a bounded number of slots, whatever the group size', () => {
  const src = source('components/HorizontalPager.tsx')

  /*
   * The track is `width * count` wide and used to emit a real native view for
   * every file in the group - 200 of them behind a track 200 screens wide, for
   * a UI that shows exactly one. Windowing keeps the slots a swipe can reveal
   * mid-gesture while making the cost constant in group size.
   */
  assert.ok(
    /if \(i < index - 1 \|\| i > index \+ 1\) return null/.test(src),
    'the pager must window its slots to the current file and its neighbours',
  )

  /*
   * With slots omitted, flow layout would pack the survivors against the left
   * edge and the translate arithmetic - which assumes slot `i` is at
   * `i * width` - would address the wrong file. Absolute positioning restores
   * exactly the geometry the existing transform expects.
   */
  assert.ok(
    /position: 'absolute', left: i \* width/.test(src),
    'windowed slots must be positioned absolutely at their true offset, or the pager shows the wrong file',
  )

  // The gesture arbitration in this file is scar tissue: windowing is a
  // rendering change and must not have touched it.
  for (const rule of ['.activeOffsetX([-24, 24])', '.failOffsetY([-8, 8])', '.maxPointers(1)']) {
    assert.ok(src.includes(rule), `the gesture arbitration must be untouched: ${rule}`)
  }
  assert.ok(
    /next = Math\.max\(0, Math\.min\(count - 1, next\)\)/.test(src),
    'group isolation must still be enforced by the clamp',
  )
  /*
   * The mount rule is now two rules, and only one of them is about pdfium.
   *
   * This used to assert `const mounted = i === index` outright, on the grounds
   * that it "keeps pdfium to one live handle and EPUB parsing to one book".
   * Those are two different constraints that happened to share an
   * implementation, and R5 separates them
   * ([AUDIT2 §2.5](../../AUDIT2.md)):
   *
   *  - **pdfium is still one live document.** Three crashed inside
   *    `FPDF_LoadPage` when one was unmounted mid-render. Unchanged, and pinned
   *    below.
   *  - **The WebView is not.** Preparation is gated on `active`, so an inactive
   *    neighbour constructs a view and evaluates a script and parses nothing —
   *    which is exactly the per-swipe cost R5 moves off the critical path.
   */
  const mountAt = src.indexOf('const mounted =')
  // Sliced forward from the declaration: `return (` occurs earlier in the
  // file, so anchoring on it from index 0 would produce an empty slice and a
  // test that fails on correct code.
  const mountRule = src.slice(mountAt, src.indexOf('return (', mountAt))
  assert.ok(
    mountRule.includes('i === index') &&
      mountRule.includes('isWebViewFormat(file.format)') &&
      mountRule.includes('Math.abs(i - index) === 1'),
    'the mount rule must be: the active file, plus WebView-format neighbours only',
  )

  assert.ok(
    src.includes('isWebViewFormat'),
    'the neighbour rule must be gated on the format family, not applied to every renderer',
  )

  /*
   * The pdfium half, stated as what must *not* be true.
   *
   * A future edit that drops the format gate would mount three PDFs and
   * reintroduce the `FPDF_LoadPage` crash — and it would look like a
   * simplification, which is precisely why it is asserted rather than trusted.
   */
  assert.doesNotMatch(
    src,
    /const mounted = Math\.abs\(i - index\) <= 1/,
    'an ungated neighbour rule would mount three pdfium documents',
  )
})


/*
 * Q3-2 / Q4 — memoisation and correctness polish.
 *
 * The gesture memo is the one worth being careful about. `.enabled()` is
 * evaluated when a gesture is *constructed*, not per frame — that is why the
 * zoom lock is written as `.enabled(!isZoomed && !seeking)` rather than as a
 * check inside `onUpdate` (DETAIL.md 6.5). So a `useMemo` around the gesture
 * that omits either flag pins `enabled` at its first value and brings back the
 * immovable-zoomed-PDF bug, in the most delicate file in the app.
 */

test('the pager gesture memo declares every value its closures read', () => {
  const src = source('components/HorizontalPager.tsx')

  const deps = /\}, \[([^\]]*)\]\)/.exec(
    src.slice(src.indexOf('const composed = useMemo')),
  )?.[1]
  assert.ok(deps, 'the composed gesture must be memoised with a dependency list')

  const declared = deps.split(',').map((d) => d.trim()).filter(Boolean)

  /*
   * These two are non-negotiable: they feed `.enabled()`. Omitting either is
   * not a performance regression, it is the zoom lock silently ceasing to
   * engage.
   */
  for (const critical of ['isZoomed', 'seeking']) {
    assert.ok(
      declared.includes(critical),
      `${critical} must be a dependency — it feeds .enabled(), which is read at construction`,
    )
  }

  /*
   * The rest decide *where* a swipe lands. A stale closure over `index`,
   * `count` or `width` pages to the wrong file rather than merely feeling
   * wrong, which is far worse than the render it saves.
   */
  for (const captured of ['index', 'count', 'width', 'commit', 'onTap']) {
    assert.ok(
      declared.includes(captured),
      `${captured} is read inside the gesture callbacks and must be a dependency`,
    )
  }
})

test('memoising the gesture did not disturb the arbitration', () => {
  const src = source('components/HorizontalPager.tsx')

  // Byte-for-byte, because every one of these is scar tissue from a real device
  // bug: the immovable zoomed PDF and the starved native scroll.
  for (const rule of [
    '.activeOffsetX([-24, 24])',
    '.failOffsetY([-8, 8])',
    '.maxPointers(1)',
    '.enabled(!isZoomed && !seeking)',
    'Gesture.Simultaneous(pan, tap)',
  ]) {
    assert.ok(src.includes(rule), `the arbitration must be untouched: ${rule}`)
  }
})

test('a warm-cache mount seeds the delivery refs, not just the payload', () => {
  const src = source('renderers/WebViewRenderer.tsx')

  /*
   * The lazy `payload` initialiser seeds content from cache so a warm file
   * paints on frame one. It did not seed the deferred chapters or the image
   * queue, so a renderer mounted *inactive* with a warm cache would render a
   * book's first screens and silently drop the rest.
   *
   * Not reachable today — the pager mounts only the active file, and the
   * `active` effect repairs it — but it is a trap armed for whoever re-enables
   * neighbour mounting.
   */
  assert.ok(
    /restRef\.current = warm\.rest \?\? \[\]/.test(src),
    'a warm mount must seed the deferred-chapter queue',
  )
  assert.ok(
    /imagesRef\.current = warm\.images \?\? \[\]/.test(src),
    'a warm mount must seed the image queue',
  )

  // Guarded, or a re-render re-seeds refs the delivery effects have already
  // drained and the book is appended twice.
  assert.ok(
    /seededRef/.test(src),
    'the seeding must be one-shot, or a re-render appends the document twice',
  )
})

test('the pending-removal timer type describes what is actually stored', () => {
  const src = source('store/pendingRemoval.ts')

  /*
   * A batch has one timer for all its members: the first item carries it and
   * the rest are cleared through it. That was typed as always-present and the
   * absent case forced through with `undefined as unknown as ...` — a cast that
   * existed only to hide a shape the type could describe directly.
   */
  assert.ok(
    /timer\?: ReturnType<typeof setTimeout>/.test(src),
    'the timer must be optional, which is what a batch actually stores',
  )
  assert.ok(
    !/^\s*timer: ReturnType<typeof setTimeout>$/m.test(src),
    'the non-optional declaration must be gone, not merely joined by an optional one',
  )
  /*
   * Matched as an assignment, not as the bare phrase.
   *
   * The comment above the field quotes `undefined as unknown as …` while
   * explaining what it replaced, so a substring search finds the explanation
   * and fails on correct code — the same trap this suite already documents
   * elsewhere. Only a real cast in a value position counts.
   */
  assert.ok(
    !/:\s*\(?undefined as unknown as/.test(src),
    'the double cast must be gone — clearTimeout(undefined) is a documented no-op',
  )
  assert.ok(
    /timer: i === 0 \? timer : undefined/.test(src),
    'only the first item of a batch carries the live timer',
  )
})

test('Dropdown does not take a theme it never reads', () => {
  const dropdown = source('components/Dropdown.tsx')
  const reader = source('screens/ReaderScreen.tsx')

  /*
   * The control is drawn on the reader's translucent black scrim in every
   * theme, so its colours are fixed white-on-dark by design. Accepting a
   * `theme` implied they follow the app palette and handed the component a
   * re-render trigger for a value it ignored.
   */
  assert.ok(!/^\s*theme: Theme$/m.test(dropdown), 'Dropdown must not declare a theme prop')
  assert.ok(
    !/from '\.\.\/ui\/theme'/.test(dropdown),
    'the Theme import must go with the prop',
  )

  // Both call sites in the reader's top bar.
  const dropdowns = reader.match(/<Dropdown[\s\S]*?\/>/g) ?? []
  assert.equal(dropdowns.length, 2, 'the reader has a File and a Group picker')
  for (const call of dropdowns) {
    assert.ok(!call.includes('theme='), 'no call site may still pass theme')
  }
})

test('the splash failsafe disarms once the library has loaded', () => {
  const app = source('../App.tsx')

  /*
   * The 4s fallback stayed armed after `loaded` had already hidden the splash
   * and fired a redundant second `hideAsync`. Harmless — the call is idempotent
   * — but a timer outliving its purpose is one the next reader has to reason
   * about.
   *
   * The failsafe itself must stay: `load()` has no rejection path, so removing
   * it turns a recoverable index read error into a permanent splash.
   */
  /*
   * Located by the timeout rather than by effect order.
   *
   * There are now two `[loaded]` effects — the one that hides the splash on
   * load, and this failsafe — so matching the first `useEffect … }, [loaded])`
   * finds the wrong one. Anchoring on the 4000ms timer identifies it
   * unambiguously and keeps doing so if the two are ever reordered.
   */
  const at = app.indexOf('4000')
  assert.ok(at > 0, 'the failsafe itself must remain — load() has no rejection path')

  const effectStart = app.lastIndexOf('useEffect(() => {', at)
  const effectEnd = app.indexOf('}, [loaded])', at)
  assert.ok(effectStart >= 0 && effectEnd > effectStart, 'the failsafe must be an effect')

  const failsafe = app.slice(effectStart, effectEnd)
  assert.ok(
    failsafe.includes('if (loaded) return'),
    'the failsafe must disarm once loaded, or it fires a redundant second hideAsync',
  )
})


test('the disk cache declines documents whose content is still a thunk', () => {
  /*
   * `loadRest` and `loadImages` are closures over the archive bytes, and
   * `JSON.stringify` drops a function **silently**. A persisted entry carrying
   * either would come back as a book that renders its opening chapters and then
   * stops forever, with every illustration blank — and nothing about the write
   * would have looked wrong.
   *
   * Checked as source rather than behaviour because `diskCache` needs
   * `expo-file-system`. That is a weaker test than running it, so it is written
   * to fail loudly if either guard is removed rather than merely reworded.
   */
  const disk = source('renderers/webview/diskCache.ts')

  assert.ok(
    /if \(prepared\.loadRest\) return/.test(disk),
    'writePrepared must decline a document whose remainder has not been assembled',
  )
  assert.ok(
    /if \(prepared\.loadImages\) return/.test(disk),
    'writePrepared must decline a document whose images have not been fetched',
  )
})

test('deferred phase 2 runs after the viewer is on screen, not during preparation', () => {
  /*
   * The whole of R4-1. `loadRest` must be *called* from the streaming effect —
   * which is gated on `rendered` — and not from `prepareFile`, or the reader
   * waits for the entire book before seeing page one again
   * ([AUDIT2 §1.3](../../AUDIT2.md)).
   */
  const epub = source('renderers/webview/epub.ts')
  const renderer = source('renderers/WebViewRenderer.tsx')

  assert.ok(
    /loadRest: restSpine\.length \? loadRest : undefined/.test(epub),
    'loadEpubAsHtml must return the thunk rather than having run it',
  )
  assert.doesNotMatch(
    epub,
    /await loadRest\(\)/,
    'phase 2 must not be awaited inside the parser',
  )
  assert.ok(
    /const pending = loadRestRef\.current/.test(renderer),
    'the renderer must drain the thunk from a ref',
  )
})

test('images are registered by size, never decompressed during parsing', () => {
  /*
   * Registration reads `sizeOf` — the ZIP central directory — so both image
   * budgets are enforced with nothing decompressed and nothing crossing the
   * worklet boundary. A version that reached into a decompressed slice would
   * reintroduce exactly the crossing R4-2 removed.
   */
  const epub = source('renderers/webview/epub.ts')
  const register = epub.slice(
    epub.indexOf('const registerImage ='),
    epub.indexOf('const chapters: string[] = []'),
  )

  assert.ok(register.includes('sizeOf.get(path)'), 'the budget must come from the listing')
  assert.doesNotMatch(
    register,
    /zip\[path\]|slice\[path\]/,
    'registration must not read decompressed bytes',
  )
})


/* ==================== mounted neighbours (R5) ==================== */

test('only the active renderer persists a reading position', () => {
  /*
   * The correctness risk R5 introduces, and it fails silently.
   *
   * A neighbour is mounted now, and a neighbour with a warm cache renders its
   * document and reports a position exactly like the active file does. Without
   * a guard, merely swiping *past* a book would write its scroll offset,
   * progress and anchor to MMKV — and because a restore is not pixel-exact, the
   * value written back is not always the value read. The position of a book
   * nobody opened would drift a little further every time.
   *
   * Nothing about that surfaces as an error; it shows up weeks later as "it
   * lost my place", which is the hardest class of bug this project has.
   */
  const src = source('renderers/WebViewRenderer.tsx')

  const posBlock = src.slice(
    src.indexOf("msg.type === 'pos'"),
    src.indexOf("msg.type === 'search'"),
  )

  assert.ok(
    /if \(activeRef\.current\) \{[\s\S]*?setScroll\(file\.id/.test(posBlock),
    'setScroll must be gated on the renderer being the active one',
  )
  assert.ok(
    /if \(activeRef\.current\) \{[\s\S]*?setProgress\(file\.id/.test(posBlock),
    'setProgress must be gated on the renderer being the active one',
  )
  assert.ok(
    /activeRef\.current && typeof msg\.offset === 'number'/.test(posBlock),
    'setAnchor must be gated on the renderer being the active one',
  )

  /*
   * `report` is deliberately *not* gated, and that is worth pinning too: it is
   * memory-only and keyed per file id, and having a neighbour's page count
   * ready is part of why the neighbour is mounted at all.
   */
  assert.ok(
    /\}\s*\n\s*if \(typeof msg\.current === 'number'/.test(posBlock),
    'report must stay outside the active guard',
  )
})

test('preparation is gated on active, which is what makes a mounted neighbour cheap', () => {
  /*
   * The load-bearing assumption behind mounting neighbours at all.
   *
   * An inactive `WebViewRenderer` must construct its view and evaluate the
   * viewer script and do **no** parsing — no unzip, no worklet crossing, no
   * document assembly. If that gate ever moved, three EPUBs would be parsed at
   * once again, which is the exact failure that made single-mounting necessary
   * in the first place.
   */
  const src = source('renderers/WebViewRenderer.tsx')
  const prepareEffect = src.slice(
    src.indexOf('const apply = (prepared'),
    src.indexOf('useEffect(() => () => forget(file.id)'),
  )

  assert.ok(prepareEffect.length > 0, 'the preparation effect could not be located')
  assert.ok(
    src.includes('if (!active) return'),
    'preparation must remain gated on active, or a mounted neighbour parses a whole book',
  )
})

test('the neighbour rule does not disturb the reader-side cleanup', () => {
  /*
   * R5's own checklist worried that hoisting the WebView would remove the
   * unmount these depend on. Mounting neighbours does not: each slot is still
   * keyed by `file.id` and still unmounts when the file leaves the window, so
   * per-file state is still dropped exactly once, by the same mechanism.
   */
  const src = source('renderers/WebViewRenderer.tsx')
  assert.ok(
    /useEffect\(\(\) => \(\) => forget\(file\.id\), \[file\.id, forget\]\)/.test(src),
    'page-nav state must still be dropped when a file unmounts',
  )
  assert.ok(
    /useEffect\(\(\) => \(\) => useSearch\.getState\(\)\.forget\(file\.id\), \[file\.id\]\)/.test(src),
    'search state must still be dropped when a file unmounts',
  )
})

/*
 * R6-4 — search results past the limit are reachable, and counted honestly.
 *
 * There were two truncations stacked: the SQL `LIMIT`, and the view's own row
 * cap. The "+N more" line measured the remainder against the *first* of them,
 * so a library with 214 matches was told "+42 more" — understating by every
 * result past the fiftieth, and offering no way to any of them.
 */
test('search reports the database total, not the size of the page it holds', () => {
  const db = source('storage/db.ts')

  assert.ok(
    /export function searchFiles\(query: string, limit = \d+\): SearchPage/.test(db),
    'searchFiles must return a page object carrying a total, not a bare array',
  )

  const body = db.slice(db.indexOf('export function searchFiles'))
  assert.ok(
    body.includes('count(*)') && body.includes('files_fts MATCH ?'),
    'the total must come from a count over the same MATCH, or it just re-reports the LIMIT',
  )

  const search = source('components/LibrarySearch.tsx')
  assert.ok(
    search.includes('results.total - shown.length'),
    'the remainder must be measured against the database total, not the fetched rows',
  )
})

test('the search result list offers a route past the limit', () => {
  const search = source('components/LibrarySearch.tsx')

  const more = search.slice(search.indexOf('{extra > 0 &&'))
  assert.ok(
    more.includes('onPress={onShowMore}'),
    'the truncation notice must be pressable — a count with no way past it tells the ' +
      'user a file exists and offers no route to it',
  )
  assert.ok(
    /of \{results\.total\}/.test(more),
    'the notice must name the total, so "8 of 214" is distinguishable from "8 results"',
  )

  const screen = source('screens/LibraryScreen.tsx')
  assert.ok(
    /setPages\(1\)/.test(screen),
    'a new query must reset the page count, or a refined search opens already expanded',
  )
  assert.ok(
    /want > results\.files\.length/.test(screen),
    'show more must only re-query when it runs past the rows already fetched — the ' +
      'early presses already have their answer and must not block on SQLite',
  )
})

/*
 * R6-2 — the cover factory is bounded and follows the viewport.
 *
 * The work is sequential and unbounded: at `SETTLE_MS` per capture plus
 * pdfium's parse, a few thousand uncovered PDFs is twenty-odd minutes of
 * continuous native rasterising, competing with the scroll the user is doing,
 * for covers they may never reach.
 */
test('the cover factory stops after a capped number of covers per session', () => {
  const factory = source('components/PdfCoverFactory.tsx')

  assert.ok(
    /const MAX_PER_SESSION = \d+/.test(factory),
    'the per-session cap must be a named constant with a rationale',
  )

  const pick = factory.slice(factory.indexOf('const pickNext'), factory.indexOf('// Start the queue'))
  assert.ok(
    /if \(made\.current >= MAX_PER_SESSION\) return null/.test(pick),
    'the cap must be enforced where the next file is chosen, so nothing is mounted past it',
  )

  // Counted on attempt: a PDF that will not rasterise costs the same pdfium
  // parse as one that will, so counting successes lets broken files run all session.
  const start = factory.slice(factory.indexOf('busy.current = true'))
  assert.ok(
    start.indexOf('made.current += 1') < start.indexOf('setTarget(next)'),
    'the attempt must be counted before the capture is started, not after it succeeds',
  )
})

test('the cover factory prefers files in groups that are on screen', () => {
  const factory = source('components/PdfCoverFactory.tsx')
  const pick = factory.slice(factory.indexOf('const pickNext'), factory.indexOf('// Start the queue'))

  assert.ok(
    pick.includes('visibleGroups()'),
    'the visible range must be read when a slot opens, not captured at render',
  )
  assert.ok(
    /if \(visible\.has\(file\.groupId\)\) return file/.test(pick),
    'an on-screen candidate must win immediately — a cover that arrives after the user ' +
      'has scrolled past has served nobody',
  )
  assert.ok(
    pick.includes('return fallback'),
    'off-screen files must remain reachable, or a user who never scrolls covers one screen and stops',
  )

  const screen = source('screens/LibraryScreen.tsx')

  /*
   * A ref, not state. This is written on every scroll settle, and re-rendering
   * the board to tell the factory where the viewport is would cost more than
   * the prioritisation saves.
   */
  assert.ok(
    /const visibleGroups = useRef<ReadonlySet<string>>/.test(screen),
    'the visible set must be a ref — as state it re-renders the whole board per scroll settle',
  )
  assert.ok(
    !/setVisibleGroups/.test(screen),
    'the visible set must never be React state',
  )

  // FlatList captures both on mount and throws if the identity changes.
  assert.ok(
    /const onViewableItemsChanged = useRef\(/.test(screen) &&
      /const viewabilityConfig = useRef\(/.test(screen),
    'both viewability props must have stable identities, or FlatList throws',
  )

  // The list keys rows by group id, which is what the factory looks up.
  assert.ok(
    /function groupKey\(group: Group\): string \{\s*return group\.id/.test(screen),
    'the viewable item key must be the group id the factory matches against',
  )
})
