import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  buildContext,
  findMatches,
  mergeRects,
  CONTEXT_RADIUS,
  type SearchRect,
} from '../search/types.ts'

/*
 * P10-0 — the shared hit shape.
 *
 * This module is the reason P10 is one feature rather than two, so its
 * arithmetic is worth pinning: an off-by-one in the context window or the
 * whole-word check shows up as a highlight on the wrong word, which is the kind
 * of bug that survives review because it looks right in the common case.
 */

test('finds every occurrence, with offsets into the original text', () => {
  const { hits, truncated } = findMatches('the cat sat on the mat', { text: 'the' }, 'f1')

  assert.equal(hits.length, 2)
  assert.equal(hits[0].charOffset, 0)
  assert.equal(hits[1].charOffset, 15)
  assert.equal(hits[0].length, 3)
  assert.equal(truncated, false)
})

test('matching is case-insensitive by default and exact on request', () => {
  const text = 'The THE the'

  assert.equal(findMatches(text, { text: 'the' }, 'f1').hits.length, 3)
  assert.equal(findMatches(text, { text: 'the', matchCase: true }, 'f1').hits.length, 1)
  assert.equal(findMatches(text, { text: 'THE', matchCase: true }, 'f1').hits.length, 1)
})

test('offsets stay valid for the ORIGINAL text when folding case', () => {
  // The lowercased haystack is a different string; if an offset from it were
  // used to slice the original, an uppercase-heavy document would show context
  // from the wrong place. Same length here, but the invariant is what matters.
  const text = 'AAAA needle BBBB'
  const { hits } = findMatches(text, { text: 'NEEDLE' }, 'f1')

  assert.equal(hits.length, 1)
  assert.equal(text.slice(hits[0].charOffset, hits[0].charOffset + hits[0].length), 'needle')
})

test('whole-word matching rejects matches inside longer words', () => {
  const text = 'cat concatenate cats cat.'

  const loose = findMatches(text, { text: 'cat' }, 'f1')
  assert.equal(loose.hits.length, 4, 'without the flag every substring matches')

  const strict = findMatches(text, { text: 'cat', wholeWord: true }, 'f1')
  assert.equal(strict.hits.length, 2, 'only the standalone "cat" and "cat." qualify')
  assert.equal(strict.hits[0].charOffset, 0)
  assert.equal(strict.hits[1].charOffset, 21)
})

test('whole-word boundaries work outside the Latin alphabet', () => {
  /*
   * The reason this does not use \b: that is defined over [A-Za-z0-9_], so
   * every Cyrillic letter reads as a boundary and "whole word" would match
   * inside longer words — and would behave differently per script, which is
   * worse than not offering the feature.
   */
  const russian = 'кот котенок кот'
  const hits = findMatches(russian, { text: 'кот', wholeWord: true }, 'f1').hits
  assert.equal(hits.length, 2, 'кот matched inside котенок')

  const greek = 'λόγος λόγοςX'
  assert.equal(findMatches(greek, { text: 'λόγος', wholeWord: true }, 'f1').hits.length, 1)

  // Digits are word characters too: "12" must not match inside "123".
  assert.equal(findMatches('12 123', { text: '12', wholeWord: true }, 'f1').hits.length, 1)
})

test('a rejected whole-word candidate does not stall the scan', () => {
  // The loop advances before the `continue`. Without that, the first rejected
  // candidate would be retried forever and the search would hang the thread.
  const text = 'xcatx xcatx cat'
  const hits = findMatches(text, { text: 'cat', wholeWord: true }, 'f1').hits
  assert.equal(hits.length, 1)
  assert.equal(hits[0].charOffset, 12)
})

test('overlapping matches advance past each hit rather than re-finding it', () => {
  // "aa" in "aaaa" is 2 non-overlapping matches, not 3 overlapping ones — and
  // crucially not an infinite loop.
  const hits = findMatches('aaaa', { text: 'aa' }, 'f1').hits
  assert.equal(hits.length, 2)
  assert.deepEqual(hits.map((h) => h.charOffset), [0, 2])
})

test('an empty query finds nothing instead of matching everywhere', () => {
  // indexOf('') returns 0 at every position, so without the guard this is an
  // infinite list of zero-length hits.
  assert.deepEqual(findMatches('some text', { text: '' }, 'f1').hits, [])
})

test('limit truncates and says so', () => {
  const text = 'x '.repeat(500)

  const capped = findMatches(text, { text: 'x', limit: 10 }, 'f1')
  assert.equal(capped.hits.length, 10)
  assert.equal(capped.truncated, true, 'a capped search must report that more exist')

  const complete = findMatches('x x x', { text: 'x' }, 'f1')
  assert.equal(complete.truncated, false, 'an exhaustive search must not claim truncation')
})

