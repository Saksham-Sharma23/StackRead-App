import { memo, useCallback, useEffect, useRef } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { Image } from 'expo-image'

import { useMMKVNumber } from 'react-native-mmkv'

import type { FileEntry } from '../types'
import type { OpenRect } from '../ui/openTransition'
import { badgeOf, isRenderable } from '../storage/formats'
import { storage, progressKey } from '../storage/mmkv'
import { thumbUri } from '../storage/paths'
import { CARD, type Theme } from '../ui/theme'
import { Duration, Ease, Spring, Timing } from '../ui/motion'
import { usePressAnimation } from '../ui/usePressAnimation'
import { useFileEntry } from '../store/selectors'
import { useThumbnail } from './useThumbnail'
import { useSnippet } from './useSnippet'

/**
 * One file on the board.
 *
 * Shows a real thumbnail when one has been generated, otherwise a format badge.
 * The 3-dot button is the *only* route to a cross-group move — dragging can
 * never leave the row (see `GroupRow`), so an accidental swipe can never
 * reorganize the library.
 */

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

/**
 * Stand-in for an entry that has just been removed.
 *
 * Only ever read for the single render between a removal committing and the
 * row's membership catching up — the component returns null before any of it
 * reaches the screen. It exists so the hooks above it can run unconditionally,
 * which the rules of hooks require.
 */
const MISSING: FileEntry = {
  id: '',
  name: '',
  storedName: '',
  // 'pdf' deliberately: it is the one format for which both `canSnippet` and
  // `canThumbnail` return false, so neither hook below does any work for a
  // card whose entry has just gone.
  format: 'pdf',
  groupId: '',
  orderInGroup: 0,
  addedAt: 0,
}

interface Props {
  /**
   * The file this card shows, by id.
   *
   * An id rather than the entry, so the card subscribes to its own row of the
   * store and re-renders when *that* changes rather than when any file's
   * metadata does anywhere in the library. Exactly the shape the progress bar
   * below already uses for its MMKV key, applied to the entry itself
   * ([AUDIT2 §3.1](../../AUDIT2.md)).
   */
  fileId: string
  theme: Theme
  /**
   * Opens the file. The rect is where this card was at the moment of the tap,
   * so the reader can grow out of it. Absent when the view could not be
   * measured, in which case the reader falls back to a scale-and-fade.
   */
  onOpen: (file: FileEntry, rect?: OpenRect) => void
  onMenu: (file: FileEntry) => void
  /** True while this card is being dragged, so the original can dim in place. */
  dragging?: boolean
}

