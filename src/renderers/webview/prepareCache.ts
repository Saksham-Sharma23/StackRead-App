import type { Prepared } from './prepare'

/**
 * Prepared documents held in memory, keyed by file id.
 *
 * ## Why this exists
 *
 * The pager mounts only the active file (see HorizontalPager), so swiping away
 * from a book unmounts it and swiping back re-runs `prepareFile` from scratch:
 * unzip the EPUB, assemble every chapter, base64-encode every image. For a big
 * illustrated book that is seconds of work and tens of megabytes of string
 * building — paid again on every single visit.
 *
 * Mounting neighbours instead would fix the wait and reintroduce the crash that
 * made single-mounting necessary: three live pdfium documents, or three whole
 * books parsed at once. Caching the *result* keeps one renderer mounted while
 * making a return trip free.
 *
 * ## The pinned window
 *
 * The reader's guarantee is that the files immediately left and right of the
 * current one open instantly. That is a promise about three specific files, so
 * those three are **pinned**: never evicted, whatever else is going on.
 * Everything else — files visited earlier, neighbours of a group since left —
 * lives in an ordinary LRU tail and is evicted freely.
 *
 * A plain LRU cannot express this, and the first version of this file got it
 * wrong in exactly that way. Under pressure an LRU evicts by recency, and the
 * neighbours are *always* less recently used than the file being read — so a
 * byte-budgeted LRU throws away precisely the two files this feature exists to
 * keep. Hence an explicit pin rather than a cleverer ordering.
 *
 * ## Why the tail is budgeted in bytes
 *
 * Entries are wildly different sizes: a 2KB text file and a 20MB illustrated
 * EPUB both count as "one". An entry-counted cache holding three large books is
 * ~60MB, which is the memory exhaustion the inline-image budget exists to
 * prevent. So the tail's budget is expressed in the same currency as the risk.
 */

/**
 * Budget for the unpinned tail.
 *
 * Deliberately modest: the pinned window is where the user-visible speed comes
 * from, and the tail only helps someone swinging back and forth across a group.
 * Trading tail size for a higher chance of the OS killing the app is a bad deal
 * — being killed loses the reading position, a reparse costs a second.
 */
const MAX_TAIL_BYTES = 24_000_000

/** Hard ceiling on tail entries, so many tiny files cannot grow it unbounded. */
const MAX_TAIL_ENTRIES = 6

interface Entry {
  prepared: Prepared
  bytes: number
  /**
   * Whether this entry has been read since it was inserted.
   *
   * The whole of S3-FIFO's insight in one boolean: an entry read a second time
   * has demonstrated it is worth keeping, and an entry never read again has
   * demonstrated the opposite. Eviction consults this before recency.
   */
  reused: boolean
}

/*
 * A Map plus one flag per entry: JS Maps keep insertion order, so the first key
 * is always the oldest. No list plumbing, no timestamps.
 */
const cache = new Map<string, Entry>()

/**
 * Ids evicted recently, without their content — S3-FIFO's "ghost" queue.
 *
 * An id here means "this was cached and thrown away". If it comes back, it was
 * evicted too eagerly, so its second insertion enters already marked as reused
 * and survives the next pass. That is what stops a file the reader keeps
 * returning to from being evicted over and over by files opened once.
 *
 * Bounded and holds no `Prepared`, so its cost is a few hundred bytes of ids
 * rather than anything measurable against the byte budget.
 */
const ghosts = new Set<string>()

/**
 * How many evictions the ghost queue remembers.
 *
 * Derived from `MAX_TAIL_ENTRIES`, not picked: the queue's only job is to
 * remember an eviction long enough to recognise the file coming back, so what
 * it has to span is the number of *distinct other files* the reader can touch
 * in between. That is the tail's capacity, and 32 is a little over five times
 * it — the ratio S3-FIFO's authors use, where the ghost queue is sized well
 * above the cache it shadows because remembering an id is orders of magnitude
 * cheaper than holding the entry. It lands on 30 where the previous hand-picked
 * value was 32; the two are the same number for every purpose this serves, and
 * one of them can be re-derived when the tail is resized.
 *
 * The failure modes are asymmetric, which is why the generous side is right.
 * Too small and a reader alternating between two books past the window sees
 * neither promoted — every open re-prepares, which is the exact thrash this
 * queue exists to stop. Too large and the cost is 32 strings and a stale
 * promotion for a file opened once a month, which resolves itself on the next
 * eviction pass.
 *
 * Sized in ids, deliberately not in bytes: a ghost holds no `Prepared`, so the
 * whole queue is a few hundred bytes against a 24 MB budget and does not belong
 * in that accounting at all.
 */
