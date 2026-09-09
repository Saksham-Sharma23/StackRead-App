import { create } from 'zustand'
import { nanoid } from 'nanoid/non-secure'

import type { FileEntry, Group, Library } from '../types'
import { loadLibrary, scheduleSave } from '../storage/library'
import { schedulePruneOrphans } from '../storage/files'
import { resetAllCaches } from '../storage/lifecycle'
import { dropIds, oneId } from './derived'
import { noteHydrate, now } from '../ui/perf'

/**
 * The library board: groups (rows) and files (cards).
 *
 * ## Why the state is normalized
 *
 * Files used to be a single `FileEntry[]`, and every row selected from it with
 * `s.files.filter(f => f.groupId === id)`. Zustand runs every subscriber's
 * selector on every store update, so one file import re-filtered the entire
 * array once per mounted row: O(groups x files) per mutation, plus a shallow
 * comparison over each result. At 8 groups and 200 files that is ~1,600
 * comparisons per keystroke while renaming a group.
 *
 * So the shape is now:
 *
 *   filesById   id -> entry           the single copy of each file
 *   groupOrder  groupId -> id[]       membership and horizontal order
 *
 * A row selects `groupOrder[id]`, which is one lookup whose reference changes
 * only when that row actually changes. Reordering within a group rewrites one
 * array instead of rebuilding every entry in the library.
 *
 * ## What did not change
 *
 * - **The on-disk shape.** `library.json` still holds flat `groups` and `files`
 *   arrays, so an existing library loads and an export still round-trips. The
 *   normalization is a runtime detail; `toLibrary()` flattens on the way out.
 * - **Reducers return new objects**, never mutating in place, so memoized and
 *   `useShallow` consumers actually see changes.
 * - **`load()` is guarded** against StrictMode's double-invoked effects, which
 *   would otherwise create two "New group"s and race the first save.
 * - **A group is a logical tag.** Moving a file between groups still edits
 *   membership and one field, and never touches disk.
 */

interface LibraryState {
  groups: Group[]
  /** Every file, by id. The single source of truth for file data. */
  filesById: Record<string, FileEntry>
  /** File ids per group, in display order. Membership and order in one place. */
  groupOrder: Record<string, string[]>
  /**
   * How many files the library holds, maintained rather than counted.
   *
   * `Object.keys(filesById).length` allocated a full key array to read a number,
   * and Zustand runs every subscriber's selector on **every** store update — so
   * that was an allocation per mutation for a value that changes on two of the
   * eleven reducers.
   */
  fileCount: number
  /**
   * Ids of PDFs with no cover yet, for `PdfCoverFactory`.
   *
   * Maintained here rather than derived, for the same reason. The selector
   * walked all of `filesById` on every store update — a rename keystroke, a
   * progress write, a thumbnail landing — which is the O(n)-per-mutation shape
   * the normalization exists to remove, reintroduced one file over
   * ([AUDIT2 §3.2](../../AUDIT2.md), [AUDIT §2.2](../../AUDIT.md)).
   *
   * It only ever shrinks during a session: a PDF joins in `addFiles` and leaves
   * when it gains a cover or is removed. The array identity changes only when
   * membership genuinely does, which is what keeps the factory from being
   * re-driven by its own `setThumb` calls.
   */
  pdfsNeedingCovers: string[]
  loaded: boolean

  load: () => Promise<void>
  /** Discards in-memory state and re-reads from disk (used after a restore). */
  reload: () => Promise<void>

  addGroup: (title?: string) => string
  renameGroup: (groupId: string, title: string) => void
  removeGroup: (groupId: string) => void
  /**
   * Puts a removed group back, keeping its id and its place on the board.
   *
   * For undoing a group deletion. `addGroup` cannot serve: it mints a new id,
   * which would orphan every `groupId` on the files being restored alongside
   * it, and it appends rather than restoring the original row position.
   */
  restoreGroup: (group: Group) => void

  addFiles: (entries: FileEntry[]) => void
  removeFile: (fileId: string) => void
  moveFileToGroup: (fileId: string, groupId: string) => void
  reorderWithinGroup: (groupId: string, fromIndex: number, toIndex: number) => void
  setThumb: (fileId: string, thumb: string, thumbhash?: string) => void
}

let loadPromise: Promise<void> | null = null

/**
 * Flattens the normalized state back to the persisted shape.
 *
 * `orderInGroup` is written from each id's position in `groupOrder`, so the
 * field cannot drift from the array that actually determines order — the array
 * is authoritative at runtime and this is the only place the field is derived.
 */
