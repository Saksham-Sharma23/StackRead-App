import { useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated'
import { Image } from 'expo-image'

import type { FileEntry, Group } from '../types'
import { useGroupPreviews } from '../store/selectors'
import { thumbUri } from '../storage/paths'
import { badgeOf } from '../storage/formats'
import { CARD, type Theme } from '../ui/theme'
import { usePressAnimation } from '../ui/usePressAnimation'
import { SheetShell } from './SheetShell'

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

/**
 * Destination picker for moving a file between groups.
 *
 * ## Why this is not just an `ActionSheet`
 *
 * It was one, and the rows were group titles as plain text. That flattened the
 * board at the exact moment the user is reasoning about *where something goes* —
 * a spatial question, asked with a list.
 *
 * It also matters more than its frequency suggests. Dragging is confined to a
 * card's own row by design, so this sheet is the **only** path that changes a
 * file's group ([DETAIL.md §5.1](../../DETAIL.md) — cross-group moves are
 * deliberately always explicit). A rarely-used, irreversible-feeling action
 * deserves to show what it is about to do.
 *
 * ## What each row shows
 *
 * The group's name, how many files it holds, and the first few covers in it. The
 * covers are the point: recognising "the row with the blue paper and the two
 * comics" is how someone actually identifies a group on the board, and it is far
 * faster than reading a title they chose weeks ago.
 *
 * ## Why the current group is shown and disabled
 *
 * Hiding it would silently renumber the list between openings, so the same
 * destination sits in a different place depending on where the file started.
 * Showing it dimmed keeps the sheet's shape stable and answers "where is this
 * now" at the same time.
 */

interface Props {
  visible: boolean
  /** The file being moved, or null when the sheet is closed. */
  file: FileEntry | null
  groups: Group[]
  /** Group id to the first few files in it, for the preview strip. */
  previews: Record<string, FileEntry[]>
  counts: Record<string, number>
  theme: Theme
  onMove: (groupId: string) => void
  onClose: () => void
}

/** Covers shown per destination. Three reads as "a sample", four as a crowd. */
const PREVIEW_COUNT = 3

/** One destination row, with its own press progress. */
function Destination({
  group,
  count,
  preview,
  current,
  theme,
  onPress,
}: {
  group: Group
  count: number
  preview: FileEntry[]
  current: boolean
  theme: Theme
  onPress: () => void
}) {
  // Tint rather than scale, matching `ActionSheet`: a full-width row that
  // shrinks on touch looks like it is detaching from the sheet.
  const press = usePressAnimation({ scale: 1 })

  const tint = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      press.progress.value,
      [0, 1],
      ['transparent', theme.surfaceAlt],
    ),
  }))

  return (
    <AnimatedPressable
      disabled={current}
      onPress={onPress}
      {...press.pressProps}
      android_ripple={current ? undefined : { color: theme.surfaceAlt }}
      style={[styles.row, tint, current && styles.rowDisabled]}
      accessibilityRole="button"
      accessibilityLabel={
        current
          ? `${group.title}, current group`
          : `Move to ${group.title}, ${count} file${count === 1 ? '' : 's'}`
      }
    >
      {/*
        The preview strip is decorative — the row's accessibility label already
        names the group and its size, so announcing the covers as well would say
        the same thing twice and at more length.
      */}
      <View
        style={styles.strip}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {preview.length === 0 ? (
          <View style={[styles.chipEmpty, { borderColor: theme.border }]} />
        ) : (
          preview.map((entry, i) => (
            <View
              key={entry.id}
              style={[
                styles.chip,
                {
                  backgroundColor: theme.surfaceAlt,
                  borderColor: theme.border,
                  // Overlapped like a small stack of cards, so three covers
                  // occupy roughly the width of one and a half.
                  marginLeft: i === 0 ? 0 : -14,
                  zIndex: PREVIEW_COUNT - i,
                },
              ]}
            >
              {entry.thumb ? (
                <Image
                  source={{ uri: thumbUri(entry.thumb) }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                  recyclingKey={entry.id}
                  placeholder={entry.thumbhash ? { thumbhash: entry.thumbhash } : undefined}
                  placeholderContentFit="cover"
                  transition={120}
                />
              ) : (
                <View style={[styles.chipBadge, { backgroundColor: badgeOf(entry.name).color }]} />
              )}
            </View>
          ))
        )}
      </View>

      <View style={styles.text}>
        <Text numberOfLines={1} style={[styles.title, { color: current ? theme.fgFaint : theme.fg }]}>
          {group.title}
        </Text>
        <Text numberOfLines={1} style={[styles.meta, { color: theme.fgFaint }]}>
          {current ? 'Current group' : count === 0 ? 'Empty' : `${count} file${count === 1 ? '' : 's'}`}
        </Text>
      </View>
    </AnimatedPressable>
  )
}

