import { create } from 'zustand'

import type { FileEntry } from '../types'
import { deleteFromLibrary } from '../storage/files'
import { forgetFileEverywhere } from '../storage/lifecycle'
import { storage, PENDING_REMOVAL_KEY } from '../storage/mmkv'
import { useLibrary } from './library'

/**
 * Files inside their 5-second undo window.
 *
 * Removal is two-phase, exactly as on desktop: the entry is hidden immediately
 * and the bytes are deleted only when the window elapses. Undo is therefore
 * free — nothing has touched the disk yet.
 *
 * Several removals can be pending at once, each with its own timer and its own
 * toast. `hiddenIds` is shared by the board and the reader so a hidden file
 * agrees everywhere.
 *
 * The timer alone is not enough to make removal reliable. It is a `setTimeout`,
 * so it dies with the process: force-quitting inside the undo window used to
 * leave the entry in the index while `hiddenIds` — memory-only — reset, and the
 * file the user removed quietly reappeared on the next launch. So the intent is
 * also written to MMKV at queue time and finished by `resumeInterrupted()` on
 * startup. `commitAll()` on backgrounding still handles the graceful case; this
 * covers the ungraceful one.
 */

const UNDO_MS = 5000

/**
 * Undo callbacks for batch removals, by batch id.
 *
 * A group deletion has to restore the *group row* as well as its files, and
 * only the caller knows how to do that — the library store owns groups, and
 * this store deliberately does not reach into how a row is rebuilt. So the
 * caller hands over a closure and this holds it for the length of the window.
 *
 * Outside the store's state on purpose: it is not rendered, and putting a
 * function in Zustand state would make every toast re-render whenever a batch
 * is queued. Cleared on undo and on commit, so a completed batch leaves nothing
 * behind.
 */
const undoHandlers = new Map<string, () => void>()

/** Mirrors the pending ids into MMKV so a process kill cannot lose them. */
function persistPendingIds(ids: string[]): void {
  if (ids.length) storage.set(PENDING_REMOVAL_KEY, JSON.stringify(ids))
  else storage.remove(PENDING_REMOVAL_KEY)
}

interface PendingItem {
  entry: FileEntry
  /**
   * The live undo timer, when this item owns one.
   *
   * Optional because a batch has exactly one timer for all its members — the
   * first item carries it and the rest are cleared through it (see
   * `queueGroup`). This was typed as always-present and the absent case was
   * forced through with `undefined as unknown as …` — a cast that existed
   * purely to hide a shape the type could have described directly.
   *
   * That distinguishes it from the two casts that remain: `Dropdown`'s
   * `interpolateColor` tuples and `useFullscreen`'s dynamic import are both
   * bridging a *third-party* signature, where there is nothing to fix on this
   * side. This one was lying about our own data, and describing it honestly
   * costs nothing — `clearTimeout(undefined)` is a documented no-op, so every
   * consumer already tolerated it.
   */
  timer?: ReturnType<typeof setTimeout>
  /**
   * Groups this removal with others under one toast.
   *
   * Deleting a group removes every file in it, and twelve stacked toasts for
   * one action is not an undo affordance — it is a wall. Items sharing a batch
   * id render as a single toast and undo together.
   *
   * Undefined for an ordinary single-file removal, which is its own batch of
   * one and needs no grouping.
   */
  batchId?: string
  /** Toast text for the batch. Only read from the first item of a batch. */
  batchLabel?: string
}

interface PendingRemovalState {
  pending: PendingItem[]
  hiddenIds: Set<string>

  /** Hides the file and starts its undo countdown. */
  queue: (entry: FileEntry) => void
  /**
   * Hides a whole group's files under one undo window and one toast.
   *
   * The group row itself is removed by the caller straight away — a row that
   * lingers empty for five seconds reads as a failed delete. Undo restores it.
   */
  queueGroup: (entries: FileEntry[], label: string, onUndo: () => void) => void
  /** Restores a file whose window has not yet elapsed. */
  undo: (fileId: string) => void
  /** Commits one removal immediately (timer fired, or app is shutting down). */
  commit: (fileId: string) => void
  /** Commits every pending removal now — call when the app backgrounds. */
  commitAll: () => void
  /**
   * Finishes removals interrupted by a process kill. Call once, after the
   * library has loaded, so the entries it deletes actually exist to be removed.
   */
  resumeInterrupted: () => void
}

