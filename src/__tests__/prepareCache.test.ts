import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  getPrepared,
  setPrepared,
  forgetPrepared,
  clearPrepared,
  prepareCacheStats,
  hasPrepared,
  setPinned,
} from '../renderers/webview/prepareCache.ts'
import type { Prepared } from '../renderers/webview/prepare.ts'

/*
 * The cache exists because the pager mounts only the active file, so swiping
 * back to a book re-parses it from scratch — seconds of work and up to 24MB of
 * string building for an illustrated EPUB.
 *
 * Its eviction is by *bytes*, not entries, and that is the part worth testing:
 * a count-based cache holding three maximal EPUBs is ~72MB, which is the memory
 * exhaustion the inline-image budget exists to prevent. These tests pin that
 * the byte accounting stays honest across replace, evict and forget — the paths
 * where a leak would be silent and would only show up as the OS killing the app.
 */

/** A prepared document whose `content` is `bytes / 2` chars (UTF-16). */
function doc(bytes: number, marker = 'x'): Prepared {
  return {
    format: 'epub',
    content: marker.repeat(Math.max(1, Math.floor(bytes / 2))),
    mode: 'paper',
    totalPages: 1,
  }
}

/** A prepared document carrying `imageBytes` of streamed image data. */
function docWithImages(contentBytes: number, imageBytes: number): Prepared {
  return {
    ...doc(contentBytes),
    images: [
      { token: 'sr-img-0', mime: 'image/jpeg', bytes: new Uint8Array(imageBytes) },
    ],
  }
}

beforeEach(() => clearPrepared())

test('cached size counts streamed images, not just the markup', () => {
  /*
   * Images used to live inside `content` as base64, so measuring the string
   * covered them. They are now raw bytes alongside it — and a `sizeOf` that
   * still only measured `content` would report a 20MB illustrated book as a few
   * hundred kilobytes of text, hold several of them, and reproduce exactly the
   * memory exhaustion the byte budget exists to prevent.
   *
   * This is the kind of accounting that regresses silently: nothing fails, the
   * app just gets killed by the OS more often.
   */
  setPinned([])
  setPrepared('illustrated', docWithImages(2_000, 5_000_000))

  const stats = prepareCacheStats()
  assert.ok(
    stats.bytes >= 5_000_000,
    `images were not counted: cache reports ${stats.bytes} bytes for a 5MB image`,
  )
})

test('cached size counts deferred chapters', () => {
  // `rest` is held in the cache until the viewer takes it, so it is real
  // resident memory for as long as the entry lives.
  setPinned([])
  const base = doc(2_000)
  setPrepared('streamed', { ...base, rest: ['y'.repeat(500_000)] })

  assert.ok(
    prepareCacheStats().bytes >= 1_000_000,
    'deferred chapters were not counted toward the cache budget',
  )
})

test('an oversized illustrated book is refused by its true size', () => {
  /*
   * The consequence of the two tests above. A book whose *text* is small but
   * whose images blow the tail budget must be refused like any other oversized
   * entry — under the old accounting it would have been admitted, evicting
   * everything else to make room for something that does not fit.
   */
  setPinned([])
  setPrepared('huge-plates', docWithImages(2_000, 40_000_000))
  assert.equal(hasPrepared('huge-plates'), false)
})

test('a stored document comes back', () => {
  setPrepared('a', doc(1000, 'a'))
  assert.equal(getPrepared('a')?.content[0], 'a')
})

test('an absent document is undefined, not an error', () => {
  assert.equal(getPrepared('nope'), undefined)
})

test('replacing an entry does not double-count its bytes', () => {
  // The leak that would matter most: re-preparing the same file after an edit
  // would inflate the total until everything else was evicted.
  setPrepared('a', doc(1_000_000))
  const first = prepareCacheStats().bytes
  setPrepared('a', doc(1_000_000))
  assert.equal(prepareCacheStats().bytes, first)
  assert.equal(prepareCacheStats().entries, 1)
})

