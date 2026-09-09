import { useEffect, useRef } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated'

import type { Theme } from '../ui/theme'
import { Spring } from '../ui/motion'
import {
  DOT,
  GAP,
  PILL_W,
  WINDOW,
  edgeScale,
  slotCenters,
  windowStart,
} from './pageDotsGeometry'

/**
 * Position within the group.
 *
 * At most `WINDOW` dots are ever on screen. Beyond that the strip becomes a
 * sliding window: the dot count stays constant, dots at the edges shrink to
 * signal "more this way", and moving through the group slides the window rather
 * than adding dots. This is the iOS page-control behaviour, and it keeps a
 * 40-file group legible without collapsing to a bare `n / m` label.
 *
 * ## The active marker is one travelling body, not a state on each dot
 *
 * Earlier versions animated an `active` flag per dot: the outgoing dot shrank
 * while the incoming one grew. That is a **crossfade**, and it is why the
 * marker never looked like it went anywhere — nothing traversed the gap, two
 * things changed size in place.
 *
 * Now the dots are inert (they only ramp at the window edges) and a single
 * capsule is drawn over them, translating between slot centres. That is what
 * makes the droplet below possible at all, and it also removes the animated
 * layout width the previous version had to pay for on every frame.
 */

const INACTIVE = 'rgba(255,255,255,0.32)'
const ACTIVE = '#ffffff'

/**
 * How the droplet deforms while it travels.
 *
 * A falling drop is not a rigid shape being moved. Surface tension holds it
 * together while momentum pulls it forward, so it **elongates along its
 * direction of travel, thins across it, and rounds up again when it lands**.
 * Those three things are what the eye reads as "liquid"; a capsule that merely
 * slides reads as a switch.
 *
 * The model here is deliberately the cheap one: two points, a leading edge that
 * tracks the finger exactly and a trailing edge that lags behind it. The body
 * is simply drawn between them. When the two coincide the shape is a resting
 * capsule; while they are apart it is a stretched one — so the elongation
 * *emerges from* the movement rather than being a separate animation that could
 * fall out of sync with it.
 */

/**
 * The spring the trailing edge chases the leading edge with.
 *
 * Local rather than a token from `ui/motion`, and that is the point: this
 * spring must be **slower than whatever moves the head**, because the gap
 * between them *is* the stretch. A shared token would be tuned for how fast
 * something should arrive, and the moment someone made it snappier the droplet
 * would quietly stop deforming.
 *
 * `dampingRatio` stays near 1 deliberately. The bounce should come from the
 * shape rounding up, not from the position overshooting — an overshoot here
 * reads as the marker missing the dot and coming back, which looks like a bug
 * rather than like water.
 */
const TRAIL = { duration: 520, dampingRatio: 0.92 } as const

/**
 * How far it must stretch to thin as much as it ever will, and by how much.
 *
 * Volume is roughly conserved: as the drop stretches it has to get thinner, or
 * it reads as a growing pill rather than a stretching one. Capped, because a
 * drop that kept thinning across a fast flick would become a hairline and read
 * as a rendering artefact instead of as water.
 */
const SQUASH_SPAN = DOT * 3
const MAX_SQUASH = 0.3

/**
 * One inert dot.
 *
 * It no longer knows whether it is active — the travelling capsule covers it —
 * so the only thing it animates is the window-edge ramp.
 *
 * ## Why a shared value and an effect, not `useDerivedValue`
 *
 * `useDerivedValue(() => withSpring(edge), [edge])` looks equivalent and is not.
 * Its worklet re-runs when the *shared values it reads* change, and `edge` is a
 * plain JS prop — so on a dot that stays mounted (which is every dot, since the
 * window keys by slot) the spring did not always re-fire. Driving the shared
 * value from an effect makes the prop change the trigger, which is what is
 * actually wanted here.
 */