/**
 * Mounts `MoveSheet` — and therefore its preview selector — only when needed.
 *
 * ## Why this wrapper exists
 *
 * `useGroupPreviews()` walks every group building a concatenated string key on
 * **every store update**. That key trick is correct and deliberate (see
 * `selectors.ts`), but it was being paid unconditionally at screen level for a
 * sheet that is shut almost always: every import, rename, reorder and thumbnail
 * write ran it for nothing.
 *
 * Hooks cannot be called conditionally, so gating it means gating the component
 * that calls it. That is this file's job rather than the screen's, because the
 * screen's existing comment is right that a *per-row* version would be worse —
 * the point is to keep the selector out of the rows, not to run it always.
 *
 * ## Why it is not simply `{open && <MoveSheet/>}`
 *
 * `SheetShell` stays mounted through its own exit animation, so unmounting on
 * `visible === false` would cut the slide-out and make the sheet vanish. This
 * keeps rendering for one dismissal after `visible` drops, then stops — so the
 * animation completes and the selector still stops running once the sheet is
 * closed.
 */
export function MoveSheetContainer(props: Omit<Props, 'previews'>) {
  /*
   * True while the sheet is open, and for the dismissal that follows.
   *
   * Latched rather than derived: `visible` going false starts the exit
   * animation, and the sheet has to stay rendered for it. Cleared by
   * `onClose`'s completion below, which is when nothing needs the previews any
   * more.
   */
  const [live, setLive] = useState(props.visible)

  useEffect(() => {
    if (props.visible) setLive(true)
  }, [props.visible])

  /*
   * Stops rendering once the sheet is closed *and* has finished animating.
   *
   * `SheetShell` unmounts its own Modal when the exit completes; there is no
   * callback for that, so this uses the same signal the shell does — a frame
   * after `visible` drops, the animation owns the view and the previews are no
   * longer read by anything on screen. The delay is generous rather than tight
   * because being wrong costs one extra selector run, while being too eager
   * costs a visibly broken dismissal.
   */
  useEffect(() => {
    if (props.visible) return
    const t = setTimeout(() => setLive(false), 400)
    return () => clearTimeout(t)
  }, [props.visible])

  if (!live) return null

  return <MoveSheetWithPreviews {...props} />
}

/**
 * The selector's only caller, so it runs exactly while the sheet is alive.
 *
 * Split from the container because a hook cannot live behind the early return
 * above — this component exists to be the thing that is or is not mounted.
 */
function MoveSheetWithPreviews(props: Omit<Props, 'previews'>) {
  const previews = useGroupPreviews()
  return <MoveSheet {...props} previews={previews} />
}

export function MoveSheet({
  visible,
  file,
  groups,
  previews,
  counts,
  theme,
  onMove,
  onClose,
}: Props) {
  return (
    <SheetShell visible={visible} theme={theme} onClose={onClose}>
      <Text style={[styles.sheetTitle, { color: theme.fg }]}>Move to group</Text>
      {file && (
        <Text numberOfLines={1} style={[styles.sheetSub, { color: theme.fgDim }]}>
          {file.name}
        </Text>
      )}

      <ScrollView style={styles.list} bounces={false}>
        {groups.map((group) => (
          <Destination
            key={group.id}
            group={group}
            count={counts[group.id] ?? 0}
            preview={(previews[group.id] ?? []).slice(0, PREVIEW_COUNT)}
            current={group.id === file?.groupId}
            theme={theme}
            onPress={() => {
              onClose()
              // Let the sheet start dismissing before the move mutates state,
              // matching `ActionSheet` — a re-render mid-slide stutters it.
              requestAnimationFrame(() => onMove(group.id))
            }}
          />
        ))}
      </ScrollView>
    </SheetShell>
  )
}

/** Preview chips are the card's proportions, small enough for three in a row. */
const CHIP_W = 34
const CHIP_H = CHIP_W * (CARD.height / CARD.width)

const styles = StyleSheet.create({
  sheetTitle: { fontSize: 17, fontWeight: '700', paddingHorizontal: 20, paddingTop: 4 },
  sheetSub: { fontSize: 13, paddingHorizontal: 20, paddingTop: 2, paddingBottom: 8 },
  list: { paddingVertical: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 20,
    paddingVertical: 11,
  },
  rowDisabled: { opacity: 0.55 },
  strip: { flexDirection: 'row', alignItems: 'center', width: CHIP_W * 2 },
  chip: {
    width: CHIP_W,
    height: CHIP_H,
    borderRadius: 5,
    borderWidth: 1,
    overflow: 'hidden',
  },
  chipEmpty: {
    width: CHIP_W,
    height: CHIP_H,
    borderRadius: 5,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  chipBadge: { flex: 1 },
  text: { flex: 1, gap: 1 },
  title: { fontSize: 15, fontWeight: '600' },
  meta: { fontSize: 12 },
})