export const usePendingRemoval = create<PendingRemovalState>((set, get) => ({
  pending: [],
  hiddenIds: new Set(),

  queue: (entry) => {
    if (get().hiddenIds.has(entry.id)) return

    const timer = setTimeout(() => get().commit(entry.id), UNDO_MS)

    set((s) => {
      const pending = [...s.pending, { entry, timer }]
      // Written before the window opens, not after it closes: the whole point
      // is to survive a kill *during* the window.
      persistPendingIds(pending.map((p) => p.entry.id))
      return { pending, hiddenIds: new Set(s.hiddenIds).add(entry.id) }
    })
  },

  queueGroup: (entries, label, onUndo) => {
    if (!entries.length) return

    const batchId = `batch-${Date.now()}-${entries[0].id}`
    const fresh = entries.filter((e) => !get().hiddenIds.has(e.id))
    if (!fresh.length) return

    /*
     * One timer for the batch, on the first entry.
     *
     * Twelve timers firing within a millisecond of each other would each run a
     * `set`, so the board would re-render twelve times for one action. The
     * batch commits together because it was deleted together.
     */
    const timer = setTimeout(() => {
      for (const e of fresh) get().commit(e.id)
    }, UNDO_MS)

    set((s) => {
      const items: PendingItem[] = fresh.map((entry, i) => ({
        entry,
        // Only the first carries the live timer; the rest are cleared through
        // it. `commit` clears whatever it is handed, and clearing an already
        // fired or undefined timer is harmless.
        timer: i === 0 ? timer : undefined,
        batchId,
        batchLabel: i === 0 ? label : undefined,
      }))

      const pending = [...s.pending, ...items]
      // Written before the window opens: a kill during it must still finish the
      // job, exactly as for a single file.
      persistPendingIds(pending.map((p) => p.entry.id))

      const hiddenIds = new Set(s.hiddenIds)
      for (const e of fresh) hiddenIds.add(e.id)
      return { pending, hiddenIds }
    })

    undoHandlers.set(batchId, onUndo)
  },

  undo: (fileId) => {
    const item = get().pending.find((p) => p.entry.id === fileId)
    if (!item) return

    /*
     * Undoing any member of a batch undoes the whole batch.
     *
     * A group deletion is one action to the user, so restoring "some of the
     * files but not the group" would be a state they never asked for and
     * cannot get back out of.
     */
    const batch = item.batchId
    const restoring = batch
      ? get().pending.filter((p) => p.batchId === batch)
      : [item]

    for (const p of restoring) if (p.timer) clearTimeout(p.timer)

    if (batch) {
      // Puts the group row back before the files land in it, so they are never
      // briefly members of a group that does not exist.
      undoHandlers.get(batch)?.()
      undoHandlers.delete(batch)
    }

    set((s) => {
      const undone = new Set(restoring.map((p) => p.entry.id))
      const hiddenIds = new Set(s.hiddenIds)
      for (const id of undone) hiddenIds.delete(id)
      const pending = s.pending.filter((p) => !undone.has(p.entry.id))
      persistPendingIds(pending.map((p) => p.entry.id))
      return { pending, hiddenIds }
    })
  },

  commit: (fileId) => {
    const item = get().pending.find((p) => p.entry.id === fileId)
    if (!item) return
    clearTimeout(item.timer)

    // Drop from the index first, then delete the bytes. If the process dies
    // between the two, `pruneOrphans` cleans up on the next launch.
    useLibrary.getState().removeFile(fileId)
    deleteFromLibrary(item.entry)
    /*
     * Every cache keyed by this id, not just the parsed document.
     *
     * This used to be `forgetPrepared` alone, which left the file's MMKV
     * scroll/zoom/progress keys behind permanently — MMKV is memory-mapped and
     * read in full at startup, so those accumulate for the life of the install.
     * `storage/lifecycle` owns the full list.
     */
    forgetFileEverywhere(fileId)

    set((s) => {
      const hiddenIds = new Set(s.hiddenIds)
      hiddenIds.delete(fileId)
      const pending = s.pending.filter((p) => p.entry.id !== fileId)
      persistPendingIds(pending.map((p) => p.entry.id))

      // The last member of a batch takes its undo handler with it, or the
      // closure — and the group entries it captures — would outlive the window.
      if (item.batchId && !pending.some((p) => p.batchId === item.batchId)) {
        undoHandlers.delete(item.batchId)
      }

      return { pending, hiddenIds }
    })
  },

  commitAll: () => {
    for (const p of [...get().pending]) get().commit(p.entry.id)
  },

  resumeInterrupted: () => {
    const raw = storage.getString(PENDING_REMOVAL_KEY)
    if (!raw) return

    let ids: string[]
    try {
      const parsed: unknown = JSON.parse(raw)
      ids = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
    } catch {
      // A corrupt record must not wedge startup, and must not be retried
      // forever either.
      storage.remove(PENDING_REMOVAL_KEY)
      return
    }

    /*
     * The undo window for these has long since passed — the user removed the
     * file and the app died before the delete landed. Finish the job rather
     * than reopening a window they cannot see.
     *
     * State is re-read **per iteration**, matching `commitAll` twelve lines
     * up. `removeFile` replaces the store's state on every call, so a
     * `filesById` captured once before the loop is stale from the second
     * iteration onward. It happened to work — the loop only reads entries it
     * had already captured — but the two loops used opposite conventions in the
     * one subsystem that has already caused a data-loss incident, and the
     * version that reads correct-by-accident is the one that breaks silently
     * when someone adds a line to it.
     */
    for (const id of ids) {
      const entry = useLibrary.getState().filesById[id]
      if (!entry) continue
      useLibrary.getState().removeFile(id)
      forgetFileEverywhere(id)
      try {
        deleteFromLibrary(entry)
      } catch {
        // The index no longer references it, so pruneOrphans reclaims the bytes.
      }
    }

    storage.remove(PENDING_REMOVAL_KEY)
  },
}))
