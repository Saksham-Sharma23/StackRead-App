import { memo, useEffect } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSequence, withTiming } from 'react-native-reanimated'
import { Image } from 'expo-image'

import { thumbUri } from '../storage/paths'
import { usePageNav } from '../store/pageNav'
import { CARD } from '../ui/theme'
import { usePressAnimation } from '../ui/usePressAnimation'
import { Duration, Ease, Timing } from '../ui/motion'
import type { Theme } from '../ui/theme'
import { useLastRead } from '../store/lastRead'
import { getShownProgress, setShownProgress } from './shownProgress'
import { Icon } from './Icon'
import {
  groupTint,
  type BoardHeaderProps,
  type GroupHeaderProps,
  type LookCardProps,
  type LookFonts,
  type ReaderBottomProps,
  type ReaderTopProps,
  type Skin,
} from './skin'
import { cleanTitle, positionLabel } from './text'
import { useCard } from './useCard'
import { SHARED_SHEETS } from './sheets'
import { LookEmptyBoard } from './emptyBoard'

/**
 * THE LAYOUT every optional look shares (decided 2026-11-02: "same layout
 * throughout").
 *
 * One board, one card, one reader chrome — Modern's — built per look from a
 * small spec: its fonts, its corner radius, and a size adjustment for type that
 * reads smaller than Geist at the same point size. Colours come from the theme.
 * So the four looks differ in exactly three things, and a fix to the layout is
 * a fix to all of them.
 *
 * A factory rather than components that read the look at render: each look's
 * components and styles are made once, when the look is first loaded, so a
 * board of a hundred cards subscribes to nothing extra.
 */

export interface LookSpec {
  fonts: LookFonts
  /** Corner radius for cards, buttons, fields and panels. */
  corner: number
  /** Multiplies brand, group and card-title sizes. 1 for Geist. */
  headingScale?: number
}

const CARD_H = 188
const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

/*
 * Return-to-board timing. The reader's fold takes about 180 ms, so the
 * progress line waits for it before growing; the ring holds briefly, then fades.
 * The whole ring is about a second end to end — long enough to find, short
 * enough to be gone before you start looking at anything else.
 */
const GROW_DELAY = 220
const RING_HOLD = 450
/** How fresh the close must be for a mounting card to ring: covers the board's mount, not a later scroll. */
const RING_WINDOW = 1200

