import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PERF, beginPrepare, now, perf, reportStartup } from '../ui/perf.ts'

/*
 * The instrumentation added by R0-1.
 *
 * Two properties are worth pinning, and they pull in opposite directions.
 *
 * The first is that **it is inert by default**. `__DEV__` does not exist under
 * Node, so importing this module here exercises exactly the path a release
 * bundle takes — and the whole design rests on that path allocating nothing and
 * printing nothing. A regression there is invisible on a device (a dev build
 * has `__DEV__` true, so it looks fine) and only shows up as a slow release
 * build, which is the hardest kind of problem to attribute.
 *
 * The second is that the arithmetic is right when it *is* on. `assemble` is
 * computed as a remainder rather than measured, so a segment that goes
 * unreported does not merely lose a number — it silently inflates a different
 * one. That is the failure mode the offload fallback comment warns about, and
 * it deserves a test rather than a comment alone.
 */

test('timing is off under Node, which is the release path', () => {
  assert.equal(PERF, false, '__DEV__ is undefined here, so PERF must be false')
  assert.equal(now(), 0, 'now() must not call into Date when timing is off')
})

test('an inert trace prints nothing and allocates no per-call state', () => {
  const lines: string[] = []
  const original = console.log
  console.log = (line: string) => void lines.push(line)

  try {
    const a = beginPrepare('epub', 8_000_000, 'user')
    const b = beginPrepare('comic', 1_000, 'prefetch')
    a.read(10)
    a.cross(20)
    a.unzip(30)
    a.done()
    b.done()
    perf('this must not print either')
    reportStartup()
  } finally {
    console.log = original
  }

  assert.deepEqual(lines, [], 'nothing may reach the console when PERF is false')

  /*
   * The same object, not merely an equivalent one.
   *
   * `beginPrepare` returns a shared no-op when timing is off, so preparing a
   * thousand documents allocates one trace rather than a thousand. Comparing
   * identity is the only way to assert that; a structural check would pass on
   * a version that allocated per call.
   */
  assert.equal(
    beginPrepare('a', 0, 'user'),
    beginPrepare('b', 1, 'prefetch'),
    'the disabled trace must be a shared singleton, not a fresh object per document',
  )
})

/**
 * The `assemble` remainder, checked directly.
 *
 * `beginPrepare` derives it as `total - read - cross - unzip`, which cannot be
 * exercised through the real module here because `PERF` is false under Node.
 * Reimplementing the one line is a duplicate, and normally that is exactly what
 * these tests avoid — but the property being pinned is *the arithmetic*, and
 * the alternative is no coverage of it at all.
 *
 * What this protects: a segment that is never reported does not go missing, it
 * lands in `assemble`. So an untimed read makes the parser look slow, which is
 * a wrong conclusion rather than an absent one — and it is the shape the
 * offload fallback path would have had without its own timing.
 */
function assembleOf(total: number, read: number, cross: number, unzip: number): number {
  return Math.max(0, total - read - cross - unzip)
}

test('assemble is the remainder, and an unreported segment inflates it', () => {
  assert.equal(assembleOf(100, 10, 20, 30), 40, 'the segments should account for the total')

  // The failure this guards: the unzip goes unrecorded, so its cost is
  // attributed to assembly and the parser takes the blame.
  assert.equal(
    assembleOf(100, 10, 20, 0),
    70,
    'an unreported segment is absorbed by assemble rather than dropped',
  )
})

test('assemble never goes negative when segments overlap', () => {
  /*
   * Not hypothetical. `read` is wall time around an await and `cross` is
   * derived by subtracting a figure the worklet measured on another thread, so
   * the two clocks can disagree by a millisecond or two on a busy device. A
   * negative assemble would be nonsense in the log and would read as a bug in
   * the parser rather than as clock skew.
   */
  assert.equal(assembleOf(50, 30, 30, 30), 0)
})
