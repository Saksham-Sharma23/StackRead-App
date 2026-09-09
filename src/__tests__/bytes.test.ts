import { test } from 'node:test'
import assert from 'node:assert/strict'

import { toBase64, mimeForImage } from '../renderers/webview/bytes.ts'

/*
 * These two functions existed as copy-pasted pairs until they were merged, and
 * both copies had already drifted (DETAIL.md §6.12). The tests below pin the
 * two properties that the drift broke, so a future divergence is a failing test
 * rather than a wrong image type on a cover nobody looks at closely.
 */

test('base64 round-trips', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 255])
  assert.deepEqual(new Uint8Array(Buffer.from(toBase64(bytes), 'base64')), bytes)
})

test('base64 handles an input larger than one chunk', () => {
  // The chunk size is 8KB and it is load-bearing: fromCharCode spreads a chunk
  // into arguments, so a large chunk overflows the argument stack. This is the
  // case that crashed on a large comic page.
  const big = new Uint8Array(0x2000 * 3 + 17)
  for (let i = 0; i < big.length; i++) big[i] = i % 256
  assert.deepEqual(new Uint8Array(Buffer.from(toBase64(big), 'base64')), big)
})

test('base64 of nothing is nothing', () => {
  assert.equal(toBase64(new Uint8Array(0)), '')
})

test('image MIME covers every type either caller inlines', () => {
  // The EPUB copy knew SVG but not AVIF; the archive copy the reverse. An AVIF
  // cover in an EPUB was served as image/jpeg.
  assert.equal(mimeForImage('a/b/c.png'), 'image/png')
  assert.equal(mimeForImage('cover.AVIF'), 'image/avif')
  assert.equal(mimeForImage('fig.svg'), 'image/svg+xml')
  assert.equal(mimeForImage('x.webp'), 'image/webp')
  assert.equal(mimeForImage('x.gif'), 'image/gif')
  assert.equal(mimeForImage('x.bmp'), 'image/bmp')
})

test('an unknown image extension falls back to JPEG', () => {
  // A plausible wrong type still renders; no type at all does not.
  assert.equal(mimeForImage('mystery.xyz'), 'image/jpeg')
  assert.equal(mimeForImage('noextension'), 'image/jpeg')
})
