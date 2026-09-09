import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dropIds, oneId } from '../store/derived.ts'

/*
 * The identity guarantee behind `pdfsNeedingCovers`.
 *
 * `PdfCoverFactory` mounts a live pdfium view per candidate and works through
 * the list one at a time. Handing it a fresh array when nothing changed
 * restarts that work — so this is a correctness property, not a performance
 * one, and it is the property `useShallow` used to provide before the list
 * became a value the store maintains ([AUDIT2 §3.2](../../AUDIT2.md)).
 *
 * Worth testing behaviourally rather than by grepping the source: the previous
 * version of this assertion lived in `perceivedSpeed.test.ts` as a regex for
 * `useShallow` near the function, and it kept passing after the implementation
 * changed because the match landed on an unrelated docstring two functions
 * below. A pure function and a real call are what make the check honest.
 */

test('a list with no matching id keeps its identity', () => {
  const ids = ['a', 'b', 'c']

  assert.equal(dropIds(ids, oneId('zzz')), ids, 'no match must return the same array')
  assert.equal(dropIds(ids, new Set()), ids, 'an empty removal set must return the same array')
})

test('an empty list keeps its identity', () => {
  const empty: string[] = []
  assert.equal(dropIds(empty, oneId('a')), empty)
})

test('a matching id is removed, and only then is a new array built', () => {
  const ids = ['a', 'b', 'c']
  const next = dropIds(ids, oneId('b'))

  assert.notEqual(next, ids, 'a real removal must produce a new array')
  assert.deepEqual(next, ['a', 'c'])
  assert.deepEqual(ids, ['a', 'b', 'c'], 'the input must not be mutated')
})

test('several ids are removed at once', () => {
  // The group-deletion path removes every file in the row in one update.
  const ids = ['a', 'b', 'c', 'd']
  assert.deepEqual(dropIds(ids, new Set(['a', 'c'])), ['b', 'd'])
})

test('the whole list can be removed', () => {
  const ids = ['a', 'b']
  assert.deepEqual(dropIds(ids, new Set(['a', 'b'])), [])
})

test('the shared scratch set does not leak between calls', () => {
  /*
   * `oneId` reuses one `Set` to avoid allocating per `setThumb`, which fires
   * once per generated thumbnail across a whole import. That is only safe while
   * `dropIds` reads it synchronously and never retains it — so the failure this
   * guards is a cover queue that drops entries because a previous call's id was
   * still in the set.
   */
  const ids = ['a', 'b', 'c']

  assert.deepEqual(dropIds(ids, oneId('a')), ['b', 'c'])
  assert.deepEqual(dropIds(ids, oneId('b')), ['a', 'c'])
  assert.equal(dropIds(ids, oneId('zzz')), ids, 'a stale id must not survive into the next call')
})

test('the common case for a thumbnail that is not a PDF cover is a no-op', () => {
  /*
   * The case that actually dominates. Most `setThumb` calls are EPUB and comic
   * covers, whose ids were never in this list — so importing thirty books must
   * hand the factory the same array thirty times.
   */
  const ids = ['pdf-1', 'pdf-2']
  let current = ids
  for (let i = 0; i < 30; i++) current = dropIds(current, oneId('epub-' + i))

  assert.equal(current, ids, 'thirty unrelated thumbnails must not change the reference once')
})