test('forgetting an entry reclaims its bytes', () => {
  setPrepared('a', doc(1_000_000))
  forgetPrepared('a')
  const stats = prepareCacheStats()
  assert.equal(stats.entries, 0)
  assert.equal(stats.bytes, 0)
})

test('forgetting an absent entry is harmless', () => {
  setPrepared('a', doc(1000))
  const before = prepareCacheStats()
  forgetPrepared('ghost')
  assert.deepEqual(prepareCacheStats(), before)
})

test('the least recently used entry is evicted first', () => {
  // 7MB entries against a 24MB tail: three fit, so the fourth insert evicts
  // exactly one — which makes it observable *which* one.
  setPrepared('a', doc(7_000_000))
  setPrepared('b', doc(7_000_000))
  setPrepared('c', doc(7_000_000))
  // Touch 'a' so 'b' becomes least-recently-used.
  getPrepared('a')
  setPrepared('d', doc(7_000_000))

  assert.equal(getPrepared('b'), undefined, 'b should have been evicted')
  assert.ok(getPrepared('a'), 'a was touched and should survive')
  assert.ok(getPrepared('d'), 'd was just inserted')
})

test('total bytes stay within budget after many inserts', () => {
  for (let i = 0; i < 20; i++) setPrepared(`f${i}`, doc(5_000_000))
  assert.ok(
    prepareCacheStats().tailBytes <= 24_000_000,
    `budget exceeded: ${prepareCacheStats().tailBytes}`,
  )
})

test('entry count stays bounded for many small files', () => {
  // Tiny documents never approach the byte budget, so the entry cap is the only
  // thing stopping unbounded growth.
  for (let i = 0; i < 50; i++) setPrepared(`s${i}`, doc(1000))
  assert.ok(prepareCacheStats().entries <= 6, `too many entries: ${prepareCacheStats().entries}`)
})

test('an unpinned document larger than the whole budget is not cached', () => {
  // Storing it would evict everything and still not fit — all of the cost, none
  // of the benefit.
  setPrepared('huge', doc(40_000_000))
  assert.equal(getPrepared('huge'), undefined)
  assert.equal(prepareCacheStats().entries, 0)
})

test('an oversized document does not evict what is already cached', () => {
  setPrepared('keep', doc(1_000_000))
  setPrepared('huge', doc(40_000_000))
  assert.ok(getPrepared('keep'), 'existing entry was evicted by an uncacheable one')
})

test('clearing drops everything', () => {
  setPrepared('a', doc(1_000_000))
  setPrepared('b', doc(1_000_000))
  clearPrepared()
  const stats = prepareCacheStats()
  assert.equal(stats.entries, 0)
  assert.equal(stats.bytes, 0)
})

test('probing does not mark an entry recently used', () => {
  // Prefetch probes every neighbour on every page turn. If the probe promoted,
  // files the user never opened would outrank the ones they did.
  setPrepared('a', doc(9_000_000))
  setPrepared('b', doc(9_000_000))
  setPrepared('c', doc(9_000_000))

  hasPrepared('a') // must NOT promote 'a'
  setPrepared('d', doc(9_000_000))

  assert.equal(hasPrepared('a'), false, 'probing promoted a and saved it from eviction')
})

test('pinned neighbours survive pressure that evicts everything else', () => {
  // The whole point of the feature: left/current/right stay resident even when
  // the cache is far over its tail budget. A plain LRU fails this, because the
  // neighbours are always less recently used than the file being read.
  setPinned(['left', 'current', 'right'])
  setPrepared('left', doc(12_000_000))
  setPrepared('current', doc(12_000_000))
  setPrepared('right', doc(12_000_000))

  // Now churn the tail hard.
  for (let i = 0; i < 12; i++) setPrepared(`junk${i}`, doc(8_000_000))

  assert.ok(hasPrepared('left'), 'left neighbour was evicted')
  assert.ok(hasPrepared('current'), 'current file was evicted')
  assert.ok(hasPrepared('right'), 'right neighbour was evicted')
})

