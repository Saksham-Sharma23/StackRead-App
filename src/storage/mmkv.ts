import { createMMKV } from 'react-native-mmkv'

/**
 * Hot, high-frequency state lives here rather than in `library.json`.
 *
 * MMKV writes are synchronous and JSI-backed, which is what makes it safe to
 * write a scroll position on every settle without dropping frames. The library
 * index is a different concern: it is written debounced and atomically (see
 * `storage/library.ts`).
 */
export const storage = createMMKV({ id: 'stackread' })

/** Per-file scroll offset. Source of truth while the app is running. */
export const scrollKey = (fileId: string) => `scroll:${fileId}`

/** Per-file zoom scale, namespaced per renderer family. */
export const zoomKey = (fileId: string) => `zoom:${fileId}`

/** Per-file reading position for formats that locate by something other than px (EPUB CFI). */
export const locationKey = (fileId: string) => `loc:${fileId}`

/** How far through a file the reader has got, 0..100, shown on its library card. */
export const progressKey = (fileId: string) => `progress:${fileId}`

/**
 * Set when cover generation for a file has been tried and produced nothing.
 *
 * Only the **negative** result is stored. A success is already recorded by
 * `FileEntry.thumb` in the index, so writing both would be two sources of truth
 * for one fact.
 *
 * It has to be durable rather than session-scoped, which is the part that was
 * missing. A file that legitimately yields no cover — an EPUB with no declared
 * cover image, a comic whose first entry is not an image — was retried on every
 * cold launch, two at a time, and each retry is a full archive decompression
 * that produces nothing ([AUDIT2 §3.4](../../AUDIT2.md)).
 *
 * Cleared through `storage/lifecycle`, like every other id-keyed value.
 */
export const thumbFailKey = (fileId: string) => `thumbfail:${fileId}`

/**
 * File ids whose removal was started but not yet committed, as a JSON array.
 *
 * The undo window is a `setTimeout`, which dies with the process. Without a
 * durable record, force-quitting during those five seconds leaves the entry in
 * the index while the in-memory `hiddenIds` set resets — so the "removed" file
 * silently comes back. Written at queue time and cleared on undo or commit.
 */
export const PENDING_REMOVAL_KEY = 'pendingRemoval'

/**
 * When `pruneOrphans` last completed, as epoch milliseconds.
 *
 * Orphan cleanup enumerates the whole library directory, which at a few
 * thousand files is thousands of stat calls — far too much to spend on every
 * launch before the board can paint. It is housekeeping, not correctness:
 * nothing breaks if an orphan survives an extra day.
 */
export const LAST_PRUNE_KEY = 'lastPruneAt'
