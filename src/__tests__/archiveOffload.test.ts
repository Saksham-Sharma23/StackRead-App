import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { MAX_PREPARE_BYTES } from '../storage/formats.ts'

/*
 * AUDIT4 A1 and A2: an EPUB had no size ceiling, and every pass over it handed
 * the whole archive to a worklet — six full copies across the boundary per
 * open, each of which then threw because the worklet called fflate (not a
 * worklet) and redid the unzip on the JS thread.
 *
 * `epub.ts`, `offload.ts` and `covers.ts` import `expo-file-system` and
 * `react-native-worklets`, which have no Node implementation, so — as in
 * `lifecycle.test.ts` — these read the source and pin the structure. The
 * worker-side reader itself is exercised for real in `zipWorklet.test.ts`.
 */

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

/** The text of every `runOnRuntimeAsync(…)` call, matched by parentheses. */
function workletCalls(src: string): string[] {
  const calls: string[] = []
  let from = 0
  for (;;) {
    const at = src.indexOf('runOnRuntimeAsync(', from)
    if (at < 0) return calls
    let depth = 0
    let i = at + 'runOnRuntimeAsync'.length
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')' && --depth === 0) break
    }
    calls.push(src.slice(at, i + 1))
    from = i + 1
  }
}

test('EPUB has a size ceiling, and it is the one prepareFile already enforces', () => {
  const limit = MAX_PREPARE_BYTES.epub
  assert.equal(typeof limit, 'number', 'epub must declare a ceiling')
  assert.ok(limit! > 0 && limit! <= 200_000_000, 'the ceiling must be a real backstop, not a comment')

  // prepareFile reads the per-format table before any branch reads bytes, so
  // adding the entry is what puts EPUB behind it — no EPUB-specific check.
  const prepare = source('renderers/webview/prepare.ts')
  assert.ok(prepare.includes('MAX_PREPARE_BYTES[entry.format]'))
})

test('cover extraction applies the ceiling before reading the file', () => {
  const covers = source('storage/covers.ts')
  const extract = covers.slice(covers.indexOf('export async function extractCover'))

  const guard = extract.indexOf('MAX_PREPARE_BYTES[format]')
  const read = extract.indexOf('file.bytes()')
  assert.ok(guard > 0, 'extractCover must consult the per-format ceiling')
  assert.ok(read > guard, 'the ceiling must be checked before the file is read into JS')
})

