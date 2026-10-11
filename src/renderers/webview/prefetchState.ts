/**
 * Which files failed to prefetch, so a broken file is not reparsed on every
 * page turn.
 *
 * ## Why this is its own module
 *
 * `storage/lifecycle.ts` must clear this memo when a file id stops being valid,
 * and it used to import `forgetPrefetchFailure` / `resetPrefetchFailures`
 * straight from `prefetch.ts`. That import cost far more than two functions:
 * `prefetch` imports `prepare`, which imports `epub`, which imports `xml` and
 * through it `fast-xml-parser` — ~1.4MB evaluated on every cold start, before
 * the board can paint, past the `lazy(ReaderScreen)` boundary meant to keep the
 * reader's dependencies out of startup ([AUDIT4 E2](../../../AUDIT4.md),
 * AUDIT3 §3.1). Metro's `inlineRequires` is off in SDK 57, so nothing defers
 * it.
 *
 * Holding the state here, with no imports at all, severs the chain at its
 * weakest link. `prefetch.ts` and `lifecycle.ts` both import from here.
 */

/** Files that failed to prepare, so a broken file is not retried forever. */
const failed = new Set<string>()

export function hasPrefetchFailed(fileId: string): boolean {
  return failed.has(fileId)
}

export function notePrefetchFailure(fileId: string): void {
  failed.add(fileId)
}

/**
 * Forgets that one file failed to prepare, so it is tried again.
 *
 * The memo exists so a broken file is not reparsed on every page turn. That is
 * right while the bytes stay the same — and wrong the moment they do not, which
 * is exactly what removing and re-importing a file, or restoring a backup over
 * it, does. Both reuse ids.
 */
export function forgetPrefetchFailure(fileId: string): void {
  failed.delete(fileId)
}

/** Clears the failure memo, so a re-imported file gets another chance. */
export function resetPrefetchFailures(): void {
  failed.clear()
}