test('every hit carries its file id', () => {
  const hits = findMatches('a b a', { text: 'a' }, 'book-7').hits
  assert.ok(hits.every((h) => h.fileId === 'book-7'))
})

test('context is clamped at both ends of the document', () => {
  // slice() treats a negative start as "from the end", which would splice text
  // from the last page next to a match on the first.
  const text = 'needle at the very start of the document'
  const { context, contextOffset } = buildContext(text, 0, 6)

  assert.ok(context.startsWith('needle'), `got: ${context}`)
  assert.equal(contextOffset, 0)

  const tail = 'the document ends with needle'
  const end = buildContext(tail, tail.length - 6, 6)
  assert.ok(end.context.endsWith('needle'))
})

test('context collapses whitespace but keeps the match findable inside it', () => {
  const text = `lots of\n\n   whitespace   around the needle   here\ntoo`
  const at = text.indexOf('needle')
  const { context, contextOffset } = buildContext(text, at, 6)

  assert.ok(!/\s{2}/.test(context), 'runs of whitespace should collapse for a one-line row')
  assert.equal(
    context.slice(contextOffset, contextOffset + 6),
    'needle',
    'contextOffset must index the returned (collapsed) string, not the original',
  )
})

test('context never exceeds the radius by much', () => {
  const text = 'a'.repeat(500) + 'needle' + 'b'.repeat(500)
  const { context } = buildContext(text, 500, 6)
  assert.ok(
    context.length <= CONTEXT_RADIUS * 2 + 6,
    'a snippet should be a row, not a paragraph',
  )
})

test('findMatches produces context that actually contains the match', () => {
  const text = 'chapter one. the quick brown fox jumps. chapter two.'
  for (const hit of findMatches(text, { text: 'chapter' }, 'f1').hits) {
    assert.equal(
      hit.context.slice(hit.contextOffset, hit.contextOffset + hit.length),
      'chapter',
      'a result row must be able to embolden its own match',
    )
  }
})

const rect = (left: number, top: number, right: number, bottom: number): SearchRect => ({
  left,
  top,
  right,
  bottom,
})

test('adjacent rects on one line merge into a single highlight', () => {
  // pdfium reports geometry per character range, so one match arrives as a row
  // of touching boxes. Drawn separately they show seams and rounding gaps.
  const merged = mergeRects([rect(10, 100, 20, 112), rect(20, 100, 30, 112), rect(30, 100, 45, 112)])

  assert.equal(merged.length, 1)
  assert.deepEqual(merged[0], rect(10, 100, 45, 112))
})

test('rects on different lines stay separate', () => {
  // A match wrapping across a line break is two highlights, not one tall box
  // swallowing the text between them.
  const merged = mergeRects([rect(300, 100, 380, 112), rect(10, 130, 90, 142)])
  assert.equal(merged.length, 2)
})

test('merging tolerates mixed glyph sizes on the same line', () => {
  // A capital and a subscript on one line do not share a top edge, so equal
  // tops would split a highlight mid-word.
  const merged = mergeRects([rect(10, 100, 20, 116), rect(20, 104, 28, 116)])
  assert.equal(merged.length, 1, 'boxes overlapping vertically are one line')
})

test('merging is order-independent', () => {
  const forward = mergeRects([rect(10, 100, 20, 112), rect(20, 100, 30, 112)])
  const backward = mergeRects([rect(20, 100, 30, 112), rect(10, 100, 20, 112)])
  assert.deepEqual(forward, backward)
})

test('a horizontal gap wider than the slack is not merged', () => {
  // Two separate words on one line, not one run.
  const merged = mergeRects([rect(10, 100, 20, 112), rect(60, 100, 80, 112)])
  assert.equal(merged.length, 2)
})

test('mergeRects does not mutate its input', () => {
  const input = [rect(10, 100, 20, 112), rect(20, 100, 30, 112)]
  const snapshot = JSON.stringify(input)
  mergeRects(input)
  assert.equal(JSON.stringify(input), snapshot, 'callers keep their own geometry')
})

test('degenerate rect lists pass through unharmed', () => {
  assert.deepEqual(mergeRects([]), [])
  const one = [rect(1, 2, 3, 4)]
  assert.deepEqual(mergeRects(one), one)
})