test('clearing the pins makes former neighbours evictable again', () => {
  /*
   * What `cancelPrefetch()` relies on when the reader closes.
   *
   * Pinned entries are exempt from the tail budget, so that exemption is only
   * safe while something releases it. Before this, leaving the reader left up
   * to three documents pinned forever — nothing calls `setPinned` once the
   * reader is gone — so tens of megabytes stayed un-evictable for the life of
   * the process.
   *
   * The fix is `setPinned([])` on cancel. This asserts the cache half of that
   * contract: with no pins, ordinary budget pressure reclaims them.
   */
  setPinned(['left', 'current', 'right'])
  setPrepared('left', doc(12_000_000))
  setPrepared('current', doc(12_000_000))
  setPrepared('right', doc(12_000_000))

  // Still pinned: pressure cannot touch them.
  for (let i = 0; i < 6; i++) setPrepared(`junk${i}`, doc(8_000_000))
  assert.ok(hasPrepared('current'), 'precondition: pinned entries survive')

  // Leaving the reader.
  setPinned([])
  assert.equal(prepareCacheStats().pinned, 0, 'pins were not released')

  // They are demoted, not discarded — a reopen is still a cache hit until the
  // budget actually needs the bytes.
  for (let i = 0; i < 12; i++) setPrepared(`more${i}`, doc(8_000_000))

  assert.equal(hasPrepared('left'), false, 'unpinned entry survived heavy pressure')
  assert.equal(hasPrepared('current'), false, 'unpinned entry survived heavy pressure')
  assert.equal(hasPrepared('right'), false, 'unpinned entry survived heavy pressure')
})

test('a pinned document is cached even when larger than the tail budget', () => {
  // A book too large to cache is exactly the one whose reparse hurts most.
  setPinned(['big'])
  setPrepared('big', doc(40_000_000))
  assert.ok(hasPrepared('big'))
})

test('an unpinned oversized document is still refused', () => {
  setPinned([])
  setPrepared('huge', doc(40_000_000))
  assert.equal(hasPrepared('huge'), false)
})

test('unpinning demotes rather than discards', () => {
  // Swiping one file along must not throw away the file just left — that would
  // make swiping back and forth a cycle of reparses.
  setPinned(['a', 'b', 'c'])
  setPrepared('a', doc(2_000_000))
  setPrepared('b', doc(2_000_000))
  setPrepared('c', doc(2_000_000))

  setPinned(['b', 'c', 'd']) // moved one right; 'a' falls out of the window
  assert.ok(hasPrepared('a'), 'the file just left was discarded instead of demoted')
})

test('a demoted file is evicted once the tail needs its bytes', () => {
  setPinned(['a', 'b', 'c'])
  setPrepared('a', doc(10_000_000))
  setPrepared('b', doc(1000))
  setPrepared('c', doc(1000))

  setPinned(['b', 'c', 'd'])
  for (let i = 0; i < 8; i++) setPrepared(`junk${i}`, doc(6_000_000))

  assert.equal(hasPrepared('a'), false, 'a demoted entry was never reclaimed')
  assert.ok(hasPrepared('b'), 'a pinned entry was evicted')
})

test('the tail stays within budget while pins are held', () => {
  setPinned(['p1', 'p2', 'p3'])
  setPrepared('p1', doc(12_000_000))
  setPrepared('p2', doc(12_000_000))
  setPrepared('p3', doc(12_000_000))
  for (let i = 0; i < 15; i++) setPrepared(`t${i}`, doc(5_000_000))

  const stats = prepareCacheStats()
  assert.ok(stats.tailBytes <= 24_000_000, `tail over budget: ${stats.tailBytes}`)
  assert.equal(stats.pinned, 3, 'pinned entries went missing')
})

