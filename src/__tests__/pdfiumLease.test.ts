import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  acquirePdfium,
  isPdfiumSettled,
  pdfiumHolder,
  resetPdfiumLeaseForTests,
  whenPdfiumSettled,
} from '../storage/pdfiumLease.ts'

/*
 * AUDIT4 A8. The lease is what makes "one pdfium document at a time" and "never
 * tear one down mid-load" properties of the code. These run it for real.
 */

beforeEach(() => resetPdfiumLeaseForTests())

/** Lets queued promise callbacks run. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('one holder at a time, granted in request order', async () => {
  const order: string[] = []
  const first = acquirePdfium('cover').then((l) => (order.push(l.owner), l))
  const second = acquirePdfium('reader:a').then((l) => (order.push(l.owner), l))
  const third = acquirePdfium('reader:b').then((l) => (order.push(l.owner), l))

  const a = await first
  await tick()
  assert.deepEqual(order, ['cover'], 'nobody else may hold it while the first does')
  assert.equal(pdfiumHolder(), 'cover')

  a.release()
  const b = await second
  await tick()
  assert.deepEqual(order, ['cover', 'reader:a'])

  b.release()
  ;(await third).release()
  assert.deepEqual(order, ['cover', 'reader:a', 'reader:b'])
  assert.equal(pdfiumHolder(), null)
})

test('release is idempotent and a stale lease cannot free its successor', async () => {
  const a = await acquirePdfium('cover')
  a.release()
  const b = await acquirePdfium('reader')

  a.release() // a second release of an old lease
  assert.equal(pdfiumHolder(), 'reader', 'an old lease must not release the current holder')
  b.release()
})

test('a caller gone before its grant hands the lease straight back', async () => {
  const blocker = await acquirePdfium('cover')
  let gone = true
  const queued = acquirePdfium('reader').then((lease) => {
    if (gone) lease.release()
    return lease
  })
  blocker.release()
  await queued
  assert.equal(pdfiumHolder(), null, 'a released-on-grant request must leave nothing held')
  gone = false
})

test('settled means nobody holds it, or the holder has settled', async () => {
  assert.equal(isPdfiumSettled(), true)
  const lease = await acquirePdfium('reader')
  assert.equal(isPdfiumSettled(), false, 'a document that has not reported loading is mid-load')
  lease.markSettled()
  assert.equal(isPdfiumSettled(), true)
  lease.release()
  assert.equal(isPdfiumSettled(), true)
})

test('whenPdfiumSettled waits for the holder to settle', async () => {
  const lease = await acquirePdfium('reader')
  let resolved = false
  const wait = whenPdfiumSettled(5_000).then(() => {
    resolved = true
  })
  await tick()
  assert.equal(resolved, false, 'closing must wait while the document loads')
  lease.markSettled()
  await wait
  assert.equal(resolved, true)
  lease.release()
})

test('whenPdfiumSettled also resolves on release, and on its timeout', async () => {
  const lease = await acquirePdfium('reader')
  const onRelease = whenPdfiumSettled(5_000)
  lease.release()
  await onRelease

  await acquirePdfium('stuck')
  const started = Date.now()
  await whenPdfiumSettled(30)
  assert.ok(Date.now() - started >= 25, 'a document that never reports back must not block forever')
})
