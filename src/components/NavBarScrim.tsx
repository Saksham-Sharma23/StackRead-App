import { StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import type { Theme } from '../ui/theme'

/**
 * The frosted strip behind the Android navigation bar.
 *
 * The app runs edge-to-edge — `edgeToEdgeEnabled=true`, both system bars
 * transparent — so the board scrolls underneath the navigation bar. Left alone
 * that means file cards and text pass behind the bar's own glyphs and become
 * unreadable exactly where the eye expects a boundary.
 *
 * ## Why a stack of alphas rather than a real blur
 *
 * `expo-blur` would be the obvious answer and is deliberately not used. It is a
 * native module, so it costs a `prebuild` and a full rebuild; and on Android
 * under SDK 57 a real blur additionally requires wrapping the content to be
 * blurred in a `BlurTargetView` and handing its ref to the `BlurView`, which
 * means a per-frame render capture over a scrolling list. Against a near-black
 * board the visible difference is very small, and the cost is not.
 *
 * A gradient would be the next answer, and `expo-linear-gradient` is also not a
 * dependency. Four absolutely-positioned bands of increasing alpha give the same
 * read at the size this is drawn — a strip roughly 48dp tall — for the price of
 * four views that never re-render.
 *
 * ## Why it is not in the reader
 *
 * The reader's own bottom bar already spans full width and pads by
 * `insets.bottom`, and in immersive mode the navigation bar is hidden outright.
 * A scrim there would contradict the one rule the reader has: tap, and the
 * document owns the screen.
 */
export function NavBarScrim({ theme }: { theme: Theme }) {
  const insets = useSafeAreaInsets()

  /*
   * Nothing to draw when the system reports no inset.
   *
   * Gesture navigation on some devices, and immersive mode everywhere, collapse
   * this to zero — and a zero-height strip is still a view the compositor walks.
   * Returning null keeps the hierarchy honest about whether the strip exists.
   */
  if (insets.bottom <= 0) return null

  return (
    <View
      pointerEvents="none"
      style={[styles.root, { height: insets.bottom }]}
      // Decorative: it must never be announced, and it must never take a touch.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={[styles.edge, { backgroundColor: theme.navScrimEdge }]} />
      {theme.navScrim.map((color, i) => (
        // Equal-height bands, keyed by position because the ramp is fixed at
        // four stops and never reorders.
        <View key={i} style={[styles.band, { backgroundColor: color }]} />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  edge: { height: StyleSheet.hairlineWidth },
  /* `flex: 1` so the four bands divide whatever the inset turns out to be —
     it differs between 3-button and gesture navigation, and between
     orientations, so no band can carry a fixed height. */
  band: { flex: 1 },
})
