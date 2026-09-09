import { Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated'

import { usePressAnimation } from '../ui/usePressAnimation'

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

const BORDER = ['rgba(255,255,255,0.22)', 'rgba(255,255,255,0.42)'] as const
const FILL = ['rgba(255,255,255,0.07)', 'rgba(255,255,255,0.12)'] as const

/**
 * A labelled dropdown control, matching the desktop app's reader top bar:
 * a small caption on the left, the current value in a bordered field, and a
 * chevron on the right.
 *
 * This only renders the trigger — the picker itself is an `ActionSheet`, which
 * is the right shape for touch and already owns Android back-button handling.
 *
 * ## Why it takes no `theme`
 *
 * It used to accept one and never read it, so every call site passed it
 * dutifully — coupling the component to a value it ignores and handing it a
 * re-render trigger for nothing.
 *
 * The omission is deliberate rather than an oversight to be corrected later.
 * This control lives in the reader's top bar, which is drawn over the document
 * on a translucent black scrim in *every* theme, so its colours are fixed
 * white-on-dark by design. Taking a `theme` would imply they follow the app
 * palette, which would be the wrong behaviour here — the bar must stay legible
 * over a page whose own colour the reader settings control separately.
 */
export function Dropdown({
  label,
  value,
  onPress,
  disabled,
  flex = 1,
}: {
  label: string
  value: string
  onPress: () => void
  disabled?: boolean
  flex?: number
}) {
  // Tint only, no scale: this sits in a dense top bar beside two other
  // controls, and scaling it makes the whole row appear to jitter.
  const press = usePressAnimation({ scale: 1 })

  const tint = useAnimatedStyle(() => ({
    borderColor: interpolateColor(press.progress.value, [0, 1], BORDER as unknown as string[]),
    backgroundColor: interpolateColor(press.progress.value, [0, 1], FILL as unknown as string[]),
  }))

  return (
    <View style={[styles.wrap, { flex }]}>
      <Text style={styles.label}>{label}</Text>

      <AnimatedPressable
        onPress={onPress}
        disabled={disabled}
        {...press.pressProps}
        android_ripple={{ color: 'rgba(255,255,255,0.12)' }}
        style={[styles.field, { opacity: disabled ? 0.45 : 1 }, tint]}
      >
        <Text numberOfLines={1} style={styles.value}>
          {value}
        </Text>
        <Text style={styles.chevron}>⌄</Text>
      </AnimatedPressable>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 7, minWidth: 0 },
  label: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '500' },
  field: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 34,
    paddingLeft: 11,
    paddingRight: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  value: { flex: 1, color: '#fff', fontSize: 13, fontWeight: '500' },
  // Nudged up: the glyph sits low in its line box.
  chevron: { color: 'rgba(255,255,255,0.7)', fontSize: 15, marginTop: -5 },
})