function FileCardImpl({ fileId, theme, onOpen, onMenu, dragging }: Props) {
  /*
   * The entry, subscribed by id.
   *
   * Undefined is reachable for exactly one frame: a removal commits, and this
   * card re-renders before its row's membership update has propagated. Every
   * hook below still has to run — they cannot be skipped conditionally — so the
   * value is defaulted here and the component returns null at the end instead.
   */
  const entry = useFileEntry(fileId)
  const file = entry ?? MISSING

  useThumbnail(file)

  /** Opening words, for a card with no cover to show. Null for every other format. */
  const snippet = useSnippet(file)

  /*
   * Subscribed here rather than passed down as a prop.
   *
   * `GroupRow` used to read this with `getProgress(file.id)` during its own
   * render. MMKV is not reactive, so nothing re-rendered the row when progress
   * changed — the bar showed a stale value until some unrelated state change
   * happened to refresh it, which meant reading a few pages and returning to
   * the board usually showed the *old* position.
   *
   * `useMMKVNumber` is a real subscription, so each card re-renders itself and
   * only itself when its own key changes. It also removes a JSI call per card
   * per parent render, which the memo below could not prevent while the read
   * happened above it.
   *
   * The instance argument is required: this app uses a named MMKV
   * (`createMMKV({ id: 'stackread' })`), and omitting it would silently
   * subscribe to the default shared instance, which nothing ever writes.
   */
  const [stored] = useMMKVNumber(progressKey(file.id), storage)
  const progress = stored ?? 0

  /** The native view, measured on tap to seed the reader's open transition. */
  const cardRef = useRef<View>(null)

  // Spring-driven so repeated taps retarget instead of restarting. The ripple
  // stays: it is the Android affordance, and the two compose.
  const press = usePressAnimation()

  /*
   * The 3-dot button gets a deeper press than the card.
   *
   * It is 26pt across, so the card's 0.97 is invisible at that size — a scale
   * has to be proportional to the thing being scaled to register at all. This
   * is the only route to a cross-group move, so it needs to feel unmistakably
   * pressed rather than merely tapped.
   */
  const menuPress = usePressAnimation({ scale: 0.88 })

  const badge = badgeOf(file.name)
  const renderable = isRenderable(file.name)

  /*
   * The placeholder left behind while a card is dragged.
   *
   * Faded rather than hidden so the row keeps its shape, and animated rather
   * than switched because a hard opacity jump at the moment of pickup competes
   * with the lift spring — two things changing on different timelines reads as
   * a glitch, not as one gesture.
   */
  const ghost = useSharedValue(dragging ? 1 : 0)

  useEffect(() => {
    ghost.value = withTiming(dragging ? 1 : 0, Timing.standard)
  }, [dragging, ghost])

  const ghostStyle = useAnimatedStyle(() => ({ opacity: 1 - ghost.value * 0.65 }))

  /*
   * Progress fill, animated from wherever it currently sits.
   *
   * Reading a few pages and returning to the board used to snap the bar to its
   * new width. Growing into place is the one moment the board acknowledges that
   * reading happened, so it is worth the shared value.
   */
  const fill = useSharedValue(Math.min(100, progress))

  useEffect(() => {
    fill.value = withSpring(Math.min(100, progress), Spring.smooth)
  }, [progress, fill])

  const fillStyle = useAnimatedStyle(() => ({ width: `${fill.value}%` }))

  /*
   * Report where this card is, so the reader can grow out of it.
   *
   * Measured at the moment of the tap rather than tracked continuously: the
   * card moves whenever its row scrolls, and a `onLayout` subscription would
   * be a JS round trip per card per scroll frame to keep a number that is only
   * ever read once. `measureInWindow` asks the native view directly, and window
   * coordinates are what the transition needs — the card sits inside a
   * horizontal ScrollView inside a FlatList, so anything relative would have to
   * be composed back up through both.
   *
   * The callback is asynchronous, so the open is dispatched from inside it. On
   * the failure path — a view that has been detached between the press and the
   * measurement — `onOpen` is still called, just without a rect, and the reader
   * falls back to a plain scale-and-fade. Not opening the file would be a far
   * worse outcome than not animating it.
   */
  const handleOpen = useCallback(() => {
    const node = cardRef.current
    if (!node) {
      onOpen(file)
      return
    }

    node.measureInWindow((x, y, width, height) => {
      onOpen(file, { x, y, width, height })
    })
  }, [file, onOpen])

  // The one frame between a removal committing and the row's membership
  // updating. Rendering the placeholder below would flash an empty card.
  if (!entry) return null

  return (
    <Animated.View style={[styles.wrap, ghostStyle]}>
      <AnimatedPressable
        ref={cardRef}
        onPress={handleOpen}
        {...press.pressProps}
        android_ripple={{ color: theme.border }}
        style={[
          styles.card,
          { backgroundColor: theme.surface, borderColor: theme.border },
          press.animatedStyle,
        ]}
      >
        <View style={[styles.preview, { backgroundColor: theme.surfaceAlt }]}>
          {file.thumb ? (
            <Image
              source={{ uri: thumbUri(file.thumb) }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              // Lets expo-image reuse the view when the list recycles this row.
              recyclingKey={file.id}
              // Decoded natively in under a millisecond, so the card shows a
              // blurred cover on its first frame instead of an empty
              // rectangle — the real JPEG fades in over it.
              placeholder={file.thumbhash ? { thumbhash: file.thumbhash } : undefined}
              placeholderContentFit="cover"
              transition={120}
            />
          ) : file.thumbhash ? (
            /*
             * Hash but no image yet: the thumbnail file was pruned, or this is
             * the window between the index loading and generation finishing.
             * The blur alone is still a better card than a badge.
             */
            <Image
              source={undefined}
              style={StyleSheet.absoluteFill}
              placeholder={{ thumbhash: file.thumbhash }}
              placeholderContentFit="cover"
              recyclingKey={file.id}
            />
          ) : snippet ? (
            /*
             * The document's own opening words, for the formats that have no
             * cover to extract.
             *
             * A badge says what a file *is*, which the filename underneath
             * already says. It never says what the file is *about*, so a board
             * of documents was a wall of labels. Four lines of the actual text
             * make the board scannable — and they read far better at this size
             * than a downscaled render of a page would.
             *
             * Fades in rather than appearing: the read is asynchronous, so the
             * badge is on screen first and a hard swap between the two is the
             * jarring part.
             */
            <Animated.View
              entering={FadeIn.duration(Duration.medium).easing(Ease.enter)}
              style={[styles.snippet, { backgroundColor: theme.surfaceAlt }]}
            >
              <Text
                style={[styles.snippetText, { color: theme.fgDim }]}
                numberOfLines={7}
              >
                {snippet}
              </Text>
              <View style={[styles.snippetTag, { backgroundColor: badge.color }]}>
                <Text style={styles.snippetTagText}>{badge.label}</Text>
              </View>
            </Animated.View>
          ) : (
            <View style={[styles.badge, { backgroundColor: badge.color }]}>
              <Text style={styles.badgeText}>{badge.label}</Text>
            </View>
          )}

          {!renderable && (
            <View style={[styles.soonPill, { backgroundColor: theme.overlay }]}>
              <Text style={styles.soonText}>soon</Text>
            </View>
          )}
        </View>

        {/* How far into this file you are, at a glance across the board. */}
        {progress > 0 && (
          <View style={[styles.progressTrack, { backgroundColor: theme.surfaceAlt }]}>
            <Animated.View
              style={[styles.progressFill, { backgroundColor: theme.accent }, fillStyle]}
            />
          </View>
        )}

        <Text numberOfLines={2} style={[styles.name, { color: theme.fg }]}>
          {file.name}
        </Text>
      </AnimatedPressable>

      {/* Sits outside the Pressable so a menu tap never opens the file. */}
      <AnimatedPressable
        onPress={() => onMenu(file)}
        {...menuPress.pressProps}
        hitSlop={10}
        android_ripple={{ color: 'rgba(255,255,255,0.2)', borderless: true, radius: 18 }}
        style={[styles.menuBtn, { backgroundColor: theme.overlay }, menuPress.animatedStyle]}
        accessibilityLabel={`Options for ${file.name}`}
      >
        <Text style={styles.menuGlyph}>⋯</Text>
      </AnimatedPressable>
    </Animated.View>
  )
}

/**
 * Memoized on props that are now **entirely primitives and stable callbacks**.
 *
 * The comparator used to reach into the `file` prop field by field — id, name,
 * thumb, thumbhash, orderInGroup — because the entry arrived from the parent
 * and a new object identity per store update would otherwise have defeated the
 * memo completely.
 *
 * None of that is needed any more. The card subscribes to its own entry, so a
 * change to *this* file re-renders it through the store rather than through a
 * prop, and a change to any other file does not reach it at all. Both of the
 * card's two data sources now work the same way: `useFileEntry` for the entry,
 * `useMMKVNumber` for progress.
 *
 * The default shallow comparison would in fact do — this is kept explicit
 * because the callbacks must stay stable for it to mean anything, and a named
 * comparator is where that requirement is visible.
 */
export const FileCard = memo(FileCardImpl, (a, b) => {
  return (
    a.fileId === b.fileId &&
    a.dragging === b.dragging &&
    a.onOpen === b.onOpen &&
    a.onMenu === b.onMenu &&
    a.theme === b.theme
  )
})

const styles = StyleSheet.create({
  wrap: { width: CARD.width, marginRight: CARD.gap },
  card: {
    width: CARD.width,
    height: CARD.height,
    borderRadius: CARD.radius,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 8,
    overflow: 'hidden',
  },
  preview: {
    flex: 1,
    borderRadius: 9,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  /*
   * The snippet fills the preview area rather than sitting centred in it, so
   * the card reads as a page of text — starting at the top left, where a
   * document's text starts.
   */
  snippet: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, padding: 9 },
  /*
   * Small, but not as small as it could be.
   *
   * The temptation is to shrink this until more lines fit. Past about 9pt it
   * stops being readable text and becomes texture — at which point a rendered
   * thumbnail would have done the same job for far more work. Seven lines at
   * this size is a real paragraph.
   */
  snippetText: { fontSize: 9.5, lineHeight: 13 },
  /*
   * The format is still named, just quietly — a corner tag rather than the full
   * badge. The snippet says what the file is about; this says what it is,
   * without taking the space that answers the more useful question.
   */
  snippetTag: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  snippetTagText: { color: '#fff', fontSize: 8, fontWeight: '700', letterSpacing: 0.3 },
  badge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 },
  badgeText: { color: '#fff', fontWeight: '700', fontSize: 12, letterSpacing: 0.5 },
  soonPill: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
  },
  soonText: { color: '#fff', fontSize: 10, fontWeight: '600' },
  progressTrack: { height: 3, borderRadius: 2, marginTop: 7, overflow: 'hidden' },
  progressFill: { height: 3, borderRadius: 2 },
  name: { fontSize: 12, lineHeight: 15, marginTop: 5 },
  menuBtn: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuGlyph: { color: '#fff', fontSize: 15, fontWeight: '700', lineHeight: 17 },
})
