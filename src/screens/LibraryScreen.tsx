import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Pressable,
  FlatList,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LayoutAnimationConfig } from 'react-native-reanimated'

import type { FileEntry, Group } from '../types'
import type { OpenRect } from '../ui/openTransition'
import { importFiles } from '../storage/files'
import { searchFiles, type SearchPage } from '../storage/db'
import { exportLibrary, importLibraryArchive } from '../storage/backup'
import { useLibrary } from '../store/library'
import { usePendingRemoval } from '../store/pendingRemoval'
import {
  useFileCount,
  useGroupCounts,
  useGroupsSorted,
  usePdfsNeedingCovers,
} from '../store/selectors'
import { GroupRow } from '../components/GroupRow'
import { ActionSheet, type SheetAction } from '../components/ActionSheet'
import { UndoToasts } from '../components/UndoToast'
import { PdfCoverFactory } from '../components/PdfCoverFactory'
import { LibrarySearch } from '../components/LibrarySearch'
import { MoveSheetContainer } from '../components/MoveSheet'
import { EmptyBoard } from '../components/EmptyBoard'
import { useTheme } from '../ui/theme'

/**
 * The 2-D board: groups stacked vertically, files arranged horizontally within
 * each group.
 *
 * The vertical axis is a `FlatList`; the rows inside it are plain
 * `ScrollView`s. Only one axis is virtualized, deliberately — the vertical one
 * is the only one that grows without bound, and nesting a virtualized list
 * inside another costs more in measurement complexity and gesture conflicts
 * than it saves.
 *
 * `FlatList` rather than FlashList: that dependency was removed rather than
 * left unused, since a native module nobody calls is real weight in the APK.
 * A row is not as cheap as it looks — every card carries an image instance and
 * two Reanimated shared values — so an unvirtualized board mounts all of that
 * on a cold start before anything is interactive.
 */

/**
 * Files below which the search field is hidden.
 *
 * The board is a visual index, and at a handful of files it is a better one
 * than a text field. Search earns its place only once scrolling stops being a
 * reliable way to find something.
 */
const SEARCH_THRESHOLD = 12

/**
 * How long the search field waits before querying.
 *
 * `searchFiles` is a **blocking** FTS5 query on the JS thread, and it was wired
 * straight to `onChangeText` — one synchronous SQLite round trip per character,
 * on the thread that also has to paint the character. This is the one hot path
 * in the app that escaped the debouncing discipline applied everywhere else (a
 * 400ms window on the index write, a write mirror in `store/scroll`, a debounced
 * anchor report from the viewer).
 *
 * 120ms is below the ~150ms at which a delay starts to feel like lag, and long
 * enough that ordinary typing collapses ten queries into two or three.
 */
const SEARCH_DEBOUNCE_MS = 120

/**
 * Result rows per page.
 *
 * Eight was the old hard truncation and is the right *first* page: a search
 * field sits over the board, and a panel taller than this covers the thing the
 * user is searching in. It is now a page rather than a ceiling, so the
 * fifty-first result is reachable instead of merely counted.
 */
const SEARCH_PAGE = 8

/**
 * The empty result, shared.
 *
 * A fresh object here would be a new prop identity on every keystroke that
 * clears the field, re-rendering the memoised header for no change.
 */
const NO_RESULTS: SearchPage = { files: [], total: 0 }

/** Shared empty set, so the factory's first read does not allocate. */
const EMPTY_VISIBLE: ReadonlySet<string> = new Set<string>()

/** Module scope, so the list never sees a new `keyExtractor` identity. */
function groupKey(group: Group): string {
  return group.id
}

type SheetState =
  | { kind: 'none' }
  | { kind: 'file'; file: FileEntry }
  | { kind: 'move'; file: FileEntry }
  | { kind: 'group'; group: Group }
  | { kind: 'settings' }

