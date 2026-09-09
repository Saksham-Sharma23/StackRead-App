import { useCallback } from 'react'
import { StyleSheet } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  FadeInDown,
  FadeOutDown,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated'
import * as Haptics from 'expo-haptics'

import type { FileEntry } from '../types'
import type { OpenRect } from '../ui/openTransition'
import { CARD, type Theme } from '../ui/theme'
import { Duration, Ease, Scale, Spring, layoutTransition, useReducedMotion } from '../ui/motion'
import { FileCard } from './FileCard'

/**
 * A card that can be long-pressed and dragged to reorder — **within its own row
 * only**.
 *
 * Group isolation is enforced geometrically here: the drag translates on X and
 * the landing slot is clamped to `[0, count-1]` of this group. Vertical finger
 * movement is simply ignored, so a card can never be dragged into another row
 * even if the finger leaves it. Cross-group moves exist solely behind the card's
 * 3-dot menu, which makes them always deliberate.
 */

const SLOT = CARD.width + CARD.gap

interface Props {
  /** The card's file, by id — the entry is subscribed by `FileCard` itself. */
  fileId: string
  index: number
  count: number
  theme: Theme
  onOpen: (file: FileEntry, rect?: OpenRect) => void
  onMenu: (file: FileEntry) => void
  onReorder: (from: number, to: number) => void
  /** Lets the row disable its own scrolling while a drag is in flight. */
  onDragStateChange: (dragging: boolean) => void
  /** False in long rows, where per-card layout bookkeeping costs more than it shows. */
  animateLayout?: boolean
}

export function DraggableCard({
  fileId,
  index,
  count,
  theme,
  onOpen,
  onMenu,
  onReorder,
  onDragStateChange,
  animateLayout = true,
}: Props) {
  const offsetX = useSharedValue(0)
  const lifted = useSharedValue(0)

  const begin = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    onDragStateChange(true)
  }, [onDragStateChange])

  const finish = useCallback(
    (from: number, to: number) => {
      onDragStateChange(false)
      if (from !== to) {
        void Haptics.selectionAsync()
        onReorder(from, to)
      }
    },
    [onDragStateChange, onReorder],
  )

  const longPress = Gesture.LongPress()
    .minDuration(220)
    .onStart(() => {
      // The one place a visible overshoot is wanted: the small bounce is what
      // communicates "picked up".
      lifted.value = withSpring(1, Spring.playful)
      runOnJS(begin)()
    })

  const pan = Gesture.Pan()
    // Only meaningful once the long-press has lifted the card.
    .manualActivation(true)
    .onTouchesMove((_, state) => {
      if (lifted.value > 0) state.activate()
      else state.fail()
    })
    .onUpdate((e) => {
      // X only. Vertical movement is deliberately ignored so the drag cannot
      // wander toward another group.
      offsetX.value = e.translationX
    })
    .onEnd(() => {
      const slots = Math.round(offsetX.value / SLOT)
      const target = Math.max(0, Math.min(count - 1, index + slots))

      lifted.value = withSpring(0, Spring.snappy)

      if (target === index) {
        // Nothing moves in the list, so this card has to travel back itself.
        offsetX.value = withSpring(0, Spring.snappy)
      } else {
        // The reorder is about to change this card's slot, and `layout` below
        // will animate that move. Springing the offset back at the same time
        // would mean two systems animating one card's position — the result is
        // a double-animated wobble. Drop the offset instantly and let the
        // layout transition own the whole movement instead.
        offsetX.value = 0
      }

      runOnJS(finish)(index, target)
    })

  const gesture = Gesture.Simultaneous(longPress, pan)

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: offsetX.value },
      { scale: 1 + lifted.value * (Scale.lift - 1) },
    ],
    zIndex: lifted.value > 0 ? 10 : 0,
    elevation: lifted.value > 0 ? 8 : 0,
    shadowOpacity: lifted.value * 0.3,
  }))

  /*
   * A delay is not an animation, so `ReducedMotionConfig` does not remove it.
   * Left alone, "Remove animations" would turn the stagger into dead time
   * before each card simply appeared — strictly worse than no stagger.
   */
  const reduced = useReducedMotion()

  return (
    <GestureDetector gesture={gesture}>
      {/*
        Two views, deliberately.

        A layout animation drives the view's `transform` itself, so putting the
        drag offset on the same view lets the two fight — Reanimated warns that
        the property "may be overwritten by a layout animation", and in practice
        a reorder would cancel the drag mid-flight. The outer view owns entering,
        exiting and layout; the inner one owns the gesture's transform.
      */}
      <Animated.View
        /*
         * Staggered by position, so importing five files reads as five files
         * arriving rather than one block appearing.
         *
         * Capped at six cards' worth: past that the tail of a long row would
         * still be animating in after the user has started scrolling, which
         * turns a flourish into a wait. Cards beyond the cap share the last
         * delay and arrive together, which is invisible — they are offscreen.
         *
         * `LayoutAnimationConfig skipEntering` in LibraryScreen suppresses all
         * of this on first render, so a cold start with a full library does not
         * replay the whole board.
         */
        entering={FadeInDown.duration(Duration.medium)
          .easing(Ease.enter)
          .delay(reduced ? 0 : Math.min(index, 6) * 40)}
        exiting={FadeOutDown.duration(Duration.fast).easing(Ease.exit)}
        // Closes the gap when a neighbour leaves, and carries this card to its
        // new slot after a reorder (see `onEnd` above).
        layout={animateLayout ? layoutTransition() : undefined}
      >
        <Animated.View style={[styles.wrap, style]}>
          <FileCard
            fileId={fileId}
            theme={theme}
            onOpen={onOpen}
            onMenu={onMenu}
          />
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  )
}

const styles = StyleSheet.create({
  wrap: { shadowColor: '#000', shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
})