const MAX_GHOSTS = 5 * MAX_TAIL_ENTRIES

function rememberGhost(fileId: string): void {
  // Oldest out first: a Set iterates in insertion order, so the first key is
  // the least recently evicted.
  if (ghosts.size >= MAX_GHOSTS) {
    const oldest = ghosts.values().next().value
    if (oldest !== undefined) ghosts.delete(oldest)
  }
  ghosts.add(fileId)
}

/**
 * Ids that must not be evicted: the current file and its immediate neighbours.
 *
 * Held separately from the Map so pinning survives eviction passes and does not
 * depend on insertion order. Set by the reader on every page turn.
 */
let pinned: ReadonlySet<string> = new Set()

/** Bytes held by unpinned entries only — the pinned window is not budgeted. */
function tailBytes(): number {
  let total = 0
  for (const [id, entry] of cache) {
    if (!pinned.has(id)) total += entry.bytes
  }
  return total
}

/** Unpinned entry count. */
function tailCount(): number {
  let n = 0
  for (const id of cache.keys()) if (!pinned.has(id)) n += 1
  return n
}

/**
 * Approximate in-memory size of a prepared document.
 *
 * `content` dominates by orders of magnitude — it is the whole book — so the
 * TOC and the handful of numbers are not worth measuring. Doubled because the
 * string is UTF-16 in memory; the exact figure does not matter, only that it
 * scales with the real cost.
 */
function sizeOf(prepared: Prepared): number {
  // UTF-16 in memory, so a character is two bytes. The exact figure does not
  // matter; only that it scales with the real cost.
  let bytes = prepared.content.length * 2

  // Deferred chapters are held here too until the viewer has taken them.
  if (prepared.rest) {
    for (const chunk of prepared.rest) bytes += chunk.length * 2
  }

  /*
   * Images must be counted, and this is easy to get wrong.
   *
   * They used to live inside `content` as base64, so measuring the string
   * covered them. Now they are raw `Uint8Array`s alongside it — so a cache that
   * only measured `content` would report a 20MB illustrated book as a few
   * hundred kilobytes of text and happily hold several of them, which is
   * exactly the memory exhaustion the byte budget exists to prevent.
   *
   * Counted once, as bytes, since that is what a Uint8Array actually occupies.
   */
  if (prepared.images) {
    for (const image of prepared.images) bytes += image.bytes.length
  }

  /*
   * Referenced images cost nothing here, and that is the point.
   *
   * The EPUB path now registers images by path and size rather than decompressing
   * them, so a fully-parsed illustrated book is markup plus a list of names —
   * kilobytes, where it used to be up to 24MB per entry with three of them
   * pinned at once ([AUDIT2 §1.2](../../AUDIT2.md)). The bytes are fetched by
   * `loadImages` at delivery time and never enter this cache.
   *
   * Stated rather than left implicit because the omission looks like the
   * accounting bug this function's docstring warns about, and is the opposite
   * of one.
   */

  return bytes
}

/**
 * Declares which files must stay resident.
 *
 * Called by the reader with the current file and its immediate neighbours. A
 * file that drops out of the window is not discarded — it becomes an ordinary
 * tail entry and survives until the tail budget needs its bytes, which is what
 * makes swiping back and forth across the same few files free rather than a
 * cycle of reparses.
 */
export function setPinned(ids: readonly string[]): void {
  pinned = new Set(ids)
  evict()
}

export function getPrepared(fileId: string): Prepared | undefined {
  const hit = cache.get(fileId)
  if (!hit) return undefined

  /*
   * Marked as reused rather than moved to the end.
   *
   * This is the S3-FIFO change. A pure LRU promotes on every read, so its
   * eviction order is recency alone — and recency is exactly the wrong signal
   * here: a file opened once and abandoned is *more* recent than one the reader
   * keeps coming back to, so the LRU evicts the wrong entry precisely for
   * someone working through a group repeatedly, which is what this app is for.
   *
   * Setting a flag instead keeps insertion order intact (so eviction is still a
   * simple scan from the front) while recording the one fact that matters:
   * whether anything ever came back for this entry.
   */
  hit.reused = true
  return hit.prepared
}