function toLibrary(state: {
  groups: Group[]
  filesById: Record<string, FileEntry>
  groupOrder: Record<string, string[]>
}): Library {
  const files: FileEntry[] = []
  for (const group of state.groups) {
    const ids = state.groupOrder[group.id] ?? []
    ids.forEach((id, index) => {
      const entry = state.filesById[id]
      if (entry) files.push({ ...entry, orderInGroup: index })
    })
  }
  return { groups: state.groups, files }
}

/**
 * Queues a save of this state, **without flattening it yet**.
 *
 * `toLibrary` rebuilds every entry in the library, and this is called from all
 * eleven reducers — so doing it here meant an import of fifty files paid for
 * fifty full rebuilds, none of which the 400ms debounce absorbed because it
 * only ever coalesced the write.
 *
 * Passing a thunk moves that work inside the debounce. What it captures is
 * safe to hold: reducers return fresh objects rather than mutating, so these
 * three references describe the state as it was at this call and cannot drift.
 */
function persist(state: {
  groups: Group[]
  filesById: Record<string, FileEntry>
  groupOrder: Record<string, string[]>
}): void {
  scheduleSave(() => toLibrary(state))
}

/**
 * Builds the normalized shape from the flat persisted one.
 *
 * Also derives the two maintained values, so the one full scan the library ever
 * gets is this one — at load, where it is already walking every file.
 */
function normalize(lib: Library): {
  filesById: Record<string, FileEntry>
  groupOrder: Record<string, string[]>
  fileCount: number
  pdfsNeedingCovers: string[]
} {
  const filesById: Record<string, FileEntry> = {}
  const byGroup = new Map<string, FileEntry[]>()
  const pdfsNeedingCovers: string[] = []

  for (const file of lib.files) {
    filesById[file.id] = file
    if (file.format === 'pdf' && !file.thumb) pdfsNeedingCovers.push(file.id)
    const list = byGroup.get(file.groupId) ?? []
    list.push(file)
    byGroup.set(file.groupId, list)
  }

  const groupOrder: Record<string, string[]> = {}
  // Every group gets an entry, including empty ones, so a row's selector never
  // has to distinguish "no such group" from "group with no files".
  for (const group of lib.groups) groupOrder[group.id] = []

  for (const [groupId, list] of byGroup) {
    groupOrder[groupId] = list
      .sort((a, b) => a.orderInGroup - b.orderInGroup)
      .map((f) => f.id)
  }

  return { filesById, groupOrder, fileCount: lib.files.length, pdfsNeedingCovers }
}