/*
 * P10-2 — the PDF half.
 *
 * The Kotlin cannot run under Node, so what is checkable here is the contract
 * between the two halves: that the native module returns the same shape the
 * viewer does, and that the JS wrapper degrades rather than throwing when the
 * native side is absent. The engine itself is verified by the rebuild.
 */

test('the native module degrades instead of throwing when absent', () => {
  const src = readFileSync(
    new URL('../../modules/pdf-text/src/index.ts', import.meta.url),
    'utf8',
  )

  /*
   * requireOptionalNativeModule, not requireNativeModule.
   *
   * This module is imported by the reader, and a JS bundle routinely reaches a
   * device whose binary predates a new native module — that is what Fast
   * Refresh *is*. The non-optional form throws at import time, so the failure
   * would not be "PDF search is unavailable" but "the reader will not load".
   * The same reasoning already governs the deferred view-shot import.
   */
  assert.ok(
    src.includes('requireOptionalNativeModule'),
    'a missing native module must not take the reader down with it',
  )
  assert.ok(
    /export function isAvailable\(\): boolean/.test(src),
    'callers need to ask before offering the affordance',
  )
  assert.ok(
    /if \(!native\) return \{ hits: \[\], truncated: false \}/.test(src),
    'search must return an empty result rather than throwing when unavailable',
  )
})

test('the native search result is mapped into the shared hit shape', () => {
  const src = readFileSync(
    new URL('../../modules/pdf-text/src/index.ts', import.meta.url),
    'utf8',
  )

  // The whole point of P10-0: a PDF hit and an EPUB hit are the same thing.
  for (const field of ['fileId', 'charOffset', 'length', 'context', 'contextOffset', 'page', 'rects']) {
    assert.ok(
      new RegExp(`${field}:`).test(src),
      `a mapped hit must carry ${field}`,
    )
  }
})

test('the Kotlin module pins the pdfium version the renderer already uses', () => {
  const gradle = readFileSync(
    new URL('../../modules/pdf-text/android/build.gradle', import.meta.url),
    'utf8',
  )
  const rnPdf = readFileSync(
    new URL('../../node_modules/react-native-pdf/android/build.gradle', import.meta.url),
    'utf8',
  )

  const ours = gradle.match(/io\.legere:pdfiumandroid:([\d.]+)/)?.[1]
  const theirs = rnPdf.match(/io\.legere:pdfiumandroid:([\d.]+)/)?.[1]

  assert.ok(ours, 'the module must declare pdfium explicitly')
  assert.equal(
    ours,
    theirs,
    'a version mismatch would put two copies of the native pdfium binary in the APK, ' +
      'or silently change what the renderer runs against',
  )
})

test('the Kotlin closes every native handle it opens', () => {
  const kt = readFileSync(
    new URL('../../modules/pdf-text/android/src/main/java/expo/modules/pdftext/PdfTextModule.kt', import.meta.url),
    'utf8',
  )

  /*
   * Every pdfium object owns a native allocation the JVM's collector knows
   * nothing about, so a missed close leaks for the life of the process — and no
   * amount of memory pressure reclaims it.
   */
  assert.ok(/newDocument\(fd\)\.use/.test(kt), 'the document must be closed')
  assert.ok(/openPage\(index\)\.use/.test(kt), 'each page must be closed')
  assert.ok(/openTextPage\(\)\.use/.test(kt), 'each text page must be closed')
  assert.ok(
    /finally \{[\s\S]{0,300}?find\.closeFind\(\)/.test(kt),
    'a FindResult holds its own handle and is not closed by the text page',
  )
})

test('the Kotlin opens its own document rather than sharing the renderer state', () => {
  const kt = readFileSync(
    new URL('../../modules/pdf-text/android/src/main/java/expo/modules/pdftext/PdfTextModule.kt', import.meta.url),
    'utf8',
  )

  // Sharing a handle with the rendering view is what crashed inside
  // FPDF_LoadPage and forced the pager to mount a single file.
  assert.ok(
    /private fun <T> withDocument/.test(kt),
    'every call must open and close its own document',
  )
})

test('page offsets account for the separator between pages', () => {
  const kt = readFileSync(
    new URL('../../modules/pdf-text/android/src/main/java/expo/modules/pdftext/PdfTextModule.kt', import.meta.url),
    'utf8',
  )

  /*
   * extractText joins pages with a newline, so a search offset must advance by
   * charCount + 1 per page or every hit after page one is off by the number of
   * pages before it — a drift that grows through the document and would look
   * like a pdfium bug rather than an arithmetic one.
   */
  assert.ok(
    /documentOffset \+= charCount \+ 1/.test(kt),
    'search offsets must index the same string extractText produces',
  )
})
