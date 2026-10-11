import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/*
 * AUDIT4 A7–A12: the crash paths that do not reduce to a pure function.
 *
 * The modules involved import React Native, `expo-file-system`, MMKV or
 * `react-native-pdf`, none of which load under Node, so — as elsewhere in this
 * suite — the source is read and the structure that carries each property is
 * pinned. The pure halves are tested for real in `pdfiumLease.test.ts`,
 * `snippet.test.ts` and `zipWorklet.test.ts`.
 */

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

test('A7: a snippet reads a bounded prefix, never the whole file', () => {
  const hook = source('components/useSnippet.ts')
  assert.doesNotMatch(hook, /\.text\(\)/, 'the whole file must not be read as a string for a preview')
  assert.ok(/source\.open\(FileMode\.ReadOnly\)/.test(hook))
  assert.ok(/handle\.readBytes\(SNIPPET_READ_BYTES\)/.test(hook), 'the read must be capped at the snippet size')
  assert.ok(/finally \{\s*handle\.close\(\)/.test(hook), 'the handle must be closed whatever happens')
})

test('A8: a closing reader waits for a loading PDF before unmounting', () => {
  const app = source('../App.tsx')
  const closed = app.slice(app.indexOf('const handleClosed'), app.indexOf('const handleReaderCrash'))
  assert.ok(
    /whenPdfiumSettled\(PDF_CLOSE_GRACE_MS\)\.then\(\(\) => \{\s*setReading\(null\)/.test(closed),
    'the reader must not be unmounted while pdfium is mid-load',
  )

  // And the invisible, still-mounted reader must not take touches meanwhile.
  const transition = source('components/ReaderTransition.tsx')
  assert.ok(/pointerEvents=\{closing \? 'none' : 'auto'\}/.test(transition))
})

test('A8: the PDF renderer settles its lease only after loading', () => {
  const reader = source('renderers/PdfRenderer.tsx')
  const load = reader.slice(reader.indexOf('const handleLoadComplete'))
  assert.ok(/setReady\(true\)\s*\n\s*markSettled\(\)/.test(load), 'a loaded document must settle its lease')
  assert.ok(
    /leaseRef\.current\?\.markSettled\(\)\s*\n\s*setError/.test(reader),
    'a document that failed to load is not loading either',
  )
})

test('A8: the factory waits for its first page before unmounting, capture or not', () => {
  const factory = source('components/PdfCoverFactory.tsx')
  const loaded = factory.slice(factory.indexOf('const handleLoaded'), factory.indexOf('const handleError'))
  const settle = loaded.indexOf('setTimeout(resolve, SETTLE_MS)')
  const skip = loaded.indexOf('if (abandonRef.current')
  assert.ok(settle > 0 && skip > settle, 'a drained capture must still let pdfium finish page one')
})

test('A9: a dead WebView renderer is replaced, once', () => {
  const renderer = source('renderers/WebViewRenderer.tsx')
  assert.ok(/onRenderProcessGone=\{handleRenderProcessGone\}/.test(renderer))
  assert.ok(/key=\{webKey\}/.test(renderer), 'the WebView must be remountable')

  const handler = renderer.slice(
    renderer.indexOf('const handleRenderProcessGone'),
    renderer.indexOf('const handleMessage'),
  )
  assert.ok(/setRendered\(false\)/.test(handler), 'nothing may keep talking to the dead view')
  assert.ok(/rendererDeaths\.current > MAX_RENDERER_RESTARTS/.test(handler), 'a second death must not loop')
  assert.ok(
    /restRef\.current = source\.rest/.test(handler) && /loadRestRef\.current = source\.loadRest/.test(handler),
    'the fresh viewer must be re-fed the rest of the document',
  )
  assert.ok(/setWebKey\(\(k\) => k \+ 1\)/.test(handler))
})

test('A10: render errors are contained at the root and in the reader', () => {
  const app = source('../App.tsx')
  assert.ok(/<ErrorBoundary name="root"[\s\S]{0,120}<Root \/>/.test(app), 'the app root must be wrapped')
  assert.ok(
    /<ErrorBoundary\s+name="reader"[\s\S]{0,400}<ReaderScreen /.test(app),
    'the reader must have its own boundary, so a bad file closes the reader, not the app',
  )
  assert.ok(/onError=\{handleReaderCrash\}/.test(app))
  assert.ok(/^installCrashLog\(\)$/m.test(app), 'fatal errors must be recorded from module scope')

  const log = source('ui/crashLog.ts')
  assert.ok(
    /noteError\(error, 'global', isFatal === true\)\s*\n\s*previous\(error, isFatal\)/.test(log),
    'the record must be written before the default handler ends the process',
  )
})

test('A11: comics and archives are budgeted before anything is decompressed', () => {
  const prepare = source('renderers/webview/prepare.ts')

  const comic = prepare.slice(prepare.indexOf('async function comicFromArchive'))
  assert.ok(
    comic.indexOf('budget + size > MAX_TOTAL_IMAGE_BYTES') < comic.indexOf('archive.unzip(chosen'),
    'the comic budget must be applied to declared sizes before the unzip',
  )

  const listing = prepare.slice(prepare.indexOf('async function listingFromArchive'))
  assert.ok(
    listing.indexOf('MAX_TOTAL_TEXT_PREVIEW_BYTES') < listing.indexOf('archive.unzip('),
    'the listing must choose its previews before decompressing anything',
  )

  assert.doesNotMatch(prepare, /unzipOffThread/, 'no format may unzip a whole archive')
})

test('A12: cover attempts are crash-safe and session-scoped', () => {
  const thumbs = source('storage/thumbs.ts')
  const ensure = thumbs.slice(thumbs.indexOf('export async function ensureThumbnail'))
  assert.ok(
    ensure.indexOf('beginThumbnailAttempt(entry.id)') < ensure.indexOf('extractCover('),
    'the marker must be written before the work that can kill the process',
  )
  assert.ok(/endThumbnailAttempt\(entry\.id\)\s*\n\s*release\(\)/.test(ensure), 'and cleared whatever happens')

  // A marker left by a dead process becomes a failure, so the next launch skips it.
  const sweep = thumbs.slice(thumbs.indexOf('function sweepInterruptedAttempts'))
  assert.ok(/startsWith\('thumbbusy:'\)[\s\S]{0,200}rememberFailure\(fileId\)/.test(sweep))
  assert.ok(
    /function failedBefore[\s\S]{0,200}sweepInterruptedAttempts\(\)/.test(thumbs),
    'the sweep must run before the first "has this failed" answer',
  )

  const factory = source('components/PdfCoverFactory.tsx')
  const start = factory.slice(factory.indexOf("acquirePdfium('cover')"))
  assert.ok(start.indexOf('beginThumbnailAttempt(next.id)') < start.indexOf('setTarget(next)'))
  assert.ok(/if \(outcome === 'failed'\) markThumbnailFailed\(file\.id\)/.test(factory),
    'a PDF pdfium cannot open must not be retried every visit')
})
