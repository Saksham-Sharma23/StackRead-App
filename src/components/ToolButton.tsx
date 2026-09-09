import {
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native'
import Animated from 'react-native-reanimated'

import { usePressAnimation } from '../ui/usePressAnimation'

/**
 * A glyph button for the reader's top bar.
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
 */
export function ToolButton({
  glyph,
  onPress,
  accessibilityLabel,
  style,
  textStyle,
}: {
  glyph: string
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
      // Borderless so the ripple reads as a circle around the glyph rather than
      // a square box on a bar that has no other boxes.
      android_ripple={{ color: 'rgba(255,255,255,0.16)', borderless: true, radius: 22 }}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      style={[style, press.animatedStyle]}
    >
      <Text style={[styles.glyph, textStyle]}>{glyph}</Text>
    </AnimatedPressable>
  )
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

const styles = StyleSheet.create({
  glyph: { color: '#fff', fontSize: 15, fontWeight: '600' },
})
