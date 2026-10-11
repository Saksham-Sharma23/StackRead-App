import { create } from 'zustand'

import type { FileEntry } from '../types'
import { deleteFromLibrary } from '../storage/files'
import { forgetFileEverywhere } from '../storage/lifecycle'
import { flushLibrarySave, onSaveHealthChange } from '../storage/library'
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

/**
 * Removals committed in the UI whose bytes are still on disk, because the index
 * write that drops their rows has not been confirmed ([AUDIT4 C2](../../AUDIT4.md)).
 *
 * The order used to be: drop the row in memory (a *debounced* save), delete the
 * bytes immediately, clear the crash marker. A kill inside the 400ms debounce
 * left an index row pointing at a file that no longer existed — a card that
 * fails on open — and the marker that could have repaired it was already gone.
 *
 * Now the bytes go only after `flushLibrarySave` reports the index matches
 * memory. Until then the entry waits here and its id stays in the marker, so a
 * kill at any point is finished by `resumeInterrupted` on the next launch.
 */
const awaitingSave = new Map<string, FileEntry>()

/**
 * Mirrors the ids that still need finishing into MMKV — those inside their undo
 * window, and those awaiting a confirmed save — so a process kill cannot lose
 * them.
 */
function persistPendingIds(ids: string[]): void {
  const all = [...new Set([...ids, ...awaitingSave.keys()])]
  if (all.length) storage.set(PENDING_REMOVAL_KEY, JSON.stringify(all))
  else storage.remove(PENDING_REMOVAL_KEY)
}

/** Deletes the bytes and caches of every removal whose row is confirmed gone. */
function settleAwaiting(): void {
  for (const [id, entry] of awaitingSave) {
    try {
      deleteFromLibrary(entry)
    } catch {
      // The index no longer references it; the age-guarded prune reclaims it.
    }
    /*
     * Every cache keyed by this id, not just the parsed document — MMKV
     * scroll/zoom/progress keys included, which otherwise accumulate for the
     * life of the install. `storage/lifecycle` owns the full list. Only now,
     * once the row is gone: a file whose removal did not save comes back on the
     * next launch, and should come back with its reading position.
     */
    forgetFileEverywhere(id)
  }
  awaitingSave.clear()
}

/**
 * Finishes removals: drops the rows, makes the index write land, and only then
 * deletes the bytes. Returns whether the bytes were deleted.
 */
function finishRemovals(entries: FileEntry[]): boolean {
  for (const entry of entries) {
    useLibrary.getState().removeFile(entry.id)
    awaitingSave.set(entry.id, entry)
  }
  if (!flushLibrarySave()) return false
  settleAwaiting()
  return true
}

/*
 * A save that recovers after failing has written every pending row change,
 * removals included, so the bytes those removals were holding can go.
 */
onSaveHealthChange((failing) => {
  if (failing || !awaitingSave.size) return
  settleAwaiting()
  persistPendingIds(usePendingRemoval.getState().pending.map((p) => p.entry.id))
})

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
  /** Commits several removals with a single index write. */
  commitMany: (fileIds: string[]) => void
  /**
   * Finishes removals interrupted by a process kill. Call once, after the
   * library has loaded, so the entries it deletes actually exist to be removed.
   */
  resumeInterrupted: () => void
}

/**
 * Ids a previous process queued or committed but did not finish, read once at
 * startup so they are hidden from the board's very first frame.
 *
 * `resumeInterrupted` finishes them, but it runs in an effect after the library
 * loads — so without this, a file the user deleted moments before the app was
 * killed would flash back onto the board first. That matters more now that
 * backgrounding no longer commits removals ([AUDIT4 E4](../../AUDIT4.md)) and
 * the marker is how every background kill is finished.
 */
function markedIds(): string[] {
  try {
    const raw = storage.getString(PENDING_REMOVAL_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export const usePendingRemoval = create<PendingRemovalState>((set, get) => ({
  pending: [],
  hiddenIds: new Set(markedIds()),

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
    // One commit for the batch: one index write rather than one per file.
    const timer = setTimeout(() => get().commitMany(fresh.map((e) => e.id)), UNDO_MS)

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

  commit: (fileId) => get().commitMany([fileId]),

  commitMany: (fileIds) => {
    const wanted = new Set(fileIds)
    const items = get().pending.filter((p) => wanted.has(p.entry.id))
    if (!items.length) return
    for (const item of items) clearTimeout(item.timer)

    // Rows first, then a confirmed save, then the bytes — see `awaitingSave`.
    finishRemovals(items.map((p) => p.entry))

    const done = new Set(items.map((p) => p.entry.id))
    set((s) => {
      const hiddenIds = new Set(s.hiddenIds)
      for (const id of done) hiddenIds.delete(id)
      const pending = s.pending.filter((p) => !done.has(p.entry.id))
      // Written after `finishRemovals`, so ids still awaiting a save stay in it.
      persistPendingIds(pending.map((p) => p.entry.id))

      // The last member of a batch takes its undo handler with it, or the
      // closure — and the group entries it captures — would outlive the window.
      for (const item of items) {
        if (item.batchId && !pending.some((p) => p.batchId === item.batchId)) {
          undoHandlers.delete(item.batchId)
        }
      }

      return { pending, hiddenIds }
    })
  },

  commitAll: () => {
    get().commitMany(get().pending.map((p) => p.entry.id))
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
     * The entries are collected first and handed to `finishRemovals` together,
     * the same path a live commit takes — one index write, bytes deleted only
     * once it has landed. Two paths with different orderings in the subsystem
     * that has already caused a data-loss incident is how one of them ends up
     * wrong.
     */
    const entries: FileEntry[] = []
    for (const id of ids) {
      const entry = useLibrary.getState().filesById[id]
      // Absent: its removal did save last time, and only the bytes may remain.
      // Those are older than that save, so the age-guarded prune reclaims them.
      if (entry) entries.push(entry)
    }

    // Same order as a live commit: the marker is cleared only for removals
    // whose index write is confirmed; the rest stay in it for next time.
    if (entries.length) finishRemovals(entries)
    persistPendingIds(get().pending.map((p) => p.entry.id))

    // Unhide what startup hid. Each id is now either gone from the library or
    // waiting on a save in `awaitingSave` — removed from the store either way,
    // so there is nothing left on the board for the hidden set to cover.
    const live = new Set(get().pending.map((p) => p.entry.id))
    set((s) => {
      const hiddenIds = new Set(s.hiddenIds)
      for (const id of ids) if (!live.has(id)) hiddenIds.delete(id)
      return { hiddenIds }
    })
  },
}))