/**
 * Whether a file is cached, **without** marking it recently used.
 *
 * `getPrepared` promotes on read, which is right for a real read and wrong for
 * a background check: prefetch probes every neighbour on every page turn, so
 * using the promoting reader would let files the user never opened outrank the
 * ones they did, and evict the wrong things.
 */
export function hasPrepared(fileId: string): boolean {
  return cache.has(fileId)
}

export function setPrepared(fileId: string, prepared: Prepared): void {
  // Replacing an existing entry must not leave the old one behind.
  cache.delete(fileId)

  const bytes = sizeOf(prepared)

  /*
   * An unpinned document larger than the whole tail budget is not cached.
   *
   * Storing it would evict everything else and still not fit. A *pinned* one is
   * kept regardless of size: the window is a guarantee rather than an
   * optimisation, and a book too large to cache is exactly the one whose
   * reparse hurts most.
   */
  if (!pinned.has(fileId) && bytes > MAX_TAIL_BYTES) return

  /*
   * An id in the ghost queue was cached and evicted before. Its return is
   * evidence the eviction was premature, so it comes back already marked as
   * reused and survives one eviction pass — which is what stops a file the
   * reader keeps revisiting from being thrown away on every cycle.
   */
  const returning = ghosts.has(fileId)
  if (returning) ghosts.delete(fileId)

  cache.set(fileId, { prepared, bytes, reused: returning })
  evict()
}

/**
 * Trims unpinned entries until the tail is back inside its limits.
 *
 * ## S3-FIFO, in the smallest form that works
 *
 * Scanning from the oldest entry forward:
 *
 *  - an entry **never read again** is evicted, and its id is remembered as a
 *    ghost;
 *  - an entry **that was read** is given one more round: its flag is cleared
 *    and it moves to the back, so it survives this pass but not the next one
 *    unless it is read again.
 *
 * That is the whole algorithm. One-hit wonders — a file opened once while
 * browsing — leave quickly, and a file the reader keeps returning to has to
 * fall out of use entirely before it goes. A plain LRU cannot express that,
 * because from its point of view the file opened once and never revisited is
 * the *most* recent thing in the cache.
 *
 * The second-chance pass is bounded: each entry can be demoted at most once per
 * call, tracked by `spared`, so a cache where every entry is reused terminates
 * by evicting the oldest rather than cycling forever.
 */
function evict(): void {
  let spared = 0

  while (tailCount() > MAX_TAIL_ENTRIES || tailBytes() > MAX_TAIL_BYTES) {
    let victim: string | undefined
    let entry: Entry | undefined

    for (const [id, candidate] of cache) {
      if (pinned.has(id)) continue
      victim = id
      entry = candidate
      break
    }

    /*
     * Nothing evictable left. The pinned window alone is over budget, which is
     * permitted: three large books resident is the cost of the guarantee, and
     * `clearPrepared()` on backgrounding is what stops that being permanent.
     */
    if (victim === undefined || entry === undefined) return

    // Read since insertion: one more round, at the back of the queue.
    if (entry.reused && spared < cache.size) {
      spared += 1
      entry.reused = false
      cache.delete(victim)
      cache.set(victim, entry)
      continue
    }

    cache.delete(victim)
    rememberGhost(victim)
  }
}

/** Drops one file, for when its bytes change or it is removed from the library. */
export function forgetPrepared(fileId: string): void {
  cache.delete(fileId)
}

/** Drops everything, pins included — call under memory pressure. */
export function clearPrepared(): void {
  cache.clear()
  pinned = new Set()
  // The ghosts describe a cache that no longer exists; keeping them would give
  // an unrelated later insert an undeserved second chance.
  ghosts.clear()
}

/** Cache contents, for tests and debugging. */
export function prepareCacheStats(): {
  entries: number
  bytes: number
  pinned: number
  tailBytes: number
} {
  let bytes = 0
  for (const entry of cache.values()) bytes += entry.bytes

  let pinnedResident = 0
  for (const id of cache.keys()) if (pinned.has(id)) pinnedResident += 1

  return { entries: cache.size, bytes, pinned: pinnedResident, tailBytes: tailBytes() }
}
