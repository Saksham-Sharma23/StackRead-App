import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createLatestQueue } from '../renderers/webview/latestQueue.ts'

/*
 * After a fast swipe the new neighbours were never warmed: prefetch found its
 * `busy` flag set and returned for good. The queue runs the newest request as
 * soon as the running parse ends.
 */

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => (resolve = res))
  return { promise, resolve }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

test('a job scheduled while another runs is not dropped — it runs next', async () => {
  const queue = createLatestQueue()
  const gate = deferred()
  const ran: string[] = []

  queue.schedule(async () => {
    ran.push('old:start')
    await gate.promise
    ran.push('old:end')
  })
  await tick()
  queue.schedule(async () => {
    ran.push('new')
  })
  assert.deepEqual(ran, ['old:start'], 'never two at once')
  assert.equal(queue.busy, true)

  gate.resolve()
  await tick()
  await tick()
  assert.deepEqual(ran, ['old:start', 'old:end', 'new'])
  assert.equal(queue.busy, false)
})

test('only the newest waiting job is kept', async () => {
  const queue = createLatestQueue()
  const gate = deferred()
  const ran: string[] = []

  queue.schedule(() => gate.promise)
  await tick()
  for (const name of ['a', 'b', 'c']) queue.schedule(async () => void ran.push(name))

  gate.resolve()
  await tick()
  await tick()
  assert.deepEqual(ran, ['c'], 'requests for files already swiped past are skipped')
})

test('a failing job does not wedge the queue', async () => {
  const queue = createLatestQueue()
  let ranAfter = false
  queue.schedule(async () => {
    throw new Error('corrupt book')
  })
  queue.schedule(async () => {
    ranAfter = true
  })
  await tick()
  await tick()
  assert.equal(ranAfter, true)
  assert.equal(queue.busy, false)
})

test('cancel drops the waiting job but lets the running one finish', async () => {
  const queue = createLatestQueue()
  const gate = deferred()
  let finished = false
  let waitingRan = false

  queue.schedule(async () => {
    await gate.promise
    finished = true
  })
  await tick()
  queue.schedule(async () => {
    waitingRan = true
  })
  queue.cancel()
  gate.resolve()
  await tick()
  await tick()
  assert.equal(finished, true)
  assert.equal(waitingRan, false)
})

test('prefetch schedules through the queue and no longer gives up on busy', () => {
  const prefetch = readFileSync(new URL('../renderers/webview/prefetch.ts', import.meta.url), 'utf8')
  assert.match(prefetch, /queue\.schedule\(async \(\) => \{/)
  assert.doesNotMatch(prefetch, /\|\| busy\) return/, 'the old drop-on-busy check is gone')
  assert.match(prefetch, /if \(mine !== generation\) return/, 'a stale request still stops between files')
  assert.match(prefetch, /queue\.cancel\(\)/, 'leaving the reader drops the waiting request')
})