export function makeLayout(spec: LookSpec): Skin {
  const F = spec.fonts
  const corner = spec.corner
  const hs = spec.headingScale ?? 1
  const small = Math.min(corner, 3)

  const styles = StyleSheet.create({
    flex: { flex: 1, minWidth: 0 },
    iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    headRow: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 52 },
    logo: { width: 22, height: 22 },
    logoBack: { position: 'absolute', left: 8, top: 1, width: 13, height: 17, borderRadius: Math.min(corner, 3.5), opacity: 0.3 },
    logoFront: { position: 'absolute', left: 2, top: 4, width: 13, height: 17, borderRadius: Math.min(corner, 3.5) },
    brand: { ...F.display, fontSize: 19 * hs, letterSpacing: -0.3 },
    sub: { ...F.metaStrong, fontSize: 11, letterSpacing: 0.6 },

    groupHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 20, paddingRight: 8, paddingTop: 12, paddingBottom: 6 },
    chip: { width: 10, height: 10, borderRadius: small },
    groupTitleWrap: { flexShrink: 1 },
    count: { ...F.meta, fontSize: 12 },
    groupMenu: { marginLeft: 'auto', width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },

    slot: { width: CARD.width, marginRight: CARD.gap },
    card: { width: CARD.width, height: CARD_H, borderRadius: corner, borderWidth: StyleSheet.hairlineWidth * 2, padding: 12, paddingBottom: 14, gap: 6, overflow: 'hidden' },
    no: { ...F.metaStrong, fontSize: 11 },
    thumb: { height: 64, borderRadius: Math.max(0, corner - 6) },
    cardTitle: { ...F.title, fontSize: 15 * hs, lineHeight: 19 * hs, letterSpacing: -0.15 },
    snip: { ...F.body, fontSize: 11, lineHeight: 15 },
    foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    fmt: { ...F.metaStrong, fontSize: 10, letterSpacing: 0.6 },
    size: { ...F.meta, fontSize: 10 },
    read: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    track: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3 },
    fill: { height: 3 },
    cardMenu: { position: 'absolute', top: 6, right: 4, width: 30, height: 28, alignItems: 'center', justifyContent: 'center' },
    ring: { position: 'absolute', top: -3, left: -3, width: CARD.width + 6, height: CARD_H + 6, borderRadius: corner + 3, borderWidth: 2 },

    addTile: { width: 96, height: CARD_H, marginRight: CARD.gap, borderRadius: corner, borderWidth: 1, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', gap: 6 },
    addText: { ...F.body, fontSize: 12 },
    newGroup: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', marginHorizontal: 20, marginTop: 4, height: 50, borderRadius: corner, borderWidth: 1, borderStyle: 'dashed' },
    newGroupText: { ...F.medium, fontSize: 15 },

    // Classic's bar geometry: 10 side padding, 9 between items, 34-high fields.
    rTop: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth * 2 },
    backBtn: { width: 32, height: 44, alignItems: 'center', justifyContent: 'center' },
    moreBtn: { width: 36, height: 44, alignItems: 'center', justifyContent: 'center' },
    pickWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
    pickLabel: { ...F.medium, fontSize: 12 },
    pickField: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingLeft: 10, paddingRight: 7, borderRadius: Math.min(corner, 8), borderWidth: 1 },
    pickDot: { width: 7, height: 7, borderRadius: Math.min(corner, 4) },
    pickValue: { ...F.medium, fontSize: 13, flex: 1 },

    rBottom: { paddingHorizontal: 20, paddingTop: 12, gap: 10, borderTopWidth: StyleSheet.hairlineWidth * 2 },
    nextRow: { flexDirection: 'row', gap: 16 },
    nextSide: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    alignEnd: { justifyContent: 'flex-end' },
    nextText: { ...F.body, fontSize: 12, flexShrink: 1 },
    scrubRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    scrubNo: { ...F.metaStrong, fontSize: 12, minWidth: 18, textAlign: 'center' },
    scrub: { flex: 1, height: 16, justifyContent: 'center' },
    scrubTrack: { position: 'absolute', left: 0, right: 0, height: 3, borderRadius: 2, opacity: 0.25 },
    scrubFill: { position: 'absolute', left: 0, height: 3, borderRadius: 2 },
    scrubThumb: { position: 'absolute', width: 14, height: 14, borderRadius: corner >= 4 ? 7 : 2, marginLeft: -7, borderWidth: 2 },
    caption: { ...F.meta, fontSize: 11, textAlign: 'center' },
  })

  function Logo({ theme }: { theme: Theme }) {
    return (
      <View style={styles.logo}>
        <View style={[styles.logoBack, { backgroundColor: theme.fg }]} />
        <View style={[styles.logoFront, { backgroundColor: theme.accent }]} />
      </View>
    )
  }

  function BoardHeader({ theme, fileCount, groupCount, onMenu }: BoardHeaderProps) {
    return (
      <View>
        <View style={styles.headRow}>
          <Logo theme={theme} />
          <Text style={[styles.brand, { color: theme.fg }]}>StackRead</Text>
          <View style={styles.flex} />
          <Pressable onPress={onMenu} hitSlop={10} style={styles.iconBtn} accessibilityLabel="Library options">
            <Icon name="more" color={theme.fgDim} />
          </Pressable>
        </View>
        <Text style={[styles.sub, { color: theme.fgFaint }]}>
          {fileCount === 0
            ? 'ADD FILES TO GET STARTED'
            : `${fileCount} FILE${fileCount === 1 ? '' : 'S'} · ${groupCount} GROUP${groupCount === 1 ? '' : 'S'}`}
        </Text>
      </View>
    )
  }

  function GroupHeader({ group, count, theme, title, onMenu }: GroupHeaderProps) {
    return (
      <View style={styles.groupHead}>
        <View style={[styles.chip, { backgroundColor: groupTint(theme, group.id) }]} />
        <View style={styles.groupTitleWrap}>{title}</View>
        <Text style={[styles.count, { color: theme.fgFaint }]}>{count === 0 ? 'empty' : count}</Text>
        <Pressable onPress={onMenu} hitSlop={10} style={styles.groupMenu} accessibilityLabel={`Options for group ${group.title}`}>
          <Icon name="more" size={20} color={theme.fgFaint} />
        </Pressable>
      </View>
    )
  }

  const groupTitle = (theme: Theme) => ({ ...F.title, fontSize: 17 * hs, letterSpacing: -0.2, color: theme.fg })

  function CardImpl({ fileId, index, theme, onOpen, onMenu }: LookCardProps) {
    const c = useCard(fileId, onOpen)
    const press = usePressAnimation()
    const p = c.progress

    /*
     * Progress grows from what this card last showed to what it is now.
     *
     * The board is remounted after reading, so without the remembered value the
     * line would simply be at its new length. A short delay lets the reader's
     * fold finish first, so the growth is actually seen. Timed and eased, not a
     * spring: nothing in a reading app should bounce.
     */
    const fill = useSharedValue(getShownProgress(fileId) ?? p)
    useEffect(() => {
      const from = getShownProgress(fileId)
      setShownProgress(fileId, p)
      fill.value = from !== undefined && from !== p ? withDelay(GROW_DELAY, withTiming(p, Timing.standard)) : p
    }, [fileId, p, fill])
    const fillStyle = useAnimatedStyle(() => ({ width: `${fill.value}%` }))

    /*
     * A brief ring on the card you were just reading, so the board says where
     * you were. Only when this mount is the board coming back from the reader
     * (the stamp is fresh); never on a later scroll past the card.
     */
    const returnedAt = useLastRead((s) => (s.id === fileId ? s.returnedAt : 0))
    const ring = useSharedValue(0)
    useEffect(() => {
      if (!returnedAt || Date.now() - returnedAt > RING_WINDOW) return
      ring.value = withSequence(
        withTiming(1, Timing.enter),
        withDelay(RING_HOLD, withTiming(0, { duration: Duration.slow, easing: Ease.standard })),
      )
    }, [returnedAt, ring])
    const ringStyle = useAnimatedStyle(() => ({ opacity: ring.value }))

    if (!c.entry) return null
    const tint = groupTint(theme, c.file.groupId)
    return (
      <View style={styles.slot}>
        <Animated.View pointerEvents="none" style={[styles.ring, { borderColor: tint }, ringStyle]} />
        <AnimatedPressable
          ref={c.ref}
          onPress={c.open}
          {...press.pressProps}
          android_ripple={{ color: theme.border }}
          style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }, press.animatedStyle]}
          accessibilityLabel={c.title}
        >
          <Text style={[styles.no, { color: theme.fgFaint }]}>{positionLabel(index)}</Text>
          {c.file.thumb ? (
            <Image
              source={{ uri: thumbUri(c.file.thumb) }}
              style={[styles.thumb, { backgroundColor: theme.surfaceAlt }]}
              contentFit="cover"
              recyclingKey={c.file.id}
              placeholder={c.file.thumbhash ? { thumbhash: c.file.thumbhash } : undefined}
              transition={120}
            />
          ) : null}
          <Text numberOfLines={c.file.thumb ? 2 : 3} style={[styles.cardTitle, { color: theme.fg }]}>
            {c.title}
          </Text>
          {!c.file.thumb && c.snippet ? (
            <Text numberOfLines={3} style={[styles.snip, { color: theme.fgDim }]}>
              {c.snippet}
            </Text>
          ) : null}
          <View style={styles.flex} />
          <View style={styles.foot}>
            <Text style={[styles.fmt, { color: theme.fgFaint }]}>{c.format}</Text>
            {p >= 100 ? (
              <View style={styles.read}>
                <Icon name="check" size={12} color={tint} strokeWidth={2.2} />
                <Text style={[styles.fmt, { color: tint }]}>Read</Text>
              </View>
            ) : (
              <Text style={[styles.size, { color: theme.fgFaint }]}>{c.size}</Text>
            )}
          </View>
          {p > 0 && (
            <View style={[styles.track, { backgroundColor: theme.border }]}>
              <Animated.View style={[styles.fill, { backgroundColor: tint }, fillStyle]} />
            </View>
          )}
        </AnimatedPressable>
        <Pressable onPress={() => onMenu(c.file)} hitSlop={8} style={styles.cardMenu} accessibilityLabel={`Options for ${c.file.name}`}>
          <Icon name="more" size={16} color={theme.fgFaint} />
        </Pressable>
      </View>
    )
  }

  function AddTile({ theme, onPress }: { theme: Theme; onPress: () => void }) {
    return (
      <Pressable onPress={onPress} style={[styles.addTile, { borderColor: theme.border }]} accessibilityLabel="Add files to this group">
        <Icon name="plus" size={22} color={theme.fgFaint} />
        <Text style={[styles.addText, { color: theme.fgFaint }]}>Add files</Text>
      </Pressable>
    )
  }

  function NewGroup({ theme, onPress }: { theme: Theme; onPress: () => void }) {
    return (
      <Pressable onPress={onPress} style={[styles.newGroup, { borderColor: theme.border }]} android_ripple={{ color: theme.border }}>
        <Icon name="plus" size={18} color={theme.fgDim} />
        <Text style={[styles.newGroupText, { color: theme.fgDim }]}>New group</Text>
      </Pressable>
    )
  }

  /**
   * One of the reader's two pickers — Classic's `Dropdown`, in the look's
   * colours, type and corners: a small label, then a bordered field holding the
   * current value and a chevron.
   */
  function Picker({ theme, label, value, dot, flex, onPress, a11y }: {
    theme: Theme
    label: string
    value: string
    dot?: string
    flex: number
    onPress: () => void
    a11y: string
  }) {
    return (
      <View style={[styles.pickWrap, { flex }]}>
        <Text style={[styles.pickLabel, { color: theme.fgDim }]}>{label}</Text>
        <Pressable
          onPress={onPress}
          android_ripple={{ color: theme.border }}
          style={[styles.pickField, { borderColor: theme.border, backgroundColor: theme.surface }]}
          accessibilityRole="button"
          accessibilityLabel={a11y}
        >
          {dot ? <View style={[styles.pickDot, { backgroundColor: dot }]} /> : null}
          <Text numberOfLines={1} style={[styles.pickValue, { color: theme.fg }]}>
            {value}
          </Text>
          <Icon name="down" size={14} color={theme.fgDim} />
        </Pressable>
      </View>
    )
  }

  /*
   * The reader's top bar: back · File ▾ · Group ▾ · ⋯ — Classic's layout, so
   * the two pickers are on screen in every look. Display is in the ⋯ menu, as
   * it is in Classic.
   */
  function ReaderTop(p: ReaderTopProps) {
    const { theme } = p
    return (
      <View style={[styles.rTop, { paddingTop: p.insetTop, height: p.insetTop + 52, backgroundColor: theme.bg, borderBottomColor: theme.border }]}>
        <Pressable onPress={p.onBack} style={styles.backBtn} accessibilityLabel="Back to library">
          <Icon name="back" color={theme.fg} />
        </Pressable>
        {/* Equal widths, as in Classic's bar. */}
        <Picker theme={theme} label="File" value={cleanTitle(p.file.name)} flex={1} onPress={p.onFile} a11y="Jump to file" />
        <Picker
          theme={theme}
          label="Group"
          value={p.groupTitle}
          dot={groupTint(theme, p.groupId)}
          flex={1}
          onPress={p.onGroup}
          a11y="Switch group"
        />
        <Pressable onPress={p.onMenu} style={styles.moreBtn} accessibilityLabel="More options">
          <Icon name="more" color={theme.fg} />
        </Pressable>
      </View>
    )
  }

  function ReaderBottom({ theme, insetBottom, files, index, fileId, swipe }: ReaderBottomProps) {
    const pos = usePageNav((s) => s.byFile[fileId])
    const prev = files[index - 1]
    const next = files[index + 1]
    const tint = groupTint(theme, files[index]?.groupId ?? '')
    /*
     * The bar follows the finger: it reads the pager's live position on the UI
     * thread rather than `index`, which only changes once a swipe is committed.
     * Same source Classic's dots use, so it costs no re-renders.
     */
    const last = Math.max(1, files.length - 1)
    const single = files.length <= 1
    const fillStyle = useAnimatedStyle(() => ({
      width: `${single ? 100 : Math.min(1, Math.max(0, swipe.value / last)) * 100}%`,
    }))
    const thumbStyle = useAnimatedStyle(() => ({
      left: `${single ? 100 : Math.min(1, Math.max(0, swipe.value / last)) * 100}%`,
    }))
    return (
      <View style={[styles.rBottom, { paddingBottom: insetBottom + 10, backgroundColor: theme.bg, borderTopColor: theme.border }]}>
        <View style={styles.nextRow}>
          <View style={[styles.nextSide, styles.flex]}>
            {prev && <Icon name="back" size={14} color={theme.fgDim} />}
            <Text numberOfLines={1} style={[styles.nextText, { color: theme.fgDim }]}>
              {prev ? cleanTitle(prev.name) : ''}
            </Text>
          </View>
          <View style={[styles.nextSide, styles.flex, styles.alignEnd]}>
            <Text numberOfLines={1} style={[styles.nextText, { color: theme.fgDim }]}>
              {next ? cleanTitle(next.name) : ''}
            </Text>
            {next && <Icon name="right" size={14} color={theme.fgDim} />}
          </View>
        </View>
        <View style={styles.scrubRow}>
          <Text style={[styles.scrubNo, { color: theme.fg }]}>{index + 1}</Text>
          <View style={styles.scrub}>
            <View style={[styles.scrubTrack, { backgroundColor: theme.fgDim }]} />
            <Animated.View style={[styles.scrubFill, { backgroundColor: tint }, fillStyle]} />
            <Animated.View style={[styles.scrubThumb, { backgroundColor: tint, borderColor: theme.bg }, thumbStyle]} />
          </View>
          <Text style={[styles.scrubNo, { color: theme.fgDim }]}>{files.length}</Text>
        </View>
        <Text style={[styles.caption, { color: theme.fgDim }]}>
          {`File ${index + 1} of ${files.length}${pos ? `  ·  page ${pos.label ?? pos.current} of ${pos.total}` : ''}`}
        </Text>
      </View>
    )
  }

  return {
    fonts: F,
    corner,
    headerStyle: { paddingHorizontal: 20, marginBottom: 2 },
    BoardHeader,
    Empty: LookEmptyBoard,
    GroupHeader,
    groupTitle,
    rowStyle: { marginBottom: 14 },
    // Vertical room for the return ring, which sits 3px outside its card.
    stripStyle: { paddingHorizontal: 20, paddingVertical: 4 },
    Card: memo(CardImpl),
    AddTile,
    NewGroup,
    ReaderTop,
    ReaderBottom,
    ...SHARED_SHEETS,
  }
}
