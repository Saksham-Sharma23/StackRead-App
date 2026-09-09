import { useCallback } from 'react'
import {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated'

import { Scale, Spring, useReducedMotion } from './motion'

/**
 * Spring-driven press feedback.
 *
 * A hook rather than a component, so the call site keeps its own `Pressable`
 * with all of its accessibility surface — `hitSlop`, `disabled`,
 * `accessibilityLabel`, and `android_ripple`.
 *
 * **Keep the ripple.** It is the Android platform affordance and the scale is
 * the fluidity affordance; they compose. Deleting the ripple to chase an iOS
 * feel would make the app less native on the platform it actually runs on.
 *
 * ## Why `onPressIn`/`onPressOut` and not a gesture
 *
 * This is a constraint, not a preference. `DraggableCard` already wraps
 * `FileCard` in a `GestureDetector` running `Gesture.Simultaneous(longPress,
 * pan)`. Adding a second detector inside it would create a fresh arbitration
 * surface against the long-press-to-drag — the exact class of problem that was
 * expensive to get right here. `Pressable` uses the RN responder system, which
 * those gestures already yield to correctly.
 *
 * ## Why a spring
 *
 * Both directions animate the same shared value, so tapping repeatedly
 * *retargets* with the existing velocity preserved rather than restarting from
 * a standstill. That interruptibility is the whole point.
 */

interface Options {
  /** Pressed scale. Pass 1 to disable scaling and use `progress` for tint only. */
  scale?: number
  /** Pressed opacity, for controls where a scale would be too loud. */
  opacity?: number
}

export function usePressAnimation({ scale = Scale.press, opacity = 1 }: Options = {}) {
  const reduced = useReducedMotion()

  /** 0 released .. 1 held. Also exposed for `interpolateColor` at the call site. */
  const progress = useSharedValue(0)

  const onPressIn = useCallback(() => {
    progress.value = withSpring(1, Spring.snappy)
  }, [progress])

  const onPressOut = useCallback(() => {
    progress.value = withSpring(0, Spring.snappy)
  }, [progress])

  const animatedStyle = useAnimatedStyle(() => {
    // With "Remove animations" on, a scale that snaps to 0.97 and back reads as
    // a glitch rather than as feedback — so drop the transform entirely instead
    // of letting it happen instantly.
    if (reduced) return {}
    return {
      transform: [{ scale: interpolate(progress.value, [0, 1], [1, scale]) }],
      opacity: interpolate(progress.value, [0, 1], [1, opacity]),
    }
  }, [reduced, scale, opacity])

  return { pressProps: { onPressIn, onPressOut }, animatedStyle, progress }
}
