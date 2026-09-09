/**
 * Pure list maintenance for the library store's derived values.
 *
 * ## Why this is its own module
 *
 * The same reason [libraryDiff.ts](../storage/libraryDiff.ts) is: `store/library`
 * imports `expo-sqlite` transitively and cannot load under Node, so anything
 * living there is testable only on a device. What is in here is the part with a
 * property worth asserting, and it imports nothing.
 *
 * ## The property
 *
 * `pdfsNeedingCovers` drives `PdfCoverFactory`, which mounts a live pdfium view
 * per candidate. Handing it a fresh array on every unrelated store mutation
 * restarts that work — so **identity stability is correctness here, not an
 * optimisation.**
 *
 * It used to come from `useShallow` wrapping a selector that scanned every file
 * in the library on every store update. That suppressed the re-render and not
 * the scan ([AUDIT2 §3.2](../../AUDIT2.md)). Maintaining the list incrementally
 * removes the scan, and this function is what preserves the identity guarantee
 * the wrapper was providing.
 */

/**
 * Removes ids from a list, returning **the same array** when none matched.
 *
 * The early return is the load-bearing half. `setThumb` fires for every
 * generated thumbnail, and most of those are EPUB and comic covers that are not
 * in this list at all — so without it, an import of thirty books would hand the
 * cover factory thirty new array identities describing an unchanged set.
 */
export function dropIds(ids: string[], remove: ReadonlySet<string>): string[] {
  if (!ids.length || !remove.size) return ids

  let hit = false
  for (const id of ids) {
    if (remove.has(id)) {
      hit = true
      break
    }
  }
  if (!hit) return ids

  return ids.filter((id) => !remove.has(id))
}

/**
 * A reusable one-element set, for the common single-id case.
 *
 * `setThumb` runs once per generated thumbnail across a whole import, and
 * allocating a `Set` per call to ask "is this one id present" is exactly the
 * per-mutation garbage the incremental rewrite exists to remove.
 *
 * Safe to share **only because `dropIds` reads it synchronously and never
 * retains it.** That is a real constraint on both functions rather than an
 * incidental fact, so it is stated here: a future `dropIds` that held on to its
 * `remove` argument would make this a bug, and the failure would be a cover
 * queue that silently loses entries.
 */
const scratch = new Set<string>()

export function oneId(id: string): ReadonlySet<string> {
  scratch.clear()
  scratch.add(id)
  return scratch
}