export function LibraryScreen({
  onOpenFile,
}: {
  /**
   * Opens a file. The rect, when present, is where the tapped card was — the
   * reader grows out of it. Paths with no card to measure (a search result, the
   * file menu) simply omit it and get a scale-and-fade instead.
   */
  onOpenFile: (file: FileEntry, rect?: OpenRect) => void
}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()

  const load = useLibrary((s) => s.load)
  const reload = useLibrary((s) => s.reload)
  const loaded = useLibrary((s) => s.loaded)
  const addGroup = useLibrary((s) => s.addGroup)
  const addFiles = useLibrary((s) => s.addFiles)
  const removeGroup = useLibrary((s) => s.removeGroup)
  const restoreGroup = useLibrary((s) => s.restoreGroup)
  const moveFileToGroup = useLibrary((s) => s.moveFileToGroup)

  const queueRemoval = usePendingRemoval((s) => s.queue)
  const queueGroupRemoval = usePendingRemoval((s) => s.queueGroup)
  const resumeInterrupted = usePendingRemoval((s) => s.resumeInterrupted)

  const groups = useGroupsSorted()
  /*
   * Counts come from `groupOrder`, which is O(1) per group. These used to be
   * `files.filter(...)` per row — the O(groups x files) pattern that made
   * renaming a group re-scan the whole library on every keystroke.
   */
  const groupCounts = useGroupCounts()
  const fileCount = useFileCount()
  const pdfsNeedingCovers = usePdfsNeedingCovers()

  /*
   * Where the empty state's "add files" lands.
   *
   * `load()` guarantees at least one group exists, so this is only ever
   * undefined for the frame before the store settles — and the empty state is
   * not rendered then either, since `loaded` gates the whole screen.
   */
  const firstGroupId = groups[0]?.id ?? ''

  /*
   * The move sheet's preview covers are deliberately **not** selected here.
   *
   * They used to be, on the reasoning that a per-row version would be worse —
   * which is true, and did not justify running the selector when the sheet is
   * shut. `useGroupPreviews` walks every group on every store update, and the
   * sheet is closed almost always, so `MoveSheetContainer` owns that call now
   * and only while it is mounted. The sheet itself stays presentational.
   */

  /*
   * Library search: the query and its results.
   *
   * Results are held here rather than derived in a selector because they come
   * from SQLite, not from the store — FTS5 answers from its own index, which is
   * the point (a `LIKE` scan over the store would be the full-table scan this
   * replaces).
   */
  const [searchQuery, setSearchQuery] = useState('')
  const [results, setResults] = useState<SearchPage>(NO_RESULTS)

  /*
   * How many rows the user has asked for, in pages.
   *
   * Reset to 1 on every new query — "show more" is an answer about the query
   * that was on screen when it was pressed, and carrying it into the next one
   * would open a refined search already expanded.
   */
  const [pages, setPages] = useState(1)

  /*
   * Which groups are on screen, for the cover factory's priority.
   *
   * A ref, not state. This is written on every scroll settle, and the only
   * reader consults it when a capture slot opens — so as state it would
   * re-render the entire board to inform a component that is not looking. Same
   * reasoning as `store/scroll` living outside Zustand.
   */
  const visibleGroups = useRef<ReadonlySet<string>>(EMPTY_VISIBLE)
  const readVisibleGroups = useCallback(() => visibleGroups.current, [])

  /*
   * `FlatList` captures this on mount and throws if the identity changes, so
   * both this and the config below must be stable for the life of the screen.
   */
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: Array<{ key?: string | null }> }) => {
      const ids = new Set<string>()
      for (const item of viewableItems) {
        if (item.key) ids.add(item.key)
      }
      visibleGroups.current = ids
    },
  ).current

  const viewabilityConfig = useRef({
    /*
     * A row counts as visible once half of it is, and immediately.
     *
     * A row is nearly a screen tall, so a stricter threshold would mean the row
     * being scrolled toward is not "visible" until it has almost arrived — by
     * which point prioritising its covers is too late to matter. No minimum
     * view time for the same reason: this only orders a queue, so a row seen
     * briefly costs nothing to have prioritised.
     */
    itemVisiblePercentThreshold: 50,
    minimumViewTime: 0,
  }).current

  const [sheet, setSheet] = useState<SheetState>({ kind: 'none' })
  const [importing, setImporting] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  /*
   * The file the move sheet is acting on, held outside `sheet`.
   *
   * `MoveSheet` closes *before* it reports the chosen destination — a frame
   * later, via `requestAnimationFrame`, so the move does not re-render the
   * board mid-slide. By then `sheet` is already `{ kind: 'none' }`, so reading
   * the file back out of it would find nothing and the move would silently do
   * nothing at all. A ref written while the sheet is open survives that gap.
   *
   * Declared after `sheet` rather than beside the other derived values: it
   * reads that state during render, so an earlier declaration would be a
   * temporal dead zone reference.
   */
  const moveTargetRef = useRef<FileEntry | null>(null)
  if (sheet.kind === 'move') moveTargetRef.current = sheet.file

  useEffect(() => {
    void load()
  }, [load])

  /*
   * Finish any removal the previous run started but could not complete, once
   * the library is in memory for it to act on.
   *
   * Gated on `loaded` rather than chained off `load()`: the store dedupes
   * concurrent loads by returning a shared promise, so awaiting it here is not
   * a reliable "the files are now in state" signal.
   */
  useEffect(() => {
    if (loaded) resumeInterrupted()
  }, [loaded, resumeInterrupted])

  /*
   * Backgrounding is handled by `useAppLifecycle` in App.tsx, not here.
   *
   * It used to live in this component, which was a data-loss bug: this screen
   * unmounts while the reader is open, so "open a file, press Home, process
   * killed" ran no flush, no removal commit and no cache release. The handler
   * has to outlive any one screen, so it is mounted at the root.
   */

  /**
   * The pending debounced query, so it can be cancelled.
   *
   * A ref rather than state: nothing renders from it, and it is written on
   * every keystroke — as state that would be a second re-render per character,
   * which is the cost this debounce exists to remove.
   */
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /*
   * Typing is immediate; querying is not.
   *
   * `setSearchQuery` stays synchronous so the field never lags behind the
   * keyboard — the input is controlled, so deferring it would drop characters.
   * Only `searchFiles` is delayed, because it is a blocking FTS5 query on the
   * JS thread and was running once per character.
   *
   * An empty query clears **immediately** and cancels anything pending. A field
   * the user has just emptied that still shows the previous results reads as a
   * bug, and it is also the one case where the work is free.
   */
  const runSearch = useCallback((text: string) => {
    setSearchQuery(text)
    setPages(1)

    if (searchTimer.current) {
      clearTimeout(searchTimer.current)
      searchTimer.current = null
    }

    if (!text.trim()) {
      setResults(NO_RESULTS)
      return
    }

    searchTimer.current = setTimeout(() => {
      searchTimer.current = null
      setResults(searchFiles(text))
    }, SEARCH_DEBOUNCE_MS)
  }, [])

  /*
   * Widen the query by one page.
   *
   * Re-queries rather than paging with an OFFSET. FTS5 ranking is stable for a
   * fixed query, so asking for the first `n * PAGE` rows returns the same rows
   * in the same order plus the next ones — while an OFFSET page would have to
   * be concatenated onto results the user might meanwhile have invalidated by
   * deleting a file. Re-querying is one indexed read and cannot desynchronise.
   *
   * Read through the ref so this does not change identity per keystroke: it is
   * a dependency of the memoised header, which the search field lives in.
   */
  const queryRef = useRef(searchQuery)
  queryRef.current = searchQuery

  const showMore = useCallback(() => {
    setPages((n) => {
      const next = n + 1
      const want = next * SEARCH_PAGE
      const text = queryRef.current
      /*
       * Only re-query when the page runs past the rows already in hand.
       *
       * The first query fetches `searchFiles`' default limit, which is several
       * pages' worth — so the early presses are pure state changes and cost
       * nothing. Querying on every press would put a synchronous SQLite read
       * on a tap that already has the answer.
       */
      if (want > results.files.length && text.trim()) setResults(searchFiles(text, want))
      return next
    })
  }, [results.files.length])

  /*
   * Cancel a query that is still pending when the screen goes away.
   *
   * The board unmounts whenever a file is opened, so without this a keystroke
   * immediately before a tap would fire `setResults` on an unmounted component
   * — and, more to the point, run a blocking SQLite query during the reader's
   * opening animation.
   */
  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    }
  }, [])

  /*
   * `groupCounts` and `importing`, readable without being dependencies.
   *
   * `handleAddFiles` is passed to every mounted row, so its identity decides
   * whether `GroupRow`'s `memo()` does anything at all. Depending on
   * `groupCounts` — which changes on *every* library mutation — and on
   * `importing` would mint a new function on each, defeating the memo exactly
   * when the board is busiest.
   *
   * Both are only ever read at the moment of a tap, never during render, so a
   * ref is the correct shape: the handler sees the current value without the
   * component having to re-declare it. Assigned during render rather than in an
   * effect so a tap in the same frame as an import cannot read a stale count.
   */
  const groupCountsRef = useRef(groupCounts)
  groupCountsRef.current = groupCounts
  const importingRef = useRef(importing)
  importingRef.current = importing

  const handleAddFiles = useCallback(
    async (groupId: string) => {
      if (importingRef.current) return
      /*
       * Refuse an import with no destination.
       *
       * `load()` guarantees a starter group, so this is unreachable in practice
       * — but the empty state passes `groups[0]?.id ?? ''`, and importing into
       * a group id that does not exist would write entries the board can never
       * show: `groupOrder` has no row for them, so the files would be on disk,
       * in the index, and invisible.
       */
      if (!groupId) return
      setImporting(true)
      try {
        const startOrder = groupCountsRef.current[groupId] ?? 0
        const result = await importFiles(groupId, startOrder)
        if (result.entries.length) addFiles(result.entries)
        if (result.skipped.length) {
          Alert.alert(
            'Some files were skipped',
            `${result.skipped.length} file(s) had an unsupported type:\n\n${result.skipped
              .slice(0, 6)
              .join('\n')}${result.skipped.length > 6 ? '\n…' : ''}`,
          )
        }
      } catch (err) {
        Alert.alert('Import failed', String(err))
      } finally {
        setImporting(false)
      }
    },
    // Genuinely stable: `addFiles` is a Zustand action and never changes
    // identity, and the two values that do are read through refs above. This
    // function is created once for the life of the screen, which is what makes
    // the rows' `memo()` real rather than decorative.
    [addFiles],
  )

  /*
   * The row callbacks, hoisted so `GroupRow`'s `memo()` can actually hold.
   *
   * These were inline arrows inside `renderItem`, which allocated three fresh
   * functions per row per render — so every shallow prop comparison failed and
   * every mounted row re-rendered on every parent state change: each search
   * keystroke, each sheet open or close, each import, each `busy` toggle. The
   * memo was there the whole time and did nothing.
   *
   * `setSheet` is a `useState` setter and is stable by contract, so all three
   * of these are created once.
   */
  const handleFileMenu = useCallback((file: FileEntry) => setSheet({ kind: 'file', file }), [])

  const handleGroupMenu = useCallback((group: Group) => setSheet({ kind: 'group', group }), [])

  const handleRowAddFiles = useCallback(
    (groupId: string) => void handleAddFiles(groupId),
    [handleAddFiles],
  )

  // Header and footer callbacks, hoisted for the same reason as the row's: as
  // inline arrows they gave the memoised elements below a new dependency every
  // render, which would have made memoising them pointless.
  const openSettings = useCallback(() => setSheet({ kind: 'settings' }), [])

  const addGroupRow = useCallback(() => addGroup(), [addGroup])

  const addToFirstGroup = useCallback(
    () => void handleAddFiles(firstGroupId),
    [handleAddFiles, firstGroupId],
  )

  const handleExport = useCallback(async () => {
    setBusy('Building backup…')
    try {
      const Sharing = await import('expo-sharing')
      const result = await exportLibrary()

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(result.uri, {
          mimeType: 'application/zip',
          dialogTitle: 'Save StackRead backup',
        })
      } else {
        Alert.alert('Backup ready', `Saved to:
${result.uri}`)
      }
    } catch (err) {
      Alert.alert('Export failed', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [])

  const handleRestore = useCallback(async () => {
    try {
      const DocumentPicker = await import('expo-document-picker')
      const picked = await DocumentPicker.getDocumentAsync({
        type: 'application/zip',
        copyToCacheDirectory: true,
      })
      if (picked.canceled || !picked.assets[0]) return

      const asset = picked.assets[0]

      // Restoring replaces everything, so make that explicit before doing it.
      Alert.alert(
        'Replace your library?',
        'Restoring will remove the files currently in StackRead and replace them with the contents of this backup.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Replace',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                setBusy('Restoring…')
                try {
                  const result = await importLibraryArchive(asset.uri)
                  await reload()
                  Alert.alert(
                    'Library restored',
                    `${result.files} file(s) in ${result.groups} group(s).`,
                  )
                } catch (err) {
                  Alert.alert('Restore failed', err instanceof Error ? err.message : String(err))
                } finally {
                  setBusy(null)
                }
              })()
            },
          },
        ],
      )
    } catch (err) {
      Alert.alert('Restore failed', err instanceof Error ? err.message : String(err))
    }
  }, [reload])

  const settingsActions = useCallback(
    (): SheetAction[] => [
      { key: 'export', label: 'Back up library…', onPress: () => void handleExport() },
      { key: 'restore', label: 'Restore from backup…', onPress: () => void handleRestore() },
    ],
    [handleExport, handleRestore],
  )

  const fileActions = useCallback(
    (file: FileEntry): SheetAction[] => [
      { key: 'open', label: 'Open', onPress: () => onOpenFile(file) },
      { key: 'move', label: 'Move to group…', onPress: () => setSheet({ kind: 'move', file }) },
      {
        key: 'remove',
        label: 'Remove',
        destructive: true,
        onPress: () => queueRemoval(file),
      },
    ],
    [onOpenFile, queueRemoval],
  )

  /*
   * The destination picker is `MoveSheet`, not an `ActionSheet` of titles.
   *
   * It moved out because picking a destination is a spatial question — this is
   * the only path that changes a file's group, and a list of titles flattens
   * the board at exactly the moment the user is reasoning about it. The rule it
   * enforces is unchanged: the current group is listed but disabled, so a move
   * is always deliberate.
   */

  /**
   * Deletes a group and everything in it, undoably.
   *
   * The bug this replaces: the handler was `removeGroup(group.id)`, which drops
   * the entries from the index and nothing else. The comment in the store said
   * "callers delete the bytes"; this caller never did. So the files stayed on
   * disk — unreferenced, invisible, and reclaimed only by `pruneOrphans`, which
   * runs at most once a day and refuses to run on an empty library. Deleting
   * your last group stranded them indefinitely, while the dialog said they were
   * deleted.
   *
   * Routed through `pendingRemoval` rather than a `deleteFromLibrary` loop, so
   * it inherits the three things that path already gets right: the undo window,
   * the durable MMKV record that survives a process kill, and the id-keyed
   * cache invalidation. Deleting a dozen files at once is where an undo matters
   * most, and this was the only deletion in the app that had none.
   *
   * Order matters. The files are queued *first*, so they are hidden and
   * scheduled before the row disappears; `removeGroup` then takes the row. Undo
   * reverses it — the row comes back before the files are unhidden, so a file
   * is never a member of a group that does not exist.
   */
  const handleDeleteGroup = useCallback(
    (group: Group) => {
      const { groupOrder, filesById } = useLibrary.getState()
      const { hiddenIds } = usePendingRemoval.getState()

      /*
       * Files already inside their own undo window are skipped.
       *
       * They are hidden and scheduled for deletion by a removal the user made
       * separately, so including them would put them in this batch's undo
       * closure — and undoing the *group* would then resurrect a file they had
       * deleted on purpose, which is not something they asked for and not
       * something the toast said.
       */
      const entries = (groupOrder[group.id] ?? [])
        .map((id) => filesById[id])
        .filter((e): e is FileEntry => Boolean(e) && !hiddenIds.has(e.id))

      const order = group.order

      if (entries.length) {
        queueGroupRemoval(
          entries,
          `Removed “${group.title}” and ${entries.length} file(s)`,
          () => {
            // Rebuild the row, then put the files back where they were. The
            // group keeps its id, so the entries' `groupId` still points at it
            // and membership is restored by re-adding them in order.
            restoreGroup({ ...group, order })
            addFiles(entries)
          },
        )
      }

      removeGroup(group.id)
    },
    [addFiles, queueGroupRemoval, removeGroup, restoreGroup],
  )

  const groupActions = useCallback(
    (group: Group): SheetAction[] => {
      /*
       * The count the user is shown must be the count that gets deleted.
       *
       * `groupCounts` deliberately includes files inside their own undo window,
       * which is right for "how big is this row" and wrong here: those files
       * are already being removed and `handleDeleteGroup` skips them, so
       * counting them would promise to delete more than this action does.
       */
      const hidden = usePendingRemoval.getState().hiddenIds
      const ids = useLibrary.getState().groupOrder[group.id] ?? []
      const count = ids.reduce((n, id) => (hidden.has(id) ? n : n + 1), 0)
      return [
        {
          key: 'add',
          label: 'Add files…',
          onPress: () => void handleAddFiles(group.id),
        },
        {
          key: 'delete',
          label: count ? `Delete group and ${count} file(s)` : 'Delete group',
          destructive: true,
          disabled: groups.length <= 1,
          onPress: () => {
            Alert.alert(
              'Delete group?',
              count
                ? `“${group.title}” and its ${count} file(s) will be deleted.`
                : `“${group.title}” will be deleted.`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: () => handleDeleteGroup(group),
                },
              ],
            )
          },
        },
      ]
    },
    [groups.length, handleAddFiles, handleDeleteGroup],
  )

  /*
   * `renderItem`, memoised.
   *
   * Stabilising the three callbacks above is necessary but not sufficient: an
   * inline `renderItem` is itself a new function every render, and `FlatList`
   * treats a changed `renderItem` as a reason to re-render its rows regardless
   * of what the row props compare to. Both halves have to be stable for the
   * `memo()` to pay.
   *
   * Every dependency here is now stable for the life of the screen, so this is
   * created once — `theme` being the one that can legitimately change, on a
   * light/dark switch, which is exactly when the rows *should* re-render.
   */
  const renderGroup = useCallback(
    ({ item: group }: { item: Group }) => (
      <GroupRow
        group={group}
        theme={theme}
        onOpenFile={onOpenFile}
        onFileMenu={handleFileMenu}
        onAddFiles={handleRowAddFiles}
        onGroupMenu={handleGroupMenu}
      />
    ),
    [theme, onOpenFile, handleFileMenu, handleRowAddFiles, handleGroupMenu],
  )

  /*
   * The list's own object props, hoisted for the same reason.
   *
   * An inline style object and inline JSX are a fresh identity per render, so
   * they re-render the header and footer on every parent state change — the
   * header holds the search field, which is the one thing on screen that must
   * not be disturbed while it is being typed into.
   */
  const listContentStyle = useMemo(
    () => ({ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 96 }),
    [insets.top, insets.bottom],
  )

  /*
   * The header, memoised on what it actually shows.
   *
   * This is the one that matters most: it holds the search field, and as inline
   * JSX it was re-created on every parent state change — including the
   * `setSearchQuery` that each keystroke causes. Its dependencies are now the
   * values it renders, so typing re-creates it (it must: `searchQuery` and
   * `results` are its own props) while an import or a sheet toggle does not.
   */
  const listHeader = useMemo(
    () => (
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={[styles.appTitle, { color: theme.fg }]}>StackRead</Text>
          <Pressable
            onPress={openSettings}
            hitSlop={12}
            accessibilityLabel="Library options"
          >
            <Text style={[styles.gear, { color: theme.fgDim }]}>⋯</Text>
          </Pressable>
        </View>
        <Text style={[styles.appSub, { color: theme.fgFaint }]}>
          {fileCount === 0
            ? 'Add files to get started'
            : `${fileCount} file${fileCount === 1 ? '' : 's'} · ${groups.length} group${groups.length === 1 ? '' : 's'}`}
        </Text>

        {/*
          The board teaches itself while it is empty.

          Gated on files rather than groups: `load()` always invents a starter
          group, so "no groups" is a state the user never actually reaches — an
          empty state keyed on it would never appear.
        */}
        {fileCount === 0 && <EmptyBoard theme={theme} onAddFiles={addToFirstGroup} />}

        {/*
          Only once there is enough to lose track of. Below that the board *is*
          the index — a search field over eight files is a control that costs a
          row of chrome and answers a question nobody has.
        */}
        {fileCount >= SEARCH_THRESHOLD && (
          <LibrarySearch
            query={searchQuery}
            results={results}
            limit={pages * SEARCH_PAGE}
            theme={theme}
            onQueryChange={runSearch}
            onShowMore={showMore}
            onOpenFile={onOpenFile}
          />
        )}
      </View>
    ),
    [
      theme,
      fileCount,
      groups.length,
      searchQuery,
      results,
      pages,
      runSearch,
      showMore,
      onOpenFile,
      openSettings,
      addToFirstGroup,
    ],
  )

  const listFooter = useMemo(
    () => (
      <Pressable
        onPress={addGroupRow}
        android_ripple={{ color: theme.border }}
        style={({ pressed }) => [
          styles.newGroup,
          {
            borderColor: theme.border,
            backgroundColor: pressed ? theme.surfaceAlt : 'transparent',
          },
        ]}
      >
        <Text style={[styles.newGroupText, { color: theme.fgDim }]}>+ New group</Text>
      </Pressable>
    ),
    [theme, addGroupRow],
  )

  if (!loaded) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <ActivityIndicator color={theme.accent} />
      </View>
    )
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      {/*
        Virtualized on the vertical axis only.

        Rows are cheap individually, but every card in every row is a view tree
        with an image instance and two Reanimated shared values — so a board of
        fifty groups mounts everything at once and a cold start pays for all of
        it before anything is interactive.

        `FlatList` rather than FlashList: FlashList was deliberately removed
        from this project, and an unused native module is real weight in the
        APK. The rows themselves stay plain `ScrollView`s, which is what avoids
        nesting one virtualized list inside another — the problem that made
        virtualizing both axes a bad trade in the first place.
      */}
      {/*
        `skipEntering` suppresses entering animations for the *first* render
        only. Without it a cold start with a full library performs a second of
        cascading entrances before the user can do anything — the animation
        should mark things that just arrived, not replay the whole library.

        Wrapping the list rather than the rows: with virtualization the rows are
        mounted and unmounted as they scroll, and each remount would otherwise
        replay its entrance.
      */}
      <LayoutAnimationConfig skipEntering>
      <FlatList
        data={groups}
        keyExtractor={groupKey}
        contentContainerStyle={listContentStyle}
        showsVerticalScrollIndicator={false}
        // Three screens of rows kept mounted. Enough that scrolling at a normal
        // speed never reveals a blank row, small enough that a large library
        // does not hold the whole board in memory.
        windowSize={3}
        removeClippedSubviews
        // A row is tall and expensive; rendering many per batch is what causes
        // a visible stall mid-scroll.
        maxToRenderPerBatch={4}
        initialNumToRender={4}
        renderItem={renderGroup}
        // Feeds the cover factory's priority; see `visibleGroups` above.
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        ListHeaderComponent={listHeader}
        ListFooterComponent={listFooter}
      />
      </LayoutAnimationConfig>

      {(importing || busy) && (
        <View style={[styles.importing, { backgroundColor: theme.overlay }]} pointerEvents="none">
          <ActivityIndicator color="#fff" />
          <Text style={styles.importingText}>{busy ?? 'Importing…'}</Text>
        </View>
      )}

      {/*
        Rasterises page one of any PDF still showing a badge, one at a time and
        only once the board has settled. Mounted here rather than at the app
        root deliberately: this screen unmounts while the reader is open, which
        is exactly when a second live pdfium document must not exist.
      */}
      <PdfCoverFactory
        fileIds={pdfsNeedingCovers}
        enabled={loaded && !busy && !importing}
        visibleGroups={readVisibleGroups}
      />

      <UndoToasts theme={theme} />

      <ActionSheet
        visible={sheet.kind === 'file'}
        title={sheet.kind === 'file' ? sheet.file.name : undefined}
        actions={sheet.kind === 'file' ? fileActions(sheet.file) : []}
        theme={theme}
        onClose={() => setSheet({ kind: 'none' })}
      />

      {/*
        A dedicated sheet rather than an `ActionSheet` of titles: this is the
        only path that changes a file's group, and picking a destination is a
        spatial question that a text list answers badly. See `MoveSheet`.
      */}
      <MoveSheetContainer
        visible={sheet.kind === 'move'}
        file={sheet.kind === 'move' ? sheet.file : moveTargetRef.current}
        groups={groups}
        counts={groupCounts}
        theme={theme}
        /*
         * The file is captured here rather than read from `sheet` inside the
         * handler. `MoveSheet` closes before it calls this — deliberately, so
         * the move does not re-render mid-slide — by which point `sheet.kind`
         * is already 'none' and reading the file out of it would find nothing.
         */
        onMove={(groupId) => {
          const target = moveTargetRef.current
          if (target) moveFileToGroup(target.id, groupId)
        }}
        onClose={() => setSheet({ kind: 'none' })}
      />

      <ActionSheet
        visible={sheet.kind === 'settings'}
        title="Library"
        subtitle="Backups include every file and its groups"
        actions={sheet.kind === 'settings' ? settingsActions() : []}
        theme={theme}
        onClose={() => setSheet({ kind: 'none' })}
      />

      <ActionSheet
        visible={sheet.kind === 'group'}
        title={sheet.kind === 'group' ? sheet.group.title : undefined}
        actions={sheet.kind === 'group' ? groupActions(sheet.group) : []}
        theme={theme}
        onClose={() => setSheet({ kind: 'none' })}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { paddingHorizontal: 16, marginBottom: 22 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  gear: { fontSize: 24, fontWeight: '700' },
  appTitle: { fontSize: 30, fontWeight: '700', letterSpacing: -0.6 },
  appSub: { fontSize: 13, marginTop: 3 },
  newGroup: {
    marginHorizontal: 16,
    marginTop: 4,
    paddingVertical: 16,
    borderRadius: 14,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    alignItems: 'center',
  },
  newGroupText: { fontSize: 14, fontWeight: '600' },
  importing: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  importingText: { color: '#fff', fontSize: 14 },
})
