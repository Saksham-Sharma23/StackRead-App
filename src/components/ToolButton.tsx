import {
  Pressable,
  StyleSheet,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native'
import Animated from 'react-native-reanimated'

import type { IconName } from '../looks/Icon'
import { usePressAnimation } from '../ui/usePressAnimation'
import { GlyphIcon } from './GlyphIcon'

/**
 * An icon button for the reader's top bar and search bar.
 *
 * Exists because the bar had three bare `Pressable`s — back, chapters and
 * display — with no press feedback at all, sitting beside two `Dropdown`s that
 * tint carefully on touch. That inconsistency is more noticeable than the
 * absence would be on its own: half the bar answers a touch and half ignores it.
 *
 * The scale is deeper than the cards' `Scale.press`, and deliberately so: these
 * are ~32pt targets, and a 3% scale on 32pt is roughly one pixel of movement —
 * technically present, perceptually absent. Feedback has to be proportional to
 * the control to register.
 *
 * Draws `icon` from the SVG set, with `glyph` as its text stand-in until the
 * set has loaded or on a build without it (`GlyphIcon`).
 */
export function ToolButton({
  glyph,
  icon,
  iconSize = 22,
  color = '#fff',
  onPress,
  accessibilityLabel,
  style,
  textStyle,
}: {
  glyph: string
  icon: IconName
  iconSize?: number
  color?: string
  onPress: () => void
  accessibilityLabel: string
  style?: StyleProp<ViewStyle>
  textStyle?: StyleProp<TextStyle>
}) {
  const press = usePressAnimation({ scale: 0.86 })

  return (
    <AnimatedPressable
      onPress={onPress}
      {...press.pressProps}
      hitSlop={12}
      // Borderless so the ripple reads as a circle around the icon rather than
      // a square box on a bar that has no other boxes.
      android_ripple={{ color: 'rgba(255,255,255,0.16)', borderless: true, radius: 22 }}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      style={[style, press.animatedStyle]}
    >
      <GlyphIcon
        name={icon}
        glyph={glyph}
        color={color}
        size={iconSize}
        glyphStyle={[styles.glyph, { color }, textStyle]}
      />
    </AnimatedPressable>
  )
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

const styles = StyleSheet.create({
  glyph: { fontSize: 15, fontWeight: '600' },
})