test('clearing drops pins as well as entries', () => {
  setPinned(['a'])
  setPrepared('a', doc(1_000_000))
  clearPrepared()
  assert.equal(prepareCacheStats().entries, 0)
  // With pins cleared, an oversized document is refused again.
  setPrepared('huge', doc(40_000_000))
  assert.equal(hasPrepared('huge'), false)
})

/*
 * P12-4 — S3-FIFO eviction.
 *
 * The tail used to be pure recency, which is the wrong signal for this app: a
 * file opened once while browsing is *more recent* than one the reader keeps
 * returning to, so an LRU evicts the wrong entry precisely for someone working
 * through a group repeatedly — the thing the product is for.
 */

test('a re-read entry outlives a NEWER one-hit wonder', () => {
  /*
   * The case where S3-FIFO and LRU actually disagree, which is the only one
   * worth asserting.
   *
   * Under LRU, reading an entry promotes it to the back, so it survives simply
   * by being recent — a test built that way passes under either policy and
   * proves nothing. Here the re-read entry stays at the *front* of the queue
   * (S3-FIFO does not reorder on read) while a never-re-read entry is inserted
   * *after* it. LRU evicts from the front and would take the re-read one; S3
   * FIFO sees its reuse flag, spares it, and takes the one-hit wonder instead.
   */
  const size = 1000

  // 'loved' goes in first, so it is the oldest and the front of the queue.
  setPrepared('loved', doc(size))
  getPrepared('loved') // read again — flagged, but NOT moved

  // Five more fill the tail to its 6-entry limit.
  for (const id of ['a', 'b', 'c', 'd', 'e']) setPrepared(id, doc(size))

  // The seventh forces one eviction. LRU takes the front ('loved').
  setPrepared('f', doc(size))

  assert.ok(
    hasPrepared('loved'),
    'the re-read entry was evicted — eviction is still ordered by recency alone',
  )
  assert.ok(!hasPrepared('a'), 'the oldest never-re-read entry should have gone')
})

test('a reused entry is only spared once per pass', () => {
  /*
   * The second chance clears the flag. Without that, an entry read once would
   * be spared forever and a cache where everything had been read could never
   * evict anything — it would grow past its budget or spin.
   */
  const size = 1000
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) setPrepared(id, doc(size))
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) getPrepared(id)

  // Every entry is reused, so the budget still has to be enforced somehow.
  setPrepared('g', doc(size))
  setPrepared('h', doc(size))

  const stats = prepareCacheStats()
  assert.ok(stats.entries <= 6, `tail exceeded its entry budget: ${stats.entries}`)
})

test('eviction still terminates when every entry has been reused', () => {
  // The bounded second-chance pass. A naive implementation cycles forever here.
  const size = 5_000_000
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    setPrepared(id, doc(size))
    getPrepared(id)
  }

  setPrepared('big', doc(size))

  const stats = prepareCacheStats()
  assert.ok(stats.tailBytes <= 24_000_000, `tail over its byte budget: ${stats.tailBytes}`)
})

test('a file that returns after eviction gets a second chance', () => {
  /*
   * The ghost queue. An id that was cached, evicted and cached again is
   * evidence the eviction was premature — so it comes back already marked as
   * reused rather than being thrown away again on the very next pass.
   *
   * Arranged so a cache without ghosts fails: the returning entry is
   * re-inserted *first*, making it the oldest and therefore the next victim
   * under any front-scanning policy. Only the ghost flag saves it.
   */
  const size = 1000

  setPrepared('revisited', doc(size))
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) setPrepared(id, doc(size))
  assert.ok(!hasPrepared('revisited'), 'setup: it should have been evicted')

  // The other entries are dropped individually rather than with
  // `clearPrepared`, which would also wipe the ghost record this test is about.
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) forgetPrepared(id)

  // Re-opened, so it is re-prepared — and it is now the oldest entry present.
  setPrepared('revisited', doc(size))
  for (const id of ['g', 'h', 'i', 'j', 'k', 'l']) setPrepared(id, doc(size))

  assert.ok(
    hasPrepared('revisited'),
    'a returning file was evicted immediately again — the ghost queue is not consulted',
  )
})

