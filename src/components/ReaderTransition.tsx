import { useEffect, useRef } from 'react'
import { StyleSheet, useWindowDimensions } from 'react-native'
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated'

import {
  OPEN_FROM_NOWHERE,
  openFromRect,
  rectIsUsable,
  type OpenRect,
} from '../ui/openTransition'
import { Spring, Timing, useReducedMotion } from '../ui/motion'

/**
 * Grows the reader out of the card that was tapped, and folds it back on close.
 *
 * ## What this replaces
 *
 * A hard conditional swap in `App.tsx`: tap a card and the board was replaced by
 * a full-screen reader in one frame. It is the most repeated transition in the
 * app and it was the only one with no motion at all — conspicuous, because the
 * card presses with a spring on one side and `LoadingCover` fades out on the
 * other. Between them was a cut.
 *
 * ## Why the reader is not unmounted by its parent
 *
 * A closing animation needs the thing it is animating to still exist. If
 * `App.tsx` flipped `reading` to null and unmounted immediately, there would be
 * nothing left to fold back. So the parent asks this component to close, and
 * this component tells the parent when the animation is finished — the same
 * mount-decoupling `SheetShell` does, and for the same reason.
 *
 * ## Why transforms only
 *
 * Everything here is `translate`, `scale` and `opacity`. Animating the frame
 * (`width`/`top`) would be a layout write per frame on the biggest view in the
 * app. Transforms stay on the UI thread, which is the property that makes this
 * survive on a mid-range device — and this is the one animation covering the
 * full viewport, so a dropped frame is more visible here than anywhere else.
 *
 * ## Why the board is not animated in the same pass
 *
 * The obvious companion is a slight scale-down of the board underneath. It is
 * not done, deliberately: the board is unmounted while the reader is open (the
 * conditional swap stays), so there is nothing behind this to move. Adding a
 * persistent board would mean holding every card's image instance alive for the
 * duration of a reading session, which is a real memory cost for a flourish
 * nobody can see behind an opaque reader.
 */

interface Props {
  /** Where the tapped card was, or null to open from nowhere in particular. */
  from: OpenRect | null
  /** Flips to true when the parent wants the reader to fold away. */
  closing: boolean
  /** Called once the closing animation has finished and the reader can unmount. */
  onClosed: () => void
  /** Painted behind the shrinking reader. Must be the app background, not transparent. */
  backdrop: string
  children: React.ReactNode
}

export function ReaderTransition({ from, closing, onClosed, backdrop, children }: Props) {
  const { width, height } = useWindowDimensions()
  const reduced = useReducedMotion()

  /**
   * 0 = at the card, 1 = filling the screen.
   *
   * One value drives scale, translation and opacity together, so the three can
   * never disagree about how far through the transition we are. Interpolating
   * from a single progress value is also what makes the close a genuine reverse
   * rather than a second animation that happens to look similar.
   */
  const t = useSharedValue(0)

  const origin = rectIsUsable(from, width, height)
    ? openFromRect(from, width, height)
    : OPEN_FROM_NOWHERE

  useEffect(() => {
    // With "Remove animations" on, a screen-scale zoom is not a flourish, it is
    // motion sickness. Land immediately and let the close report at once.
    if (reduced) {
      t.value = 1
      return
    }
    t.value = withSpring(1, Spring.screen)
  }, [reduced, t])

  /*
   * The close callback, reached through a ref.
   *
   * The effect below must run exactly once per close — it starts an animation
   * whose completion unmounts the reader. Depending on `onClosed` directly
   * would restart that animation from wherever it had got to if the parent ever
   * handed down a new function identity mid-flight, which is the kind of thing a
   * parent re-render does for free.
   */
  const onClosedRef = useRef(onClosed)
  onClosedRef.current = onClosed

  useEffect(() => {
    if (!closing) return

    // Already on the JS thread here — `runOnJS` is for crossing *from* the UI
    // thread, and calling it here would be a pointless hop at best.
    if (reduced) {
      onClosedRef.current()
      return
    }

    /*
     * Closing is a timing, not a spring.
     *
     * The same reasoning `SheetShell` records for its exit: a spring settles at
     * a moment nobody can predict, and the unmount has to happen at a knowable
     * one. A spring would also overshoot *past* the card — frames spent
     * animating something smaller than the thing it is aiming at.
     *
     * The callback runs on the UI thread, so the hop back is real here.
     * `finished` is false when something interrupted the animation, and an
     * interrupted close must not unmount: the most likely interrupter is the
     * user reopening, and unmounting then would tear down the reader they just
     * asked for.
     */
    t.value = withTiming(0, Timing.exit, (finished) => {
      'worklet'
      if (finished) runOnJS(onClosedRef.current)()
    })
  }, [closing, reduced, t])

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(t.value, [0, 1], [origin.translateX, 0]) },
      { translateY: interpolate(t.value, [0, 1], [origin.translateY, 0]) },
      { scale: interpolate(t.value, [0, 1], [origin.scale, 1]) },
    ],
    /*
     * Opacity closes well before the geometry does.
     *
     * A card-sized reader is a recognisably wrong-looking thing — chrome laid
     * out for a full screen, crushed into 132pt. Fading it out over the first
     * third of the travel means the eye reads the *movement* and never resolves
     * the detail, which is what makes the transition feel like one object
     * rather than a screenshot being scaled.
     */
    opacity: interpolate(t.value, [0, 0.35, 1], [0, 1, 1]),
  }))

  /*
   * Opaque backdrop behind the scaling reader.
   *
   * Without this the transition showed a **navy flash** at both ends, and the
   * reason is worth keeping: the reader starts at card size, so for the length
   * of the animation it does not fill the screen — and the board is unmounted
   * by then, so what shows through is the Android *window* background. That is
   * `android:windowBackground`, which `app.json`'s `android.backgroundColor`
   * sets to `#0e1a3b`: the splash navy ([DETAIL.md §7.3](../../DETAIL.md)).
   *
   * The old hard swap never revealed it, because a full-screen opaque view
   * replaced another full-screen opaque view in one frame. The comment in
   * `App.tsx` justifying the unmount said exactly that — "the reader is opaque
   * and fills the screen" — and it stopped being true the moment the reader
   * animated in from card size.
   *
   * It fades rather than appearing, and slightly ahead of the reader, so the
   * board dims into the app background instead of being cut away.
   */
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 0.5, 1], [0, 1, 1]),
  }))

  return (
    <>
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: backdrop }, backdropStyle]}
        pointerEvents="none"
      />
      <Animated.View style={[StyleSheet.absoluteFill, style]} collapsable={false}>
        {children}
      </Animated.View>
    </>
  )
}
