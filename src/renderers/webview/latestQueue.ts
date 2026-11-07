/**
 * Runs one job at a time, and remembers only the newest job waiting.
 *
 * ## Why prefetching needs it
 *
 * Prefetching used a `busy` flag: a request that arrived while a parse was
 * running saw the flag and returned — for good. Nothing came back for it when
 * the parse finished, so after a fast swipe the new neighbours were not warmed
 * until the *next* page turn, and the swipe after that re-parsed while the
 * user watched a loading cover.
 *
 * This keeps the flag's purpose — never two speculative parses at once — and
 * fixes the loss: a job scheduled while another runs waits, and starts the
 * moment that one ends. Only the newest waiting job is kept, because a request
 * for neighbours the user has already swiped past is not worth running.
 *
 * Jobs decide for themselves when they are stale (prefetch compares a
 * generation counter between files), so an older job finishes its current
 * parse — already paid for — and then returns, letting the newest one start.
 *
 * Imports nothing, so it is tested directly (`latestQueue.test.ts`).
 */

export interface LatestQueue {
  /** Runs `job` now if idle, otherwise as soon as the running job ends, replacing any job already waiting. */
  schedule(job: () => Promise<void>): void
  /** Drops the waiting job, if any. A running job is left to finish. */
  cancel(): void
  /** Whether a job is running. */
  readonly busy: boolean
}

export function createLatestQueue(): LatestQueue {
  let running = false
  let waiting: (() => Promise<void>) | null = null

  const runNext = (): void => {
    const job = waiting
    waiting = null
    if (!job) return
    running = true
    // A job's failure is its own business; it must never wedge the queue.
    Promise.resolve()
      .then(job)
      .catch(() => {})
      .finally(() => {
        running = false
        runNext()
      })
  }

  return {
    schedule(job) {
      waiting = job
      if (!running) runNext()
    },
    cancel() {
      waiting = null
    },
    get busy() {
      return running
    },
  }
}