test('clearing the cache also forgets the ghosts', () => {
  // Ghosts describe a cache that no longer exists; keeping them would hand an
  // unrelated later insert an undeserved second chance.
  const size = 1000

  setPrepared('x', doc(size))
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) setPrepared(id, doc(size))
  assert.ok(!hasPrepared('x'), 'setup: x should have been evicted into the ghosts')

  clearPrepared()

  setPrepared('x', doc(size))
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) setPrepared(id, doc(size))
  assert.ok(!hasPrepared('x'), 'a stale ghost survived clearPrepared')
})

test('pinned entries are still exempt from eviction entirely', () => {
  // S3-FIFO governs the tail only. The pinned window is a guarantee, and this
  // change must not have weakened it.
  const size = 5_000_000

  setPinned(['pin1', 'pin2'])
  setPrepared('pin1', doc(size))
  setPrepared('pin2', doc(size))

  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) setPrepared(id, doc(size))

  assert.ok(hasPrepared('pin1'), 'a pinned entry was evicted')
  assert.ok(hasPrepared('pin2'), 'a pinned entry was evicted')
})

test('hasPrepared does not grant a second chance', () => {
  /*
   * `hasPrepared` is documented as a non-promoting probe, because prefetch
   * checks every neighbour on every page turn. If it set the reuse flag, files
   * the user never opened would outrank the ones they did — the exact inversion
   * this cache is meant to avoid.
   */
  const size = 1000

  setPrepared('probed', doc(size))
  for (const id of ['a', 'b', 'c', 'd', 'e']) setPrepared(id, doc(size))

  hasPrepared('probed')
  setPrepared('f', doc(size))

  assert.ok(!hasPrepared('probed'), 'a background probe granted a second chance')
})


/* ==================== deferred content (R4-1) ==================== */

/*
 * Phase 2 and the images are thunks now, so neither the memory cache nor the
 * disk cache may treat an unresolved document as a complete one.
 *
 * The disk-cache half is the sharp one: `JSON.stringify` drops a function
 * silently, so a persisted entry would come back as a book that renders its
 * first chapters and then stops forever, with blank illustrations — and nothing
 * would look wrong at the point the mistake was made.
 */

test('a referenced image costs the cache nothing until it is fetched', () => {
  const base: Prepared = {
    format: 'epub',
    content: 'x'.repeat(1_000),
    mode: 'paper',
    totalPages: 10,
  }

  const withRefs: Prepared = {
    ...base,
    imageRefs: Array.from({ length: 40 }, (_, i) => ({
      token: `sr-img-${i}`,
      mime: 'image/jpeg',
    })),
    loadImages: async () => [],
  }

  clearPrepared()
  setPrepared('a', base)
  const plain = prepareCacheStats().bytes

  clearPrepared()
  setPrepared('b', withRefs)
  const referenced = prepareCacheStats().bytes

  assert.equal(
    referenced,
    plain,
    'referenced images must not be charged — their bytes are not held here',
  )
})

test('fetched image bytes are still charged', () => {
  // The counterpart. A comic still produces real bytes, and undercounting those
  // is the memory-exhaustion bug the byte budget exists to prevent.
  const withBytes: Prepared = {
    format: 'html',
    content: 'x'.repeat(1_000),
    mode: 'items',
    totalPages: 2,
    images: [
      { token: 'sr-img-0', mime: 'image/jpeg', bytes: new Uint8Array(50_000) },
      { token: 'sr-img-1', mime: 'image/jpeg', bytes: new Uint8Array(50_000) },
    ],
  }

  clearPrepared()
  setPrepared('c', withBytes)

  assert.ok(
    prepareCacheStats().bytes >= 100_000,
    'image bytes that are actually held must be counted',
  )
})
