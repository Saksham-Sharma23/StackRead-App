import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/*
 * Drive-like PDF opening.
 *
 * In `react-native-pdf`, every prop update posts `drawPdf()`, and
 * AndroidPdfViewer's `Configurator.load()` recycles the document and re-parses
 * it from scratch. A large PDF was being loaded, then loaded again, by things
 * as ordinary as the chrome hiding. These pin the two halves of the fix — the
 * renderer never changes a prop after mount, and the native view does not
 * reload a document it already has — plus the instant-open preview.
 *
 * The modules import React Native and native views, so the source is pinned.
 */

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

/** The JSX props of the first `<Pdf` element in a file. */
function pdfElement(src: string): string {
  const start = src.indexOf('<Pdf\n')
  assert.ok(start >= 0, 'no <Pdf> element found')
  return src.slice(start, src.indexOf('/>', start))
}

test('the reader hands the native view nothing that changes after mount', () => {
  const reader = source('renderers/PdfRenderer.tsx')
  const el = pdfElement(reader)

  assert.doesNotMatch(reader, /AnimatedPdf|createAnimatedComponent\(Pdf\)/, 'animated props on the view are reloads')
  assert.ok(el.includes('page={initialPage}'), 'page is the initial page only')
  assert.ok(el.includes('style={pdfStyle}'), 'the style is memoised')
  assert.ok(el.includes('source={source}'))
  assert.doesNotMatch(el, /=\{\(|=\{\{|=\{\[/, 'no inline arrows, objects or arrays')

  // Fullscreen must not resize the document.
  assert.doesNotMatch(reader, /\{ file, active, fullscreen/, 'fullscreen is deliberately not read')
  assert.doesNotMatch(reader, /marginTop: insets/, 'no inset animation on the document')
})

test('page jumps use the native command, never the page prop', () => {
  const reader = source('renderers/PdfRenderer.tsx')
  assert.ok(/pdfRef\.current\.setPage\(jump\.page\)/.test(reader))
  assert.doesNotMatch(reader, /setTargetPage|page=\{targetPage\}/)
  // A jump before the document has loaded is held, then applied.
  assert.ok(/pendingJump\.current = jump\.page/.test(reader))
  assert.ok(/pdfRef\.current\?\.setPage\(pendingJump\.current\)/.test(reader))
})

test('the load callback keeps one identity, so it is never a prop change', () => {
  const reader = source('renderers/PdfRenderer.tsx')
  const cb = reader.slice(reader.indexOf('const handleLoadComplete'), reader.indexOf('if (error) {'))
  const deps = /\}, \[([^\]]*)\],\n\s*\)/.exec(cb)?.[1] ?? ''
  assert.doesNotMatch(deps, /\bactive\b/, '`active` flips on every swipe; it is read through a ref instead')
})

test('a local file skips the download-cache stat', () => {
  const reader = source('renderers/PdfRenderer.tsx')
  assert.ok(/cache: false/.test(reader))
})

test('the native view reloads only when the document or its load settings change', () => {
  const patch = source('../patches/react-native-pdf+7.0.5.patch')
  assert.ok(patch.includes('PdfView.java'), 'the patch targets the native view')
  assert.ok(/if \(config\.equals\(this\.loadedConfig\) && !this\.isRecycled\(\)\)/.test(patch))
  /*
   * The patch is only source changes, never stray build output (`android/build`
   * once leaked in from a compile). Was "exactly one file"; the exact-position
   * restore (pdfResume.test.ts) legitimately added the spec, manager and JS
   * files, so the property pinned is now the list itself.
   */
  const files = [...patch.matchAll(/^diff --git a\/node_modules\/react-native-pdf\/(\S+)/gm)].map((m) => m[1]).sort()
  assert.deepEqual(files, [
    'android/src/main/java/org/wonday/pdf/PdfManager.java',
    'android/src/main/java/org/wonday/pdf/PdfView.java',
    'fabric/RNPDFPdfNativeComponent.js',
    'index.d.ts',
    'index.js',
  ])

  const pkg = JSON.parse(source('../package.json'))
  assert.equal(pkg.scripts.postinstall, 'patch-package', 'npm ci (and CI) must apply it')
  assert.ok(pkg.devDependencies['patch-package'])
})

test('the cover factory lays the page out exactly as the reader does', () => {
  /*
   * The factory's capture is the reader's instant-open preview, so any layout
   * difference is a visible jump when the live page replaces it.
   */
  const reader = pdfElement(source('renderers/PdfRenderer.tsx'))
  const factory = pdfElement(source('components/PdfCoverFactory.tsx'))
  for (const prop of ['fitPolicy', 'spacing', 'horizontal', 'enablePaging']) {
    const r = new RegExp(`${prop}=\\{([^}]+)\\}`).exec(reader)?.[1]
    const f = new RegExp(`${prop}=\\{([^}]+)\\}`).exec(factory)?.[1]
    assert.ok(r !== undefined, `the reader must set ${prop}`)
    assert.equal(f, r, `${prop} must match between reader and factory`)
  }
  assert.doesNotMatch(factory, /singlePage/, 'the reader shows page 2 under a short page 1; so must the frame')
  assert.ok(source('components/PdfCoverFactory.tsx').includes('savePreview(file.id, stage.width, stage.height, shot)'))
})

test('the preview is only shown for an open that lands on page 1, at the size it was taken', () => {
  const reader = source('renderers/PdfRenderer.tsx')
  assert.ok(
    /initialPage === 1 \? existingPreview\(file\.id, frameAtMount\.width, frameAtMount\.height\) : null/.test(reader),
  )
  // It fades only once the live document has had time to draw.
  const settle = reader.slice(reader.indexOf('const markSettled'), reader.indexOf('}, [previewOpacity])'))
  assert.ok(settle.includes('previewOpacity.value = withTiming(0'))
  assert.ok(settle.includes('FIRST_PAGES_MS'))

  const store = source('storage/pdfPreview.ts')
  // Every name starts with the file and the window size it was taken at.
  assert.ok(store.includes('`${fileId}.w${Math.round(width)}h${Math.round(height)}`'), 'keyed by window size')
  assert.ok(store.includes('`${sizeTag(fileId, width, height)}.jpg`'))
  assert.ok(/new Directory\(Paths\.cache, 'stackread-pdf-previews'\)/.test(store), 'disposable, outside the library')

  const lifecycle = source('storage/lifecycle.ts')
  assert.ok(lifecycle.includes('forgetPreviews(fileId)') && lifecycle.includes('clearPreviews()'))
})
