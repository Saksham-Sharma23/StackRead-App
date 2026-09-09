import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildViewerHtml } from '../renderers/webview/viewerHtml.ts'
import { sanitizeHtml } from '../renderers/webview/sanitize.ts'

/*
 * EPUB images no longer travel inside the document as `data:` URIs. The markup
 * carries an opaque token in `data-sr-img`, the bytes are streamed separately,
 * and the viewer turns each into a `blob:` URL.
 *
 * This removes roughly two thirds of the memory a heavily illustrated book used
 * to cost — base64 is ~4/3 of the bytes, held in the prepared-document cache,
 * concatenated into one document, then duplicated across the bridge.
 *
 * The failure mode it introduces is silent: if either sanitiser strips
 * `data-sr-img`, every image in every book disappears with no error anywhere.
 * That is the main thing these tests exist to prevent.
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

test('the native sanitiser preserves data-sr-img', () => {
  // Runs first, on the native side, before the markup crosses the bridge.
  const out = sanitizeHtml('<img data-sr-img="sr-img-0" alt="Figure 1" class="plate">')
  assert.match(out, /data-sr-img="sr-img-0"/)
  assert.match(out, /alt="Figure 1"/)
})

test('the native sanitiser still strips handlers from a tokenised image', () => {
  // The token must not become a way to smuggle anything past the sanitiser.
  const out = sanitizeHtml('<img data-sr-img="sr-img-0" onerror="alert(1)">')
  assert.match(out, /data-sr-img="sr-img-0"/)
  assert.doesNotMatch(out, /onerror/i)
})

test('the viewer builds blob URLs rather than assigning data URIs', () => {
  /*
   * The point of the change. `createObjectURL` over a `Blob` means the browser
   * holds binary and decodes lazily; assigning a data: URI would put the whole
   * base64 string back into the DOM, which is what this replaced.
   */
  const js = viewerScript()
  assert.match(js, /function attachImage/)
  assert.match(js, /URL\.createObjectURL/)
  assert.match(js, /new Blob\(/)
})

test('the viewer releases blob URLs on teardown', () => {
  // A blob: URL is a live reference — the browser will not reclaim the bytes
  // while one exists, so a viewer that never revokes leaks every image.
  const js = viewerScript()
  assert.match(js, /revokeObjectURL/)
  assert.match(js, /pagehide/)
})

test('image arrival re-measures, coalesced', () => {
  /*
   * An image changes layout, which moves every page anchor below it — so the
   * geometry has to be recomputed once images land. But measuring per image
   * would be O(images) full passes; the settle timer collapses a flurry into
   * one.
   */
  const js = viewerScript()
  const fn = js.slice(js.indexOf('function onImageSettled'), js.indexOf("window.addEventListener('pagehide'"))
  assert.match(fn, /settleTimer/)
  assert.match(fn, /measure\(\)/)
})

test('attaching an image never recounts pages', () => {
  // Same invariant as the chapter streaming: `totalPages` comes from the whole
  // book's character count at parse time and must not drift as images arrive.
  const js = viewerScript()
  const region = js.slice(js.indexOf('function attachImage'), js.indexOf("window.addEventListener('pagehide'"))
  assert.doesNotMatch(region, /contentPages\s*=/)
})

test('one token can fill several elements', () => {
  /*
   * A cover reused as a chapter plate is one zip entry referenced twice. The
   * bytes are delivered once, so the viewer has to apply them to every matching
   * element — `querySelectorAll`, not `querySelector`.
   */
  const js = viewerScript()
  const region = js.slice(js.indexOf('function attachImage'), js.indexOf('function onImageSettled'))
  assert.match(region, /querySelectorAll\('\[data-sr-img=/)
})

test('the viewer still loads nothing from the filesystem or network', () => {
  /*
   * The load-bearing security property of this whole approach. The alternative
   * to blobs was pointing the WebView at extracted files, which on Android has
   * no scoped form — `allowFileAccess` is all-or-nothing across the app
   * sandbox. Blobs keep the viewer unable to reach the filesystem at all.
   */
  const html = buildViewerHtml(THEME, 0)
  assert.doesNotMatch(html, /<script[^>]+src=/i, 'viewer loads an external script')
  assert.doesNotMatch(html, /https?:\/\/(?!example\.com)/i, 'viewer references a remote origin')
  assert.doesNotMatch(html, /file:\/\//i, 'viewer references the filesystem')
})
