import { useCallback, useEffect } from 'react'
import { StyleSheet, useWindowDimensions } from 'react-native'
import { Image } from 'expo-image'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated'

import { fileUri } from '../storage/paths'
import { Spring } from '../ui/motion'
import { getZoom, setZoom } from '../store/scroll'
import type { RendererProps } from './types'

const MAX_SCALE = 5
const MIN_SCALE = 1

/**
 * Images: pinch to zoom, drag to pan while zoomed, double-tap to toggle.
 *
 * Zoom state is reported upward so the pager can lock horizontal paging — while
 * zoomed in, a horizontal drag must pan the image, not change file.
 */
export function ImageRenderer({ file, active, onScaleChange }: RendererProps) {
  const { width, height } = useWindowDimensions()

  const scale = useSharedValue(1)
  const savedScale = useSharedValue(1)
  const tx = useSharedValue(0)
  const ty = useSharedValue(0)
  const savedTx = useSharedValue(0)
  const savedTy = useSharedValue(0)

  // Restore the remembered zoom for this file.
  useEffect(() => {
    const remembered = getZoom(file.id)
    scale.value = remembered
    savedScale.value = remembered
    onScaleChange?.(remembered)
  }, [file.id, scale, savedScale, onScaleChange])

  const persistScale = useCallback(
    (s: number) => {
      setZoom(file.id, s)
      onScaleChange?.(s)
    },
    [file.id, onScaleChange],
  )

  /** Keeps the image from being dragged entirely off screen. */
  const clampPan = useCallback(
    (s: number) => {
      'worklet'
      const maxX = Math.max(0, (width * s - width) / 2)
      const maxY = Math.max(0, (height * s - height) / 2)
      tx.value = Math.min(maxX, Math.max(-maxX, tx.value))
      ty.value = Math.min(maxY, Math.max(-maxY, ty.value))
    },
    [width, height, tx, ty],
  )

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.min(MAX_SCALE, Math.max(MIN_SCALE, savedScale.value * e.scale))
    })
    .onEnd(() => {
      savedScale.value = scale.value
      clampPan(scale.value)
      runOnJS(persistScale)(scale.value)
    })

  /**
   * Pan is only allowed while zoomed in. At scale 1 this gesture never
   * activates, which leaves the horizontal drag free for the pager.
   */
  const pan = Gesture.Pan()
    .averageTouches(true)
    .onBegin(() => {
      savedTx.value = tx.value
      savedTy.value = ty.value
    })
    .onUpdate((e) => {
      if (scale.value <= 1) return
      // Clamp live rather than only on release, so the image cannot be dragged
      // into empty space and then snap back.
      const s = scale.value
      const maxX = Math.max(0, (width * s - width) / 2)
      const maxY = Math.max(0, (height * s - height) / 2)
      tx.value = Math.min(maxX, Math.max(-maxX, savedTx.value + e.translationX))
      ty.value = Math.min(maxY, Math.max(-maxY, savedTy.value + e.translationY))
    })
    .onEnd(() => {
      clampPan(scale.value)
    })

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const next = scale.value > 1.05 ? 1 : 2.5
      // Springs, because double-tap-to-zoom is a spring everywhere it feels
      // right (iOS Photos included). Critically damped rather than the usual
      // 0.85 default: overshooting past scale 1 on a zoom-out would expose
      // background beyond the image edge, so here the damping is correctness
      // rather than taste.
      scale.value = withSpring(next, Spring.smooth)
      savedScale.value = next
      if (next === 1) {
        tx.value = withSpring(0, Spring.smooth)
        ty.value = withSpring(0, Spring.smooth)
      }
      runOnJS(persistScale)(next)
    })

  // Pinch and pan run together; the double-tap only wins if no drag started.
  const gesture = Gesture.Simultaneous(pinch, Gesture.Exclusive(doubleTap, pan))

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }))

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={styles.fill}>
        <Animated.View style={[styles.fill, style]}>
          <Image
            source={{ uri: fileUri(file.storedName) }}
            style={styles.fill}
            contentFit="contain"
            recyclingKey={file.id}
            // Only the active file is mounted (see HorizontalPager); this still
            // matters during the brief overlap while a swipe hands over.
            priority={active ? 'high' : 'low'}
            transition={120}
          />
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, width: '100%', height: '100%' },
})
