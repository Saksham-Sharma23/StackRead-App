import { useCallback, useEffect, useMemo, useState } from 'react'
import { StyleSheet, View, useWindowDimensions } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated'
import * as Haptics from 'expo-haptics'

import type { FileEntry } from '../types'
import { FileRenderer } from '../renderers/FileRenderer'
import { isWebViewFormat } from '../renderers/types'
import { Spring } from '../ui/motion'

/**
 * Horizontal paging between files **within one group**.
 *
 * This is the heart of the app, and three gestures compete for one finger:
 * vertical drag scrolls the document, horizontal drag changes file, pinch zooms.
 * The rules that keep them apart:
 *
 *  1. `activeOffsetX` / `failOffsetY` — the pager only claims a touch on clear
 *     horizontal intent, and yields the moment the finger drifts vertically.
 *  2. **Zoom-lock** — while the active renderer reports scale > 1, the pan
 *     gesture is disabled outright, so panning a zoomed page never flips files.
 *  3. **Group isolation** — the index is clamped to this group's bounds, with a
 *     rubber-band at each end. No wrap-around, no crossing into another group.
 *
 * Everything animates on the UI thread; the JS thread only sees a committed
 * index change.
 */

/** Fraction of screen width that commits a page turn. */
const COMMIT_RATIO = 0.28
/** Fling speed that commits regardless of distance. */
const COMMIT_VELOCITY = 550
/** Resistance applied past the first/last file. */
const RUBBER_BAND = 0.28

interface Props {
  files: FileEntry[]
  index: number
  onIndexChange: (index: number) => void
  /** Single tap on the content, used to toggle the reader chrome. */
  onTap?: () => void
  /** True while the scrollbar is being dragged, so paging must stand down. */
  seeking?: boolean
  /** Passed to renderers, which own their own safe-area insets. */
  fullscreen?: boolean
  /**
   * Written with the live swipe position, as a float file index.
   *
   * Exists so the page-dots marker can follow the finger instead of jumping
   * once the turn is committed. It is an *output*: this component only ever
   * writes it, and it stays on the UI thread — the JS thread still sees nothing
   * but a committed index change, which is the property the pager is built
   * around.
   *
   * Fractional and briefly out of range on purpose: the rubber-band at a
   * group's ends is included, so anything reading this can show the boundary
   * being leaned against rather than a position that stops dead.
   */
  progress?: SharedValue<number>
}