function Dot({ edge }: { edge: number }) {
  const e = useSharedValue(edge)

  useEffect(() => {
    e.value = withSpring(edge, Spring.snappy)
  }, [edge, e])

  const style = useAnimatedStyle(() => {
    const height = DOT * e.value
    return {
      width: height,
      height,
      // Half the height at every moment, so a shrunk dot stays a circle.
      borderRadius: height / 2,
      opacity: 0.4 + 0.6 * e.value,
      backgroundColor: INACTIVE,
    }
  })

  const slotStyle = useAnimatedStyle(() => ({ width: DOT * e.value + GAP }))

  return (
    <Animated.View style={[styles.slot, slotStyle]}>
      <Animated.View style={style} />
    </Animated.View>
  )
}

/**
 * The travelling capsule, drawn over the dots.
 *
 * `source` is a float file index. When the pager passes its live swipe position
 * the capsule tracks the finger continuously — including the rubber-band at a
 * group's ends, which makes the drop lean against the boundary and spring back.
 * Without it the capsule falls back to springing between whole indices.
 */
function Droplet({
  source,
  centers,
  start,
}: {
  source: SharedValue<number>
  centers: number[]
  start: number
}) {
  /** Leading edge: exactly where the swipe says we are. */
  const head = useDerivedValue(
    () =>
      interpolate(
        source.value - start,
        centers.map((_, i) => i),
        centers,
        Extrapolation.CLAMP,
      ),
    // `centers` and `start` are plain values, so they have to be declared: a
    // worklet re-runs on the shared values it *reads*, and neither of these is
    // one. Without this the capsule would sit at a stale offset after the
    // window slid, until the next time the swipe position happened to move.
    [centers, start],
  )

  /** Trailing edge: the same journey, arriving late. The gap is the stretch. */
  const tail = useSharedValue(0)

  useAnimatedReaction(
    () => head.value,
    (next, prev) => {
      // The first run has no previous value. Place the tail rather than
      // animating it in from zero, which would stretch the drop across the
      // whole strip on the first frame the reader is opened.
      if (prev === null) {
        tail.value = next
        return
      }
      // Retargeted every frame while the head moves. A spring carries its
      // existing velocity into a new target, so this reads as one continuous
      // chase rather than a series of restarts — and it costs nothing at rest,
      // because the reaction only fires when the head actually moves.
      tail.value = withSpring(next, TRAIL)
    },
  )

  const style = useAnimatedStyle(() => {
    const a = Math.min(head.value, tail.value)
    const b = Math.max(head.value, tail.value)
    const span = b - a

    // Thinner the further it is stretched, so the drop conserves its volume
    // instead of inflating.
    const t = Math.min(1, span / SQUASH_SPAN)
    const height = DOT * (1 - MAX_SQUASH * t)

    return {
      width: PILL_W + span,
      height,
      // Half the height at every moment, so the ends stay exactly semicircular
      // however far the body is stretched. This is the whole reason width is
      // animated rather than scaleX: scaling a capsule flattens its caps into
      // an ellipse, which is what looked cheap.
      borderRadius: height / 2,
      transform: [
        { translateX: a - PILL_W / 2 },
        // The row is `DOT` tall and the drop thins as it stretches, so re-centre
        // it — otherwise the thinning happens about the top edge and the drop
        // appears to climb as it moves.
        { translateY: (DOT - height) / 2 },
      ],
    }
  })

  return <Animated.View pointerEvents="none" style={[styles.droplet, style]} />
}

/**
 * Supplies the droplet with a position source.
 *
 * Split out only so `PageDots` can keep its `count < 2` early return above any
 * hooks — the fallback shared value and its effect cannot live behind a
 * conditional return.
 */
function DropletHost({
  index,
  progress,
  centers,
  start,
}: {
  index: number
  progress?: SharedValue<number>
  centers: number[]
  start: number
}) {
  /*
   * Used only when the caller threads no live swipe position.
   *
   * No reduced-motion branch: `<ReducedMotionConfig>` at the app root makes
   * every spring honour the system setting, so this collapses to an instant
   * move on its own — and with head and tail then always coincident, the drop
   * simply stops deforming. The effect degrades to a plain capsule rather than
   * needing to be switched off explicitly.
   */
  const fallback = useSharedValue(index)

  useEffect(() => {
    if (progress) return
    fallback.value = withSpring(index, Spring.snappy)
  }, [index, progress, fallback])

  return <Droplet source={progress ?? fallback} centers={centers} start={start} />
}

