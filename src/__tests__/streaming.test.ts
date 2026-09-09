import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildViewerHtml } from '../renderers/webview/viewerHtml.ts'

/*
 * Progressive delivery splits a book between the first paint and a series of
 * appends. Two properties have to hold, and both are the kind that fail
 * silently:
 *
 *  - The page count must stay derived from the *whole* book. A streaming loader
 *    is the obvious place to accidentally count only what has been delivered,
 *    which would make the total climb as you read — the exact class of bug
 *    DETAIL.md 5.2 exists to prevent.
 *  - A chapter must never be split across batches. `.sr-chapter` boundaries are
 *    what TOC links resolve against, so half a chapter means a link that lands
 *    nowhere.
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

/**
 * Mirrors the packing loop in `epub.ts`.
 *
 * `loadEpubAsHtml` reads a real file through `expo-file-system`, so the split
 * itself is reproduced here and run against synthetic chapters — the arithmetic
 * is the part worth pinning.
 */
function split(
  chapters: string[],
  firstPaintChars: number,
  batchChars: number,
): { first: string[]; rest: string[] } {
  const first: string[] = []
  const rest: string[] = []
  let firstLen = 0
  let batchLen = 0
  let batch: string[] = []

  for (const chapter of chapters) {
    if (firstLen < firstPaintChars) {
      first.push(chapter)
      firstLen += chapter.length
      continue
    }
    batch.push(chapter)
    batchLen += chapter.length
    if (batchLen >= batchChars) {
      rest.push(batch.join('\n'))
      batch = []
      batchLen = 0
    }
  }
  if (batch.length) rest.push(batch.join('\n'))

  return { first, rest }
}

const chapter = (id: number, size: number) =>
  `<div class="sr-chapter" data-src="ch${id}.xhtml">${'x'.repeat(size)}</div>`

test('a short book is delivered whole, with nothing deferred', () => {
  // Below the first-paint budget there is no reason to stream, and streaming it
  // anyway would add bridge round-trips for no benefit.
  const chapters = [chapter(1, 500), chapter(2, 500)]
  const { first, rest } = split(chapters, 120_000, 250_000)

  assert.equal(first.length, 2)
  assert.equal(rest.length, 0)
})

test('a long book defers everything past the first-paint budget', () => {
  const chapters = Array.from({ length: 40 }, (_, i) => chapter(i, 20_000))
  const { first, rest } = split(chapters, 120_000, 250_000)

  assert.ok(first.length > 0, 'first paint must not be empty')
  assert.ok(rest.length > 0, 'a long book should have deferred batches')
  // Every chapter is accounted for exactly once.
  const delivered = first.length + rest.join('\n').split('sr-chapter').length - 1
  assert.equal(delivered, chapters.length)
})

test('chapters are never split across batch boundaries', () => {
  // A chapter cut in half would break `seekToHref`, which matches on data-src.
  const chapters = Array.from({ length: 30 }, (_, i) => chapter(i, 30_000))
  const { rest } = split(chapters, 60_000, 100_000)

  for (const batch of rest) {
    // Each opening div must have a matching closing one inside the same batch.
    const opens = batch.split('<div class="sr-chapter"').length - 1
    const closes = batch.split('</div>').length - 1
    assert.equal(opens, closes, 'a batch contains a partial chapter')
  }
})

test('an oversized first chapter still paints rather than deferring everything', () => {
  // A single chapter larger than the whole budget must not produce an empty
  // first paint — an empty screen is worse than a slow one.
  const chapters = [chapter(1, 400_000), chapter(2, 1_000)]
  const { first } = split(chapters, 120_000, 250_000)
  assert.ok(first.length >= 1)
})

test('the viewer appends without re-rendering the document', () => {
  /*
   * Re-assigning innerHTML would re-parse the entire book on every batch and
   * throw away every already-decoded image. insertAdjacentHTML appends without
   * disturbing what is on screen — which is what makes it safe to grow the
   * document under a reader who is already scrolling.
   */
  const js = viewerScript()
  assert.match(js, /insertAdjacentHTML\('beforeend'/)
  assert.match(js, /function appendChunk/)
})

test('the viewer parks a seek whose target has not arrived yet', () => {
  // With progressive delivery a TOC tap or a restored position can name content
  // still in flight. Dropping it silently is the failure this guards.
  const js = viewerScript()
  assert.match(js, /pendingHref/)
  assert.match(js, /pendingScroll/)
})

test('appending re-measures but does not recount pages', () => {
  /*
   * `measure()` must run so new anchors and image offsets are picked up, but
   * `contentPages` is set only by `render` — from the whole book's character
   * total. If appending touched it, the page count would climb while reading.
   */
  const js = viewerScript()
  const append = js.slice(js.indexOf('function appendChunk'), js.indexOf('if (window.visualViewport)'))
  assert.match(append, /measure\(\)/, 'appendChunk must re-measure')
  assert.doesNotMatch(append, /contentPages\s*=/, 'appendChunk must not alter the page count')
})
