import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'

import type { FileEntry } from '../types'
import { useLibrary } from './library'
import { usePendingRemoval } from './pendingRemoval'

/**
 * Derived views of the library.
 *
 * **Zustand selectors must return stable references.** A selector that builds a
 * fresh array on every call re-renders forever (React error #185 on desktop).
 * So: select a raw slice, then derive with `useMemo` — or wrap the selector in
 * `useShallow` so it only fires when contents actually change.
 *
 * Normalizing the store (see `store/library`) made that easier but not
 * automatic. A row now selects its own id array, which is one lookup rather
 * than a filter over every file in the library — but the *derivation* below
 * still allocates, so it still has to be memoized on a stable input.
 */

/** Shared empty list, so a group with no files is always the same reference. */
const EMPTY_IDS: readonly string[] = []

/** Group rows in display order. */
export function useGroupsSorted() {
  const groups = useLibrary(useShallow((s) => s.groups))
  return useMemo(() => [...groups].sort((a, b) => a.order - b.order), [groups])
}

/**
 * Files of one group, in order, with any inside their undo window filtered out.
 *
 * The membership array is selected raw, so Zustand compares the same reference
 * until *this* group's membership actually changes — but `filesById` is a
 * **second** subscription, and every reducer replaces that map. So this hook
 * does re-run whenever any file's metadata changes anywhere in the library.
 *
 * That was previously claimed not to happen, and the claim was wrong
 * ([AUDIT2 §3.1](../../AUDIT2.md)). It is acceptable *here*: the reader holds
 * one group and mounts one renderer, so the cost is a single component. The
 * board cannot afford it and uses `useGroupFileIds` instead.
 */
/**
 * File **ids** of one group, in order, minus anything inside its undo window.
 *
 * For the board, where a row must not re-render because some unrelated file's
 * metadata changed. `useGroupFiles` below cannot serve that: it subscribes to
 * the whole `filesById` map, which every reducer replaces, so a single
 * thumbnail landing re-ran every mounted row's `useMemo`, allocated a new array
 * per row, and re-rendered every card's comparator
 * ([AUDIT2 §3.1](../../AUDIT2.md)).
 *
 * Ids are enough for a row. The entry itself is looked up by the card that
 * displays it, which is the same shape `FileCard` already uses for progress:
 * subscribe to your own key, re-render only yourself.
 *
 * `useMemo` on the raw membership array, so the identity changes only when this
 * group's membership or its hidden set actually does.
 */
export function useGroupFileIds(groupId: string): string[] {
  const ids = useLibrary((s) => s.groupOrder[groupId]) ?? EMPTY_IDS
  const hiddenIds = usePendingRemoval((s) => s.hiddenIds)

  return useMemo(() => {
    // The common case by far: nothing in this row is mid-removal, so the
    // membership array can be reused as-is rather than copied per render.
    let hidden = false
    for (const id of ids) {
      if (hiddenIds.has(id)) {
        hidden = true
        break
      }
    }
    if (!hidden) return ids as string[]
    return ids.filter((id) => !hiddenIds.has(id))
  }, [ids, hiddenIds])
}

/**
 * One file's entry, subscribed individually.
 *
 * The counterpart to `useGroupFileIds`. A card re-renders when *its own* entry
 * changes and not when any other does, which is what makes a thumbnail landing
 * cost one card rather than the whole board.
 *
 * Returns the entry or undefined — a membership id with no entry is possible
 * mid-update, which `useGroupFiles` has always tolerated by skipping.
 */
export function useFileEntry(fileId: string): FileEntry | undefined {
  return useLibrary((s) => s.filesById[fileId])
}

export function useGroupFiles(groupId: string): FileEntry[] {
  const ids = useLibrary((s) => s.groupOrder[groupId]) ?? EMPTY_IDS
  const filesById = useLibrary((s) => s.filesById)
  const hiddenIds = usePendingRemoval((s) => s.hiddenIds)

  return useMemo(() => {
    const out: FileEntry[] = []
    for (const id of ids) {
      if (hiddenIds.has(id)) continue
      const entry = filesById[id]
      // A membership entry with no file is possible only mid-update; skipping
      // is correct and cheaper than asserting.
      if (entry) out.push(entry)
    }
    return out
  }, [ids, filesById, hiddenIds])
}

/**
 * Visible file count for a group, for the row header.
 *
 * Counts without building the array, so a header does not allocate a list it
 * never reads.
 */