export function HorizontalPager({
  files,
  index,
  onIndexChange,
  onTap,
  seeking,
  fullscreen,
  progress,
}: Props) {
  const { width } = useWindowDimensions()

  // Mirrored into React state (not just a shared value) because `enabled()` is
  // read when the gesture is constructed, not on the UI thread each frame.
  const [isZoomed, setIsZoomed] = useState(false)

  const translateX = useSharedValue(-index * width)
  const startX = useSharedValue(0)
  /** Mirrors the active renderer's zoom so the gesture can read it on the UI thread. */
  const zoomed = useSharedValue(false)
  const count = files.length

  // Follow external index changes (file list, arrows, group switch).
  //
  // No reduced-motion branch here: `<ReducedMotionConfig>` at the app root makes
  // every spring honour the system setting, so this collapses to an instant
  // move on its own.
  useEffect(() => {
    translateX.value = withSpring(-index * width, Spring.pager)
  }, [index, width, translateX])

  const commit = useCallback(
    (next: number) => {
      if (next !== index) {
        void Haptics.selectionAsync()
        onIndexChange(next)
      }
    },
    [index, onIndexChange],
  )

  /*
   * The composed gesture, rebuilt only when something it reads changes.
   *
   * ## Why this is memoised at all
   *
   * The pager re-renders more than its own state suggests: `fullscreen` changes
   * on every chrome toggle, which is the most repeated gesture in the reader.
   * Each of those rebuilt three gesture objects and a composition for nothing.
   *
   * ## Why the dependency list is the dangerous part
   *
   * `.enabled(!isZoomed && !seeking)` is read when the gesture is
   * **constructed**, not per frame — that is the whole reason it is written as
   * `.enabled()` rather than as a check inside `onUpdate` (see the comment on
   * it below, and DETAIL.md §6.5). So a memo that omits `isZoomed` or `seeking`
   * freezes `enabled` at its first value and reintroduces the immovable-zoomed-
   * PDF bug — the exact failure this file was redesigned around.
   *
   * The callbacks capture more than that: `index` and `count` decide where a
   * swipe commits to, and `width` converts a translation into pages. A stale
   * closure over any of them pages to the wrong file rather than merely feeling
   * wrong, so every one is listed.
   *
   * `translateX`, `startX` and `zoomed` are shared values — stable object
   * identities whose `.value` is read on the UI thread — so they are
   * deliberately absent, exactly as Reanimated intends.
   *
   * **Nothing about the arbitration itself changed.** The offsets, the pointer
   * cap, `.enabled()` and `Gesture.Simultaneous` are scar tissue from real
   * device bugs and are byte-for-byte as they were.
   */
  const composed = useMemo(() => {
    const pan = Gesture.Pan()
      // Claim only a decisively horizontal drag. This threshold is deliberately
      // wider than the vertical one below: the document's own scroll is used far
      // more often than paging, so ambiguity must resolve in its favour.
      .activeOffsetX([-24, 24])
      // Give up as soon as the drag looks vertical, so scrolling always wins.
      .failOffsetY([-8, 8])
      // One finger only — a second finger means pinch-to-zoom, which belongs to
      // the renderer, not to us.
      .maxPointers(1)
      // Locked at *activation* rather than inside onUpdate.
      //
      // Checking a flag in onUpdate is too late: the gesture has already won the
      // touch, so bailing out there leaves the pager holding a drag it refuses to
      // act on — and the content underneath never receives it. That is what made a
      // zoomed page feel immovable. `enabled` stops it competing at all.
      //
      // Two conditions lock it: the document is zoomed in (so a horizontal drag
      // means panning the page), or a scrollbar seek is in flight.
      .enabled(!isZoomed && !seeking)
      .onBegin(() => {
        startX.value = translateX.value
      })
      .onUpdate((e) => {
        if (zoomed.value) return

        const raw = startX.value + e.translationX
        const min = -(count - 1) * width
        const max = 0

        // Resist past the ends instead of stopping dead — the group boundary
        // should feel like a wall you can lean on, not a crash.
        if (raw > max) translateX.value = max + (raw - max) * RUBBER_BAND
        else if (raw < min) translateX.value = min + (raw - min) * RUBBER_BAND
        else translateX.value = raw
      })
      .onEnd((e) => {
        if (zoomed.value) return

        const moved = translateX.value - startX.value
        const fast = Math.abs(e.velocityX) > COMMIT_VELOCITY
        const far = Math.abs(moved) > width * COMMIT_RATIO

        let next = index
        if (fast || far) next = moved < 0 ? index + 1 : index - 1

        // Group isolation, enforced here: never leave this group's range.
        next = Math.max(0, Math.min(count - 1, next))

        // Carrying the fling's velocity into the settle is what makes a page turn
        // feel connected to the finger rather than replayed after it.
        translateX.value = withSpring(-next * width, {
          ...Spring.pager,
          velocity: e.velocityX,
        })

        if (next !== index) runOnJS(commit)(next)
      })

    // A single tap toggles chrome. It must not swallow touches: `Gesture.Tap`
    // only fires on a clean tap, so drags and scrolls still reach the renderer.
    const tap = Gesture.Tap()
      .maxDuration(250)
      .maxDistance(10)
      .onEnd(() => {
        if (onTap) runOnJS(onTap)()
      })

    /**
     * Run the pager pan alongside whatever the renderer does natively.
     *
     * The PDF view has its own scroll and pinch; if the pager claimed touches
     * exclusively those would never fire, which is exactly what made the document
     * feel dead. The directional offsets above already keep the two apart.
     */
    return Gesture.Simultaneous(pan, tap)
    /*
     * Every value the closures above read, and nothing else.
     *
     * `isZoomed` and `seeking` are the two that must never be omitted: they
     * feed `.enabled()`, which is evaluated at construction, so dropping either
     * pins the pager enabled and a zoomed PDF becomes unpannable again.
     */
  }, [isZoomed, seeking, index, width, count, commit, onTap, translateX, startX, zoomed])

  const track = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }))

  /*
   * A page settles into place rather than stopping at it.
   *
   * The turn was confirmed in the hand — `Haptics.selectionAsync()` on commit —
   * and nowhere in the eye: the track slid and halted. A small scale-in on the
   * arriving page reads as landing.
   *
   * Derived from `translateX` rather than driven by its own value, which is the
   * same reasoning as the `progress` reaction above: the pager moves on a
   * swipe, on an external index change and on the settle spring, and only one
   * of those passes through `onEnd`. Deriving covers all three with one
   * definition, and costs no extra shared value.
   *
   * `distance` is how far this page is from the viewport centre, in pages. The
   * curve is deliberately narrow — full size by a third of a page away — so the
   * effect is a settle at the end of the turn and not a shrink that the user
   * sees during it.
   *
   * No new gesture, no new shared value: the arbitration in this file is scar
   * tissue and is deliberately untouched.
   */
  const pageSettle = useAnimatedStyle(() => {
    const position = -translateX.value / width
    const distance = Math.abs(position - Math.round(position))
    return {
      transform: [{ scale: interpolate(distance, [0, 0.33], [1, 0.98], Extrapolation.CLAMP) }],
    }
  }, [width])

  /*
   * Publish the swipe position for anything that wants to move with the finger.
   *
   * A reaction rather than work inside the gesture callbacks: the pager's
   * position also changes when `index` is set externally and when the settle
   * spring runs after a release, and neither of those passes through
   * `onUpdate`. Deriving it from `translateX` covers every way the pager can
   * move, with one definition.
   *
   * `width` is a plain value, so it is declared as a dependency — a worklet
   * re-runs on the shared values it reads, and a rotation would otherwise leave
   * this dividing by the old width.
   */
  useAnimatedReaction(
    () => -translateX.value / width,
    (value) => {
      if (progress) progress.value = value
    },
    [width, progress],
  )

  const handleScaleChange = useCallback(
    (scale: number) => {
      const next = scale > 1.02
      zoomed.value = next
      setIsZoomed((prev) => (prev === next ? prev : next))
    },
    [zoomed],
  )

  return (
    <GestureDetector gesture={composed}>
      <View style={styles.viewport}>
        <Animated.View style={[styles.track, { width: width * count }, track]}>
          {files.map((file, i) => {
            /*
             * Which files are rendered — see the note on `mounted` below.
             *
             * The rule used to be "only the active file", and the reasoning was
             * sound for both halves of it: three PDFs meant three native pdfium
             * documents plus their render threads, and unmounting one mid-render
             * crashed the app inside `FPDF_LoadPage`; three EPUBs meant parsing
             * and base64-encoding three whole books at once, which is what made
             * the app hang on an EPUB and never load it.
             *
             * **The PDF half is still true and still enforced.** The EPUB half
             * is not: preparation is gated on `active`, so an inactive WebView
             * parses nothing. Splitting the rule is what R5 does, and the note
             * on `mounted` records why each half lands where it does.
             */
            /*
             * Only the current slot and its immediate neighbours exist.
             *
             * The track is `width * count` wide, and this used to emit a slot
             * for every file in the group — real native views, unbounded in
             * number, for a UI that displays exactly one. A 200-file group
             * meant 200 of them behind a track 200 screens wide. The file
             * argues at length against holding *documents* in memory and then
             * held an arbitrary number of view slots.
             *
             * Windowing to ±1 keeps the two slots a swipe can reveal mid-gesture
             * — without them a drag would show empty space before the spring
             * settled — while making the cost constant in group size rather
             * than linear.
             */
            if (i < index - 1 || i > index + 1) return null

            /*
             * Neighbours are mounted for WebView formats, and only for those.
             *
             * ## What this buys
             *
             * Every swipe used to pay the whole WebView lifecycle — Chromium
             * view construction, the shell load, evaluating the viewer program,
             * and the boot round trip — because the incoming file mounted only
             * once the turn had committed ([AUDIT2 §2.5](../../AUDIT2.md)).
             * Mounting the neighbour moves all of that *before* the swipe, so
             * the arriving document has a live, booted viewer waiting for it.
             *
             * ## Why this is safe now and was not before
             *
             * The comment this replaces was right at the time: three EPUBs
             * mounted together parsed three whole books at once. Two changes
             * since make it false.
             *
             * `WebViewRenderer` gates preparation on `active`, so an inactive
             * neighbour constructs a view and evaluates a script and does *no*
             * parsing, no unzip and no boundary crossing. And a neighbour that
             * does have a warm cache entry now seeds every delivery ref from it
             * (R0/R4) — the trap the `seededRef` note in that file predicted
             * for "whoever re-enables neighbour mounting" is already disarmed.
             *
             * ## Why PDF and images stay single-mounted
             *
             * That constraint is real and unrelated: three live pdfium
             * documents crashed inside `FPDF_LoadPage` when one was unmounted
             * mid-render. It is a pdfium constraint, and applying it to the
             * WebView is the mistake this corrects — not the other way round.
             */
            const mounted =
              i === index || (isWebViewFormat(file.format) && Math.abs(i - index) === 1)
            return (
              /*
               * Positioned absolutely at its own offset, not laid out in flow.
               *
               * With slots omitted, a row layout would pack the survivors
               * against the left edge and the translate arithmetic — which
               * assumes slot `i` sits at `i * width` — would address the wrong
               * file. `left: i * width` restores exactly the geometry the
               * transform already expects, so the gesture arbitration and the
               * group-isolation clamp are untouched.
               *
               * `pageSettle` remains one shared style across the mounted slots.
               * The original note said that was correct "only because exactly
               * one of them has a child" — still true: the two neighbours are
               * rendered empty, and scaling an empty slot by 2% scales nothing.
               */
              <Animated.View
                key={file.id}
                style={[styles.page, { width, position: 'absolute', left: i * width }, pageSettle]}
              >
                {mounted ? (
                  <FileRenderer
                    file={file}
                    active={i === index}
                    fullscreen={fullscreen}
                    onScaleChange={i === index ? handleScaleChange : undefined}
                  />
                ) : null}
              </Animated.View>
            )
          })}
        </Animated.View>
      </View>
    </GestureDetector>
  )
}

const styles = StyleSheet.create({
  viewport: { flex: 1, overflow: 'hidden' },
  track: { flex: 1, flexDirection: 'row' },
  page: { height: '100%' },
})