export const useLibrary = create<LibraryState>((set, get) => ({
  groups: [],
  filesById: {},
  groupOrder: {},
  fileCount: 0,
  pdfsNeedingCovers: [],
  loaded: false,

  load: async () => {
    if (get().loaded) return
    if (loadPromise) return loadPromise

    loadPromise = (async () => {
      // Timed here rather than around `loadLibrary` alone: the normalize below
      // is part of what the board waits for, and splitting them would report a
      // number smaller than the wait the user actually experiences.
      const hydrateStart = now()
      const lib = await loadLibrary()

      // Desktop guarantees a fresh launch always shows at least one usable row.
      const groups = lib.groups.length
        ? [...lib.groups].sort((a, b) => a.order - b.order)
        : [{ id: nanoid(10), title: 'New group', order: 0 }]

      const { filesById, groupOrder, fileCount, pdfsNeedingCovers } = normalize({
        groups,
        files: lib.files,
      })
      noteHydrate(now() - hydrateStart)
      set({ groups, filesById, groupOrder, fileCount, pdfsNeedingCovers, loaded: true })

      /*
       * Deferred and throttled, not run inline.
       *
       * This walks the whole library directory — thousands of stat calls on a
       * large library — and it used to do so synchronously here, before the
       * board could paint, on every launch. It is housekeeping: an orphan
       * surviving an extra day costs nothing.
       *
       * A function, not a captured list: the walk yields between slices, so it
       * must re-read the store rather than trust a snapshot. A file imported
       * while it runs is in the store and not in that snapshot, and the walk
       * deletes exactly what it is not told to keep.
       *
       * **Scheduled after `set`, not before it.** The empty-library interlock
       * reads this thunk immediately, and before `set` the store still holds
       * the initial empty `filesById` — so scheduling earlier would read "no
       * files", abort every launch, and disable orphan cleanup permanently
       * while looking like it ran.
       */
      schedulePruneOrphans(() => Object.values(useLibrary.getState().filesById))

      // Persist only if we invented the starter group, so a plain read is not a write.
      if (!lib.groups.length) persist({ groups, filesById, groupOrder })
    })()

    return loadPromise
  },

  reload: async () => {
    /*
     * Drop every id-keyed cache before re-reading.
     *
     * `reload` exists for one caller: a restore, which deletes the library
     * directory and writes an archive's files in its place. Resetting this
     * store is not enough — five caches elsewhere are keyed by file id, and an
     * export *preserves* ids, so after a restore they do not merely hold stale
     * entries, they hold entries for the wrong bytes. The reader would serve
     * the previous document's parsed HTML on a synchronous cache hit.
     */
    resetAllCaches()

    loadPromise = null
    set({
      loaded: false,
      groups: [],
      filesById: {},
      groupOrder: {},
      fileCount: 0,
      pdfsNeedingCovers: [],
    })
    await get().load()
  },

  addGroup: (title) => {
    const id = nanoid(10)
    set((s) => {
      const groups = [...s.groups, { id, title: title ?? 'New group', order: s.groups.length }]
      const groupOrder = { ...s.groupOrder, [id]: [] }
      persist({ groups, filesById: s.filesById, groupOrder })
      return { groups, groupOrder }
    })
    return id
  },

  renameGroup: (groupId, title) =>
    set((s) => {
      const groups = s.groups.map((g) => (g.id === groupId ? { ...g, title } : g))
      persist({ groups, filesById: s.filesById, groupOrder: s.groupOrder })
      // Only `groups` changes, so rows keyed on `groupOrder` do not re-render.
      return { groups }
    }),

  removeGroup: (groupId) =>
    set((s) => {
      const groups = s.groups
        .filter((g) => g.id !== groupId)
        .map((g, i) => ({ ...g, order: i }))

      /*
       * Drops the row and any entries still in it.
       *
       * This used to carry the comment "callers delete the bytes" — an
       * obligation the one caller never discharged, so deleting a group left
       * every one of its files on disk, unreferenced and invisible, until
       * `pruneOrphans` next ran (at most once a day, and never on an empty
       * library). The dialog meanwhile promised the files were deleted.
       *
       * The caller now queues each file through `usePendingRemoval` *before*
       * calling this, so the bytes go through the same commit path as a
       * single-file removal — undo window, durable record, cache invalidation.
       * By the time this runs those ids are already pending, so the loop below
       * is a safety net for entries that were never queued rather than the
       * normal path.
       */
      const filesById = { ...s.filesById }
      /*
       * Only ids that actually had an entry are counted.
       *
       * `groupOrder` can briefly hold an id with no file — `useGroupFiles`
       * documents and tolerates exactly that — so subtracting the membership
       * length would drift the counter down past the truth.
       */
      const gone = new Set<string>()
      for (const id of s.groupOrder[groupId] ?? []) {
        if (id in filesById) {
          gone.add(id)
          delete filesById[id]
        }
      }

      const groupOrder = { ...s.groupOrder }
      delete groupOrder[groupId]

      persist({ groups, filesById, groupOrder })
      return {
        groups,
        filesById,
        groupOrder,
        fileCount: s.fileCount - gone.size,
        // Filtered rather than rebuilt: the array is short (PDFs without a
        // cover) and this keeps its identity stable when the removed group
        // contained none, so the factory is not re-driven for nothing.
        pdfsNeedingCovers: dropIds(s.pdfsNeedingCovers, gone),
      }
    }),

  restoreGroup: (group) =>
    set((s) => {
      if (s.groups.some((g) => g.id === group.id)) return {}

      // Reinserted at its original index, then renumbered, so the row comes
      // back where it was rather than at the bottom of the board.
      const groups = [...s.groups]
      groups.splice(Math.min(group.order, groups.length), 0, group)
      const renumbered = groups.map((g, i) => ({ ...g, order: i }))

      // An empty membership array, so a row exists for the files that are about
      // to be added back into it.
      const groupOrder = { ...s.groupOrder, [group.id]: s.groupOrder[group.id] ?? [] }

      persist({ groups: renumbered, filesById: s.filesById, groupOrder })
      return { groups: renumbered, groupOrder }
    }),

  addFiles: (entries) =>
    set((s) => {
      if (!entries.length) return {}

      const filesById = { ...s.filesById }
      const groupOrder = { ...s.groupOrder }
      const covers: string[] = []
      /*
       * Counted, not assumed to be `entries.length`.
       *
       * The undo path for a group deletion calls this with entries that were
       * removed a moment earlier, and nothing structurally prevents a caller
       * passing an id already present. Adding blind would leave `fileCount`
       * permanently one too high — a maintained counter that can drift is worse
       * than the scan it replaced, because the drift is silent and survives for
       * the life of the session.
       */
      let added = 0

      for (const entry of entries) {
        if (!(entry.id in filesById)) added += 1
        filesById[entry.id] = entry
        if (entry.format === 'pdf' && !entry.thumb) covers.push(entry.id)
        // Appended, so an import lands at the end of the row it went into.
        // Copied per touched group only — untouched rows keep their array
        // identity and never re-render.
        const current = groupOrder[entry.groupId] ?? []
        groupOrder[entry.groupId] = [...current, entry.id]
      }

      persist({ groups: s.groups, filesById, groupOrder })
      return {
        filesById,
        groupOrder,
        fileCount: s.fileCount + added,
        // Identity preserved when the import held no coverless PDFs, so an
        // import of images does not re-drive the cover factory.
        pdfsNeedingCovers: covers.length
          ? [...s.pdfsNeedingCovers, ...covers]
          : s.pdfsNeedingCovers,
      }
    }),

  removeFile: (fileId) =>
    set((s) => {
      const target = s.filesById[fileId]
      if (!target) return {}

      const filesById = { ...s.filesById }
      delete filesById[fileId]

      const groupOrder = {
        ...s.groupOrder,
        [target.groupId]: (s.groupOrder[target.groupId] ?? []).filter((id) => id !== fileId),
      }

      persist({ groups: s.groups, filesById, groupOrder })
      return {
        filesById,
        groupOrder,
        fileCount: s.fileCount - 1,
        pdfsNeedingCovers: dropIds(s.pdfsNeedingCovers, oneId(fileId)),
      }
    }),

  moveFileToGroup: (fileId, groupId) =>
    set((s) => {
      const target = s.filesById[fileId]
      if (!target || target.groupId === groupId) return {}

      const from = target.groupId

      // A group is a logical tag: this is a groupId change and a membership
      // move. The file on disk is never touched.
      const filesById = { ...s.filesById, [fileId]: { ...target, groupId } }

      const groupOrder = {
        ...s.groupOrder,
        [from]: (s.groupOrder[from] ?? []).filter((id) => id !== fileId),
        [groupId]: [...(s.groupOrder[groupId] ?? []), fileId],
      }

      persist({ groups: s.groups, filesById, groupOrder })
      return { filesById, groupOrder }
    }),

  reorderWithinGroup: (groupId, fromIndex, toIndex) =>
    set((s) => {
      if (fromIndex === toIndex) return {}

      const current = s.groupOrder[groupId]
      if (!current) return {}
      if (fromIndex < 0 || fromIndex >= current.length) return {}
      if (toIndex < 0 || toIndex >= current.length) return {}

      // One array rewritten. Previously this rebuilt every entry in the
      // library to renumber `orderInGroup`.
      const reordered = [...current]
      const [moved] = reordered.splice(fromIndex, 1)
      reordered.splice(toIndex, 0, moved)

      const groupOrder = { ...s.groupOrder, [groupId]: reordered }
      persist({ groups: s.groups, filesById: s.filesById, groupOrder })
      return { groupOrder }
    }),

  setThumb: (fileId, thumb, thumbhash) =>
    set((s) => {
      const target = s.filesById[fileId]
      if (!target) return {}

      // Preserve an existing hash when a regenerated thumbnail yields none, so
      // a transient hash failure cannot strip a working placeholder.
      const filesById = {
        ...s.filesById,
        [fileId]: { ...target, thumb, thumbhash: thumbhash ?? target.thumbhash },
      }

      persist({ groups: s.groups, filesById, groupOrder: s.groupOrder })
      // `groupOrder` is untouched, so only the card whose entry changed
      // re-renders — not the row's membership subscribers.
      return {
        filesById,
        /*
         * A cover has landed, so this file leaves the queue.
         *
         * `dropIds` returns the same array when the id is not in it, which is
         * the case for every non-PDF thumbnail — so an EPUB or comic cover
         * landing does not change this reference and cannot re-drive the
         * factory. That identity stability is the property the previous
         * `useShallow` selector was providing, preserved here.
         */
        pdfsNeedingCovers: dropIds(s.pdfsNeedingCovers, oneId(fileId)),
      }
    }),
}))