export function useGroupCount(groupId: string): number {
  const ids = useLibrary((s) => s.groupOrder[groupId]) ?? EMPTY_IDS
  const hiddenIds = usePendingRemoval((s) => s.hiddenIds)

  return useMemo(() => {
    let n = 0
    for (const id of ids) if (!hiddenIds.has(id)) n += 1
    return n
  }, [ids, hiddenIds])
}

/**
 * Total number of files in the library.
 *
 * A plain read of a value the store maintains. It was
 * `Object.keys(s.filesById).length`, which allocated a full key array to
 * produce a number — and Zustand runs every subscriber's selector on **every**
 * store update, so that was an allocation per mutation for a value that changes
 * on two of the eleven reducers.
 */
export function useFileCount(): number {
  return useLibrary((s) => s.fileCount)
}

/**
 * PDFs that still have no cover image.
 *
 * For the cover factory, which rasterises page one of each so the board is not
 * a wall of badges.
 *
 * **Ids rather than entries**, and that distinction is load-bearing rather than
 * incidental: the factory's whole job is to *call* `setThumb`, so a view
 * returning entries would see every one of those writes and re-drive the effect
 * that produced them.
 *
 * Maintained in the store rather than derived here. This used to scan all of
 * `filesById` under `useShallow` — which suppressed the *re-render* but not the
 * *scan*, so a rename keystroke or a progress write still walked every file in
 * the library ([AUDIT2 §3.2](../../AUDIT2.md), [AUDIT §2.2](../../AUDIT.md)).
 * The reducers now keep it incrementally, and `dropIds` there preserves the
 * array's identity when nothing was removed, which is what `useShallow` was
 * previously providing.
 */
export function usePdfsNeedingCovers(): string[] {
  return useLibrary((s) => s.pdfsNeedingCovers)
}

/**
 * The first few files of every group, for the move sheet's preview strips.
 *
 * Selected under `useShallow` over the *ids*, then mapped — the same shape
 * every other derived view here uses, and for the same reason: a selector that
 * builds fresh entry objects would allocate on every store update and never
 * compare equal.
 *
 * Bounded at three per group deliberately. This is a preview, and the cost has
 * to stay proportional to the number of *groups* rather than to the size of the
 * library — a version that mapped whole rows would be the O(groups x files)
 * pattern the normalization exists to remove, reintroduced in a sheet nobody
 * thinks of as expensive.
 */
export function useGroupPreviews(limit = 3): Record<string, FileEntry[]> {
  const filesById = useLibrary((s) => s.filesById)

  /*
   * The head ids of every group, as one flat string.
   *
   * `useShallow` compares its values with `Object.is`, one level deep — so a
   * `Record<string, string[]>` would allocate a fresh array per group on every
   * call and never compare equal, re-rendering forever. That is the allocating
   * selector trap this module exists to document, reached by a route the usual
   * `?? []` warning does not cover.
   *
   * Joining to a primitive sidesteps it entirely: a string compares by value,
   * so this changes only when a group's first few files actually change. The
   * separators cannot occur in a nanoid, so the encoding is unambiguous.
   */
  const key = useLibrary((s) => {
    let out = ''
    for (const group of s.groups) {
      out += group.id + ':'
      const ids = s.groupOrder[group.id] ?? []
      for (let i = 0; i < limit && i < ids.length; i += 1) out += ids[i] + ','
      out += ';'
    }
    return out
  })

  return useMemo(() => {
    const out: Record<string, FileEntry[]> = {}
    for (const chunk of key.split(';')) {
      if (!chunk) continue
      const split = chunk.indexOf(':')
      if (split < 0) continue

      const groupId = chunk.slice(0, split)
      const entries: FileEntry[] = []
      for (const id of chunk.slice(split + 1).split(',')) {
        if (!id) continue
        const entry = filesById[id]
        if (entry) entries.push(entry)
      }
      out[groupId] = entries
    }
    return out
  }, [key, filesById])
}

/**
 * File count per group, including files inside their undo window.
 *
 * For menus that need "how many files would this affect" across every group at
 * once — deleting a group, or listing groups to switch into. Reading
 * `groupOrder[id].length` is O(1) per group; the previous version filtered the
 * whole file array once per group, which is the O(groups x files) pattern this
 * normalization exists to remove.
 *
 * `useShallow` so the object is compared by contents: adding a file to one
 * group re-renders these consumers once, and editing a file's metadata does not
 * re-render them at all.
 */
export function useGroupCounts(): Record<string, number> {
  return useLibrary(
    useShallow((s) => {
      const counts: Record<string, number> = {}
      for (const group of s.groups) counts[group.id] = s.groupOrder[group.id]?.length ?? 0
      return counts
    }),
  )
}