export function PageDots({
  count,
  index,
  progress,
  theme: _theme,
}: {
  count: number
  index: number
  /**
   * Live swipe position as a float file index, from the pager.
   *
   * Optional: without it the marker still animates, it just moves on committed
   * page changes instead of following the finger.
   */
  progress?: SharedValue<number>
  theme: Theme
}) {
  // One file has nowhere to swipe, so the strip would be noise.
  if (count < 2) return null

  const start = windowStart(count, index)
  const visible = Math.min(WINDOW, count)
  const moreBefore = start > 0
  const moreAfter = start + visible < count
  const centers = slotCenters(visible, moreBefore, moreAfter)

  return (
    /*
     * Two layers, and which one each thing belongs to is load-bearing.
     *
     * The **dots** live in `SlidingRow`, which absorbs the jump when the window
     * moves: each slot starts showing a different file all at once, so the row
     * is translated by exactly that distance and springs back, turning the swap
     * into a slide.
     *
     * The **marker** deliberately sits outside it. Once the window is sliding,
     * the active file keeps the *same slot* — `start` and `index` advance
     * together — so the marker should hold still while the dots stream past it,
     * which is what a sliding page control does. Inside the translated row it
     * would be carried along by the correction meant for the dots and swing a
     * slot sideways and back on every turn, which is worse than the jump the
     * correction exists to remove.
     */
    <View style={styles.wrap}>
      <SlidingRow start={start}>
        {Array.from({ length: visible }, (_, slot) => (
          /*
           * Keyed by slot, not by file index.
           *
           * The window slides by changing which file each slot shows. Keying by
           * file index would unmount and remount every dot on each page turn,
           * so the springs would restart from scratch and the strip would jump
           * instead of sliding. Keying by slot keeps twelve stable dots whose
           * props animate — which is exactly why the effect in `Dot` matters.
           */
          <Dot key={slot} edge={edgeScale(slot, visible, moreBefore, moreAfter)} />
        ))}
      </SlidingRow>

      <DropletHost index={index} progress={progress} centers={centers} start={start} />
    </View>
  )
}

/**
 * The dot row, translated so a window shift reads as a slide.
 *
 * The correction is to translate the row by exactly the distance the content
 * moved, then spring that offset back to zero. The dot and droplet animations
 * are untouched; this only cancels the discontinuity they were fighting.
 *
 * ## Why the offset is applied in an effect, not derived
 *
 * `useDerivedValue` re-runs when the shared values it *reads* change, and
 * `start` is a plain prop — so a derived version would not re-fire reliably.
 * This is the same trap documented on `Dot` above, and it produced the same
 * class of bug there.
 *
 * The offset is set without animation and then released with one, in a single
 * effect: assigning the jump and the spring separately would let a render land
 * between them and show the untranslated frame.
 */
function SlidingRow({ start, children }: { start: number; children: React.ReactNode }) {
  const shift = useSharedValue(0)
  const prevStart = useRef(start)

  useEffect(() => {
    const delta = start - prevStart.current
    prevStart.current = start
    if (delta === 0) return

    /*
     * One slot is a full-size dot plus its gap. Inactive dots are what a
     * shifting window is made of, so `DOT` is the right width even though the
     * travelling capsule is wider — its own spring covers its share.
     */
    shift.value = delta * (DOT + GAP)
    shift.value = withSpring(0, Spring.snappy)
  }, [start, shift])

  const style = useAnimatedStyle(() => ({ transform: [{ translateX: shift.value }] }))

  return <Animated.View style={[styles.row, style]}>{children}</Animated.View>
}

const styles = StyleSheet.create({
  /* Positioning context for the marker, which is drawn over the row rather
     than inside it. Sized by the row, so it needs no dimensions of its own. */
  wrap: { position: 'relative' },
  row: { flexDirection: 'row', alignItems: 'center' },
  /* Width comes from `slotStyle`; this only fixes the cross-axis and centring. */
  slot: { alignItems: 'center', justifyContent: 'center', height: DOT },
  /* Drawn over the dots. `left: 0` / `top: 0` so the transform is the only
     thing positioning it, which keeps all the geometry in one worklet. */
  droplet: { position: 'absolute', left: 0, top: 0, backgroundColor: ACTIVE },
})