test('no worklet calls fflate', () => {
  /*
   * The bug that made the offload a no-op. Without bundle mode a worklet can
   * only call worklets; `unzipSync` is serialised as a remote function and
   * throws on the worker. fflate is still used — on the JS thread, in the
   * fallbacks — so the rule is scoped to the bodies handed to the runtime.
   */
  const offload = source('renderers/webview/offload.ts')
  const calls = workletCalls(offload)
  assert.ok(calls.length >= 5, 'expected the unzip, park, read, release and base64 worklets')

  for (const call of calls) {
    assert.doesNotMatch(call, /unzipSync\(/, `a worklet must not call fflate:\n${call.slice(0, 200)}`)
  }
})

test('an EPUB open hands the archive to the worker once', () => {
  const epub = source('renderers/webview/epub.ts')

  assert.equal(
    epub.match(/openArchive\(/g)?.length,
    1,
    'the archive must be opened exactly once per parse',
  )
  assert.doesNotMatch(
    epub,
    /OffThread\(\s*bytes/,
    'no pass may hand the whole archive to a worklet again',
  )
  assert.ok(
    (epub.match(/archive\.unzip\(/g)?.length ?? 0) >= 5,
    'container, OPF, first paint, rest and images must all read through the handle',
  )
})

test('the deferred thunks hold the handle, not the bytes', () => {
  /*
   * `loadRest` and `loadImages` live in the cached `Prepared`. Capturing the
   * archive's bytes there kept a whole book alive on the JS side for as long as
   * the cache held the entry (AUDIT4 A4). They must reach the archive only
   * through the handle, which reloads from disk if the worker dropped it.
   */
  const epub = source('renderers/webview/epub.ts')
  const build = epub.slice(epub.indexOf('async function buildBook'))

  assert.ok(build.length > 0, 'buildBook must exist')
  assert.doesNotMatch(build, /\bbytes\(\)|\.bytes\b(?!:)/, 'buildBook must not touch raw bytes')
})

test('phase 2 runs at most once per parse, and then releases the archive', () => {
  const epub = source('renderers/webview/epub.ts')

  assert.ok(/if \(!restDone\)/.test(epub), 'loadRest must be memoised')
  assert.ok(/if \(!imagesInFlight\)/.test(epub), 'concurrent loadImages calls must share one fetch')
  assert.ok(
    /const settle = [\s\S]{0,160}archive\.release\(\)/.test(epub),
    'finishing the last thunk must release the parked archive',
  )
  assert.ok(
    /if \(!outstanding\) archive\.release\(\)/.test(epub),
    'a book with nothing deferred must release the archive immediately',
  )
  assert.ok(
    /catch \(err\) \{[\s\S]{0,120}archive\.release\(\)/.test(epub),
    'a book that fails to parse must release the archive',
  )
})

test('parked archives are released when the app backgrounds', () => {
  const lifecycle = source('ui/useAppLifecycle.ts')
  assert.ok(lifecycle.includes('releaseAllArchives()'))
})


/* ==================== AUDIT4 A3–A6 ==================== */

/** The body of the `useEffect` whose source contains `marker`, through its deps. */
function effectContaining(src: string, marker: string): string {
  const at = src.indexOf(marker)
  assert.ok(at > 0, `marker not found: ${marker}`)
  const start = src.lastIndexOf('useEffect(() => {', at)
  const deps = src.indexOf('\n  }, [', at)
  return src.slice(start, src.indexOf('\n', deps + 1))
}

test('A3: phase 1 does not decompress the book\'s images', () => {
  const epub = source('renderers/webview/epub.ts')
  const phase1 = epub.slice(
    epub.indexOf('const wanted = new Set<string>()'),
    epub.indexOf('const zip = await archive.unzip([...wanted]'),
  )
  assert.ok(phase1.length > 0, 'phase-1 wanted set not found')
  // The removed clause was `/^image\//i.test(item.type)`.
  assert.doesNotMatch(phase1, /\^image/, 'image manifest items must not join the first-paint unzip')
  assert.equal(phase1.match(/wanted\.add\(/g)?.length, 4, 'nav, NCX, CSS and first-paint spine only')
})

test('A4: phase 2 builds its own chapters, and image bytes are not memoised', () => {
  const epub = source('renderers/webview/epub.ts')
  const rest = epub.slice(epub.indexOf('const assembleRest'), epub.indexOf('const imageList'))
  assert.doesNotMatch(rest, /chapters\.push/, 'phase 2 must not append to the shared chapters array')
  assert.ok(rest.includes('restChapters.push'))

  const images = epub.slice(epub.indexOf('let imagesInFlight'), epub.indexOf('outstanding = ('))
  assert.ok(
    /imagesInFlight = null\s*\n\s*if \(!imagesSettled\)/.test(images),
    'the fetched images must be dropped once delivered, not held by the thunk',
  )
})

test('A4: a finished phase 2 replaces the cache entry with the whole book', () => {
  const renderer = source('renderers/WebViewRenderer.tsx')
  const drain = effectContaining(renderer, 'const done = await pending()')
  assert.ok(/replacePrepared\(file\.id, source, finished\)/.test(drain))
  assert.ok(/loadRest: undefined/.test(drain), 'the finished entry must not carry the thunk')
  // Finished before the cancellation check, so leaving mid-load still caches the book.
  assert.ok(drain.indexOf('replacePrepared(') < drain.indexOf('queue.push(...done.rest)'))
})

test('A4: drained batches and images are released as they are delivered', () => {
  const renderer = source('renderers/WebViewRenderer.tsx')
  for (const marker of ['__srAppend', "type: 'image'"]) {
    const drain = effectContaining(renderer, marker)
    assert.ok(drain.includes('queue.shift()'), `${marker} drain must let go of what it delivered`)
    assert.doesNotMatch(drain, /queue\[i\]/, `${marker} drain must not index-and-keep`)
  }
})

test('A5: only the active renderer streams, and only into the current payload', () => {
  const renderer = source('renderers/WebViewRenderer.tsx')
  for (const marker of ['const done = await pending()', 'const fetched = await fetchImages()']) {
    const drain = effectContaining(renderer, marker)
    assert.ok(
      /if \(!rendered \|\| !active \|\| !viewerCurrentRef\.current\) return/.test(drain),
      'the drain must be gated on active and on the viewer holding the current payload',
    )
    assert.ok(/\}, \[rendered, active/.test(drain), 'the drain must re-run when the renderer becomes active')
  }

  // apply() lowers the flag synchronously; only `ready` raises it.
  assert.ok(/viewerCurrentRef\.current = false/.test(renderer))
  assert.ok(/viewerCurrentRef\.current = true\s*\n\s*setRendered\(true\)/.test(renderer))
})

test('A6: covers open a handle on the prefetch lane and read by name', () => {
  const covers = source('storage/covers.ts')
  assert.ok(/openArchive\(\(\) => file\.bytes\(\), 'prefetch'\)/.test(covers))
  assert.doesNotMatch(covers, /unzipOffThread/, 'covers must not unzip whole archives')
  assert.ok(/finally \{[\s\S]{0,120}archive\.release\(\)/.test(covers), 'the archive must be released')

  const select = source('storage/coverSelect.ts')
  assert.doesNotMatch(select, /new TextDecoder/, 'Hermes has no reliable TextDecoder')
})
