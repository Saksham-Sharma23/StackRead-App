/**
 * Whether orphan cleanup may delete a library file, judged by its age.
 *
 * ## Why age matters at all
 *
 * `pruneOrphans` deletes files no index entry references. That is only safe if
 * the index is complete — and it was not always: a save that failed left newly
 * imported files on disk but absent from the index, and the next launch's prune
 * deleted them, because "unreferenced" and "not yet recorded" look identical
 * from the directory ([AUDIT4 C1](../../AUDIT4.md), the DETAIL.md §6.3 failure
 * by a new route).
 *
 * The distinguishing fact is time. Everything the index could have recorded was
 * written before the last save that left the index matching memory exactly. A
 * file modified after that may belong to an entry the index never saw, so it is
 * kept. A genuine orphan is never newer than a full save for long: the next one
 * makes it old enough, and the following prune removes it.
 *
 * Pure, so it is tested directly.
 */

/**
 * Slack for clock and filesystem timestamp granularity.
 *
 * Generous on purpose: erring here keeps an orphan one more day, erring the
 * other way deletes a user's file.
 */
export const PRUNE_GRACE_MS = 10 * 60 * 1000

/**
 * True when a file is old enough that the index, if it wanted it, would have it.
 *
 * `lastFullSave` is 0 when this install has never recorded one (an upgrade from
 * before this guard, or a fresh install): then nothing is provably old enough,
 * and nothing is deleted until the first full save.
 */
export function isOldEnoughToPrune(
  lastModified: number | null | undefined,
  lastFullSave: number,
  graceMs: number = PRUNE_GRACE_MS,
): boolean {
  if (!lastFullSave) return false
  if (typeof lastModified !== 'number' || !Number.isFinite(lastModified)) return false
  return lastModified < lastFullSave - graceMs
}
