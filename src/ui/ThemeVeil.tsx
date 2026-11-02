import { useState } from 'react'
import { StyleSheet } from 'react-native'
import Animated, { withTiming } from 'react-native-reanimated'

import type { Theme } from './theme'
import { Duration, Ease } from './motion'

/**
 * A dissolve when the look or colour theme changes.
 *
 * Changing look repaints every surface in one frame — a hard cut between, say,
 * cream paper and a near-black board, which reads as a glitch rather than a
 * choice. React Native has no screenshot to cross-fade from, so this does the
 * next best thing: in the *same commit* as the new theme, it lays a sheet of
 * the *old* background colour over the screen and fades it out. The eye reads
 * the old colour giving way to the new screen.
 *
 * Same commit is the point. The veil is mounted by the render that sees the new
 * theme, with a layout animation whose first value is fully opaque, so there is
 * never a frame of the new screen without it. Doing it from an effect would
 * paint one bare frame first — the cut this exists to hide.
 *
 * Fires on any theme change: picking a look, and the phone switching between
 * light and dark. Never on first launch. With "Remove animations" on, the
 * timing resolves at once and the veil is simply never seen.
 */

const veilOut = () => {
  'worklet'
  return {
    initialValues: { opacity: 1 },
    animations: { opacity: withTiming(0, { duration: Duration.medium, easing: Ease.standard }) },
  }
}

export function ThemeVeil({ theme }: { theme: Theme }) {
  const [prev, setPrev] = useState(theme)
  const [veil, setVeil] = useState<{ key: number; color: string } | null>(null)

  // Derived state, updated during render (React's documented pattern for it):
  // the veil must exist in the same commit as the theme that triggered it.
  if (prev !== theme) {
    setPrev(theme)
    if (prev.bg !== theme.bg) setVeil((v) => ({ key: (v?.key ?? 0) + 1, color: prev.bg }))
  }

  if (!veil) return null
  return (
    <Animated.View
      // A new key per change remounts the veil, which restarts its fade.
      key={veil.key}
      entering={veilOut}
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.veil, { backgroundColor: veil.color }]}
    />
  )
}

const styles = StyleSheet.create({
  // Rests invisible once the fade ends; it never takes a touch.
  veil: { opacity: 0 },
})
