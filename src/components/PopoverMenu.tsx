import { useCallback, useEffect, useState } from 'react'
import { Modal, Pressable, StyleSheet, Text } from 'react-native'
import Animated, {
  interpolateColor,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated'

import type { Theme } from '../ui/theme'
import { Spring, Timing, useReducedMotion } from '../ui/motion'
import { usePressAnimation } from '../ui/usePressAnimation'

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

/**
 * A small card of choices that drops from the control that opened it.
 *
 * The overflow-menu shape, as opposed to `ActionSheet`'s bottom sheet. Both
 * exist on purpose: a sheet is right when the list is long or the choice is the
 * task (switching file, switching group), and a popover is right when the list
 * is short and secondary — the three tools the reader's top bar used to spend
 * three buttons on.
 *
 * ## Why this is a `Modal`
 *
 * The same reason `SheetShell` is one, and it is worth restating because a
 * popover looks like something that could be rendered in-tree. It cannot:
 * `@gorhom/bottom-sheet` was evaluated and rejected here for having **no
 * back-button handling**, since an in-tree portal is not a native window and
 * Android's back gesture flows straight past it. `Modal` gets it right through
 * `onRequestClose`. An in-tree popover would reintroduce exactly that bug.
 *
 * ## The part that is easy to get wrong
 *
 * `Modal` only mounts its children while `visible` is true, so driving it from
 * the caller's prop directly would play the entrance and then vanish instantly
 * on close. The mount is decoupled: `mounted` stays true until the exit
 * animation reports completion, and `animationType="none"` keeps RN's own fade
 * from fighting the scale.
 */

export interface MenuItem {
  key: string
  /** A single glyph, aligned in its own column so the labels line up. */
  glyph: string
  label: string
  onPress: () => void
}

interface Props {
  visible: boolean
  items: MenuItem[]
  theme: Theme
  /** Distance from the top of the window to the card's top edge. */
  top: number
  /** Distance from the right of the window, so the card lines up under its button. */
  right: number
  onClose: () => void
}

/** One row. Split out so each owns its own press progress. */
function Item({ item, theme, onClose }: { item: MenuItem; theme: Theme; onClose: () => void }) {
  // Tint rather than scale, matching `ActionSheet`: a full-width row that
  // shrinks on touch looks like it is detaching from the card it sits in.
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
      onPress={() => {
        /*
         * Close first, act on the next frame.
         *
         * Every item here opens either a sheet or the search bar, and both are
         * `Modal`s. Dismissing one Android Modal and presenting another in the
         * same frame flickers, so this hands the close a frame to start on —
         * the same ordering `ActionSheet`'s rows use, for the same reason.
         */
        onClose()
        requestAnimationFrame(item.onPress)
      }}
      {...press.pressProps}
      android_ripple={{ color: theme.surfaceAlt }}
      accessibilityRole="menuitem"
      style={[styles.item, tint]}
    >
      <Text style={[styles.glyph, { color: theme.fgDim }]}>{item.glyph}</Text>
      <Text numberOfLines={1} style={[styles.label, { color: theme.fg }]}>
        {item.label}
      </Text>
    </AnimatedPressable>
  )
}

export function PopoverMenu({ visible, items, theme, top, right, onClose }: Props) {
  const reduced = useReducedMotion()

  /** Keeps the Modal mounted through the exit animation. */
  const [mounted, setMounted] = useState(visible)
  const t = useSharedValue(visible ? 1 : 0)

  const unmount = useCallback(() => setMounted(false), [])

  useEffect(() => {
    if (visible) {
      setMounted(true)
      t.value = withSpring(1, Spring.snappy)
      return
    }

    // Reduced motion: no exit to wait for, and an animation callback is not
    // guaranteed to arrive when the animation was skipped.
    if (reduced) {
      t.value = 0
      setMounted(false)
      return
    }

    // A timing, not a spring: the unmount has to happen at a knowable moment.
    // `finished` is false when a reopen interrupts, in which case the branch
    // above has already remounted and unmounting here would close it again.
    t.value = withTiming(0, Timing.exit, (finished) => {
      if (finished) runOnJS(unmount)()
    })
    // Deliberately not depending on `mounted`: it changes as a *result* of this
    // effect, and re-running on that would restart the exit on a closed menu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reduced, t, unmount])

  /*
   * Grows out of its own top-right corner, which is where the button is.
   *
   * `transformOrigin` is what makes this read as *dropping from* the control
   * rather than as a card inflating in place; without it a scale expands about
   * the centre and the connection to the button is lost. The small downward
   * travel on top of it is what sells the drop.
   */
  const card = useAnimatedStyle(() => ({
    opacity: t.value,
    transform: [{ scale: 0.92 + 0.08 * t.value }, { translateY: (1 - t.value) * -8 }],
  }))

  if (!mounted) return null

  return (
    <Modal
      visible={mounted}
      transparent
      // Must be "none": RN's own transition would run against the scale above.
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/*
        No dim behind the card, deliberately. A popover is a lightweight,
        cancel-by-looking-away control, and darkening the document behind it
        would give it the weight of a sheet — which is the weight this exists to
        avoid. The backdrop is invisible and exists only to catch the tap.
      */}
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Dismiss" />

      <Animated.View
        accessibilityViewIsModal
        accessibilityRole="menu"
        style={[
          styles.card,
          {
            top,
            right,
            backgroundColor: theme.surface,
            borderColor: theme.border,
          },
          reduced ? undefined : card,
        ]}
      >
        {items.map((item) => (
          <Item key={item.key} item={item} theme={theme} onClose={onClose} />
        ))}
      </Animated.View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    minWidth: 208,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 6,
    overflow: 'hidden',
    // The card floats over a document; without a shadow its edge is the only
    // thing separating it from the page, and on a dark page that is not enough.
    elevation: 8,
    transformOrigin: 'top right',
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 13,
    paddingHorizontal: 16,
  },
  /* A fixed-width column so the labels align even though the glyphs do not
     share a width — "Aa" is far wider than the magnifier. */
  glyph: { width: 20, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  label: { fontSize: 15, flexShrink: 1 },
})
