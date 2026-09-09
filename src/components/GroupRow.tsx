import { memo, useCallback, useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated'

import type { FileEntry, Group } from '../types'
import type { OpenRect } from '../ui/openTransition'
import { useGroupFileIds } from '../store/selectors'
import { useLibrary } from '../store/library'
import type { Theme } from '../ui/theme'
import { Duration, Ease, layoutTransition } from '../ui/motion'
import { AddTile } from './AddTile'
import { MoreTile } from './MoreTile'
import { DraggableCard } from './DraggableCard'

/**
 * One group: a horizontal row of cards.
 *
 * The horizontal axis is the group; the vertical axis (rows) is handled by the
 * board above. A row scrolls independently, which is the phone equivalent of the
 * desktop board's 2-D pan.
 *
 * Uses a plain `ScrollView` rather than a nested list. Groups hold tens of files,
 * not thousands, and a horizontally-virtualized list nested inside a vertical one
 * costs more in measurement complexity and gesture conflicts than it saves here.
 *
 * The vertical axis is the one that can grow without bound, so that is where
 * virtualization belongs — see `LibraryScreen`, which uses a `FlatList` for the
 * board while these rows stay plain. Keeping the horizontal axis unvirtualized
 * is what avoids nesting one virtualized list inside another.
 */

/**
 * Cards mounted before the row is expanded.
 *
 * Comfortably more than fits on screen, so the window is invisible for any row
 * of ordinary size and the "show more" tile only appears where it is earning
 * something.
 */
const INITIAL_WINDOW = 30

/** How many more each tap reveals. */
const WINDOW_STEP = 30

interface Props {
  group: Group
  theme: Theme
  onOpenFile: (file: FileEntry, rect?: OpenRect) => void
  onFileMenu: (file: FileEntry) => void
  onAddFiles: (groupId: string) => void
  onGroupMenu: (group: Group) => void
}

function GroupRowImpl({ group, theme, onOpenFile, onFileMenu, onAddFiles, onGroupMenu }: Props) {
  /*
   * Ids, not entries.
   *
   * `useGroupFiles` subscribes to the whole `filesById` map, which every
   * reducer replaces — so one thumbnail landing re-ran this row's `useMemo`,
   * produced a new array, and re-rendered every card in it. On a board of
   * twenty rows an import re-rendered all of them, repeatedly
   * ([AUDIT2 §3.1](../../AUDIT2.md)).
   *
   * The row only ever needed ids: order, count and identity. The entry is
   * subscribed by the card that draws it.
   */
  const files = useGroupFileIds(group.id)
  const renameGroup = useLibrary((s) => s.renameGroup)
  const reorderWithinGroup = useLibrary((s) => s.reorderWithinGroup)

  // A drag must not fight the row's own horizontal scroll.
  const [dragging, setDragging] = useState(false)

  /*
   * How many cards of this row are mounted.
   *
   * The vertical axis is virtualized (P3-4), but a row is a plain ScrollView,
   * so every card in it mounts the moment the row scrolls into view — each one
   * an expo-image instance, a `useMMKVNumber` subscription and two Reanimated
   * shared values. The docstring above says groups hold "tens of files, not
   * thousands", and that is a product assumption nothing enforces: a row with
   * 400 files mounts 400 card trees.
   *
   * A window plus a "show more" tile keeps the plain ScrollView — and therefore
   * the drag behaviour and the absence of nested virtualization — while
   * bounding what a single row can cost.
   */
  const [windowSize, setWindowSize] = useState(INITIAL_WINDOW)

  /*
   * Reset when the row changes identity.
   *
   * Without this, expanding one long row and then switching to a different
   * group would leave the new row mounted at the old row's expanded size —
   * paying the cost this exists to avoid, for a row nobody expanded.
   */
  useEffect(() => setWindowSize(INITIAL_WINDOW), [group.id])

  const visible = files.length > windowSize ? files.slice(0, windowSize) : files
  const hidden = files.length - visible.length

  const handleReorder = useCallback(
    (from: number, to: number) => reorderWithinGroup(group.id, from, to),
    [group.id, reorderWithinGroup],
  )

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(group.title)

  const commitTitle = useCallback(() => {
    const next = draft.trim()
    if (next && next !== group.title) renameGroup(group.id, next)
    else setDraft(group.title)
    setEditing(false)
  }, [draft, group.id, group.title, renameGroup])

  return (
    <Animated.View
      entering={FadeIn.duration(Duration.medium).easing(Ease.enter)}
      exiting={FadeOut.duration(Duration.medium).easing(Ease.exit)}
      // A row is the tallest thing on the board, so its collapse is the most
      // visible reflow in the app — and the most valuable layout transition.
      layout={layoutTransition()}
      style={styles.row}
    >
      <View style={styles.header}>
        {editing ? (
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onBlur={commitTitle}
            onSubmitEditing={commitTitle}
            autoFocus
            selectTextOnFocus
            returnKeyType="done"
            style={[styles.title, styles.titleInput, { color: theme.fg, borderColor: theme.accent }]}
          />
        ) : (
          <Pressable onPress={() => setEditing(true)} hitSlop={6} style={styles.titlePress}>
            <Text style={[styles.title, { color: theme.fg }]} numberOfLines={1}>
              {group.title}
            </Text>
          </Pressable>
        )}

        <Text style={[styles.count, { color: theme.fgFaint }]}>
          {files.length === 0 ? 'empty' : `${files.length}`}
        </Text>

        <Pressable
          onPress={() => onGroupMenu(group)}
          hitSlop={10}
          style={styles.groupMenuBtn}
          accessibilityLabel={`Options for group ${group.title}`}
        >
          <Text style={[styles.groupMenuGlyph, { color: theme.fgDim }]}>⋯</Text>
        </Pressable>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
        // Keeps the row responsive while the vertical board is also scrollable.
        directionalLockEnabled
        // Freeze the strip while a card is lifted, or the scroll view and the
        // drag would both claim the same horizontal movement.
        scrollEnabled={!dragging}
      >
        {visible.map((fileId, i) => (
          <DraggableCard
            key={fileId}
            fileId={fileId}
            index={i}
            count={files.length}
            // Layout animations cost UI-thread bookkeeping per card, every
            // frame one is running. Worth it for a handful of cards, where a
            // reorder or removal is clearly visible; not worth it for a long
            // row, where the motion is mostly offscreen anyway.
            animateLayout={files.length <= 12}
            theme={theme}
            onOpen={onOpenFile}
            onMenu={onFileMenu}
            onReorder={handleReorder}
            onDragStateChange={setDragging}
          />
        ))}
        {hidden > 0 && (
          <MoreTile
            count={hidden}
            theme={theme}
            onPress={() => setWindowSize((n) => n + WINDOW_STEP)}
          />
        )}

        <AddTile theme={theme} onPress={() => onAddFiles(group.id)} />
      </ScrollView>
    </Animated.View>
  )
}

export const GroupRow = memo(GroupRowImpl)

const styles = StyleSheet.create({
  row: { marginBottom: 22 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 10,
    gap: 8,
  },
  titlePress: { flexShrink: 1 },
  title: { fontSize: 17, fontWeight: '600', letterSpacing: -0.2 },
  titleInput: {
    borderBottomWidth: 1.5,
    paddingVertical: 2,
    minWidth: 140,
  },
  count: { fontSize: 13, fontVariant: ['tabular-nums'] },
  groupMenuBtn: { marginLeft: 'auto', paddingHorizontal: 4 },
  groupMenuGlyph: { fontSize: 18, fontWeight: '700' },
  strip: { paddingHorizontal: 16, alignItems: 'flex-start' },
})
