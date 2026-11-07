import type { Prepared } from './prepare'

/**
 * Work in progress, shared by key.
 *
 * ## Why
 *
 * Opening a file whose neighbour-prefetch was still parsing started a second,
 * full parse of the same file: the renderer only consulted the finished-result
 * caches, never the work already running. For a large EPUB or comic that is two
 * archives, two assemblies and two results in memory at once — the pressure this
 * app has crashed from before. With this, the open joins the parse already
 * running and both get the same result.
 *
 * ## Invalidation
 *
 * A run that is forgotten — the file was removed, or a restore replaced every
 * file under ids it kept — still finishes, but `stillCurrent()` turns false, so
 * it must not write its result into any cache: those bytes are no longer what
 * that id means. The next request for the id starts a fresh run.
 *
 * Imports nothing at runtime (the `Prepared` import is type-only), because
 * `storage/lifecycle` invalidates through it and that module is in the startup
 * graph — see `startupBundle.test.ts`.
 */

export interface Inflight<T> {
  /**
   * Joins the run for `key` if one is in progress, otherwise starts `task`.
   * `task` receives `stillCurrent`, true until the run is forgotten.
   */
  run(key: string, task: (stillCurrent: () => boolean) => Promise<T>): Promise<T>
  /** Whether a run for `key` is in progress. */
  has(key: string): boolean
  /** Detaches the run for `key`; it finishes, but is no longer current or joinable. */
  forget(key: string): void
  /** Detaches every run. */
  clear(): void
}

export function createInflight<T>(): Inflight<T> {
  const running = new Map<string, Promise<T>>()

  return {
    run(key, task) {
      const existing = running.get(key)
      if (existing) return existing

      // Deferred one microtask so `run` is registered before `task` can
      // observe anything, and so a task that throws synchronously still
      // reaches the cleanup below rather than escaping `run`.
      const run: Promise<T> = Promise.resolve()
        .then(() => task(() => running.get(key) === run))
        .finally(() => {
          if (running.get(key) === run) running.delete(key)
        })
      running.set(key, run)
      return run
    },
    has: (key) => running.has(key),
    forget: (key) => {
      running.delete(key)
    },
    clear: () => running.clear(),
  }
}

/** Document preparations in progress, by file id. */
export const preparing: Inflight<Prepared> = createInflight<Prepared>()
