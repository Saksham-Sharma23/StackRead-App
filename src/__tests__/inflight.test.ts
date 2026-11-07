import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createInflight } from '../renderers/webview/inflight.ts'

/*
 * Opening a file whose prefetch was still parsing started a second full parse
 * of the same file — two archives and two results in memory at once. Both
 * callers now go through one shared run per file id.
 */

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('a second request joins the run in progress instead of starting another', async () => {
  const runs = createInflight<string>()
  const gate = deferred<string>()
  let started = 0

  const first = runs.run('book', () => {
    started += 1
    return gate.promise
  })
  const second = runs.run('book', () => {
    started += 1
    return Promise.resolve('second parse')
  })

  assert.equal(first, second, 'both callers hold the same promise')
  assert.equal(runs.has('book'), true)
  gate.resolve('parsed')
  assert.equal(await second, 'parsed')
  assert.equal(started, 1, 'the task ran once')
  assert.equal(runs.has('book'), false, 'a finished run is no longer joinable')
})

test('different files run independently', async () => {
  const runs = createInflight<string>()
  const a = runs.run('a', async () => 'A')
  const b = runs.run('b', async () => 'B')
  assert.notEqual(a, b)
  assert.deepEqual(await Promise.all([a, b]), ['A', 'B'])
})

test('a failure reaches every caller and leaves nothing behind to retry against', async () => {
  const runs = createInflight<string>()
  const gate = deferred<string>()
  const first = runs.run('bad', () => gate.promise)
  const second = runs.run('bad', () => Promise.resolve('unused'))
  gate.reject(new Error('corrupt'))

  await assert.rejects(first, /corrupt/)
  await assert.rejects(second, /corrupt/)
  assert.equal(runs.has('bad'), false)
  assert.equal(await runs.run('bad', async () => 'retried'), 'retried', 'a later request starts fresh')
})

test('a task that throws synchronously still rejects and is cleaned up', async () => {
  const runs = createInflight<string>()
  await assert.rejects(
    runs.run('sync', () => {
      throw new Error('boom')
    }),
    /boom/,
  )
  assert.equal(runs.has('sync'), false)
})

test('a forgotten run finishes but is no longer current, so it must not cache', async () => {
  const runs = createInflight<string>()
  const gate = deferred<string>()
  let currentAtEnd: boolean | null = null

  const old = runs.run('book', async (stillCurrent) => {
    const value = await gate.promise
    currentAtEnd = stillCurrent()
    return value
  })
  runs.forget('book') // removed, or replaced by a restore, mid-parse

  // A new request does not join the detached run.
  const fresh = runs.run('book', async (stillCurrent) => (stillCurrent() ? 'new bytes' : 'stale'))
  assert.notEqual(fresh, old)
  assert.equal(await fresh, 'new bytes')

  gate.resolve('old bytes')
  assert.equal(await old, 'old bytes', 'the caller that asked still gets its answer')
  assert.equal(currentAtEnd, false)
})

test('a detached run finishing does not remove the run that replaced it', async () => {
  const runs = createInflight<string>()
  const oldGate = deferred<string>()
  const newGate = deferred<string>()
  const old = runs.run('book', () => oldGate.promise)
  runs.clear()
  const fresh = runs.run('book', () => newGate.promise)

  oldGate.resolve('old')
  await old
  assert.equal(runs.has('book'), true, 'the newer run is still joinable')
  assert.equal(runs.run('book', async () => 'third'), fresh)
  newGate.resolve('new')
  assert.equal(await fresh, 'new')
})

test('the renderer and the prefetch both parse through the shared run', () => {
  const renderer = source('renderers/WebViewRenderer.tsx')
  assert.match(renderer, /await prepareAndCache\(file, 'user'\)/)
  assert.doesNotMatch(renderer, /\bprepareFile\(/, 'no direct parse that could run beside a prefetch')

  const prefetch = source('renderers/webview/prefetch.ts')
  assert.match(prefetch, /await prepareAndCache\(file, 'prefetch'\)/)
  assert.doesNotMatch(prefetch, /\bprepareFile\(/)
  assert.match(prefetch, /preparing\.has\(file\.id\)/, 'a file already being parsed is not queued again')

  const once = source('renderers/webview/prepareOnce.ts')
  assert.match(once, /if \(stillCurrent\(\)\) \{\s*\n\s*setPrepared/, 'only a current run may cache its result')
})
