import { useCallback, useEffect, useState } from 'react'
import { Modal, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated'

import type { Theme } from '../ui/theme'
import { Spring, Timing, useReducedMotion } from '../ui/motion'

/**
 * The shared chrome behind every bottom sheet: backdrop, rounded card, grabber,
 * and the slide.
 *
 * ## Why this is still a `Modal`
 *
 * `@gorhom/bottom-sheet` would give drag-to-dismiss for free, and was evaluated
 * and rejected: it contains **no back-button handling at all** — it renders in-tree
 * through a portal rather than as a native window. `LibraryScreen` registers no
 * `BackHandler` and shows four sheets, so moving to an in-tree sheet would make
 * Android's back gesture bypass the sheet and background the app. RN's `Modal`
 * gets this right natively through `onRequestClose`, which is exactly the bug
 * the original `ActionSheet` comment was written to avoid.
 *
 * ## The part that is easy to get wrong
 *
 * `Modal` only mounts its children while `visible` is true, so driving it
 * directly from the caller's `visible` prop means the sheet slides *in* and then
 * vanishes instantly on close — arguably worse than not animating at all. So the
 * mount is decoupled: `mounted` stays true until the exit animation reports
 * completion, and `animationType="none"` keeps RN's own fade from fighting the
 * slide.
 */

interface Props {
  visible: boolean
  theme: Theme
  onClose: () => void
  children: React.ReactNode
}

export function SheetShell({ visible, theme, onClose, children }: Props) {
  const insets = useSafeAreaInsets()
  const { height: screenH } = useWindowDimensions()
  const reduced = useReducedMotion()

  /** Keeps the Modal mounted through the exit animation. */
  const [mounted, setMounted] = useState(visible)

  /**
   * 0 = offscreen, 1 = settled.
   *
   * Starts settled when the sheet is born visible, so a sheet that is already
   * open on mount does not play an entrance from an unmeasured height.
   */
  const t = useSharedValue(visible ? 1 : 0)

  /**
   * Travel distance. Measured on layout, because a sheet of three actions and a
   * sheet of thirty are very different heights and sliding by the wrong amount
   * either overshoots or leaves a gap. Falls back to the `maxHeight: 70%` cap
   * until the first measurement lands.
   */
  const height = useSharedValue(screenH * 0.7)

  const unmount = useCallback(() => setMounted(false), [])

  useEffect(() => {
    if (visible) {
      setMounted(true)
      t.value = withSpring(1, Spring.snappy)
      return
    }

    // Reduced motion: there is no exit to wait for, and an animation callback
    // is not guaranteed to arrive when the animation was skipped. Unmount now.
    if (reduced) {
      t.value = 0
      setMounted(false)
      return
    }

    // Exit is a timing, not a spring, deliberately: a spring would overshoot
    // past the screen edge (wasted frames) and settles at a time we cannot
    // predict, but the unmount has to happen at a knowable moment.
    //
    // `finished` is false when a reopen interrupts this — in that case the
    // branch above has already re-run and remounted, so unmounting here would
    // close a sheet the user just opened.
    t.value = withTiming(0, Timing.exit, (finished) => {
      if (finished) runOnJS(unmount)()
    })
    // Deliberately not depending on `mounted`: it changes as a *result* of this
    // effect, and re-running on that would restart the exit on a closed sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reduced, t, unmount])

  const backdrop = useAnimatedStyle(() => ({ opacity: t.value }))

  const sheet = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - t.value) * height.value }],
  }))

  if (!mounted) return null

  return (
    <Modal
      visible={mounted}
      transparent
      // Must be "none": RN's own transition would run against the slide below.
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.root}>
        <Animated.View style={[StyleSheet.absoluteFill, backdrop]}>
          <Pressable
            style={[StyleSheet.absoluteFill, { backgroundColor: theme.overlay }]}
            onPress={onClose}
            accessibilityLabel="Dismiss"
          />
        </Animated.View>

        <Animated.View
          onLayout={(e) => {
            // Include the bottom inset: the sheet must clear the gesture area
            // entirely, or a sliver stays visible at rest.
            height.value = e.nativeEvent.layout.height + insets.bottom
          }}
          style={[
            styles.sheet,
            { backgroundColor: theme.surface, paddingBottom: insets.bottom + 10 },
            // With "Remove animations" on the slide is disabled anyway, and
            // animating a measured translate adds nothing but risk.
            reduced ? undefined : sheet,
          ]}
        >
          <View style={[styles.grabber, { backgroundColor: theme.border }]} />
          {children}
        </Animated.View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 8,
    maxHeight: '70%',
  },
  grabber: {
    width: 38,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 10,
  },
})
