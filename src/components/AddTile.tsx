import { Pressable, StyleSheet, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'

import { CARD, type Theme } from '../ui/theme'
import { usePressAnimation } from '../ui/usePressAnimation'

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

/** The dashed "+" tile that ends every group row. */
export function AddTile({ theme, onPress }: { theme: Theme; onPress: () => void }) {
  const press = usePressAnimation()

  return (
    <AnimatedPressable
      onPress={onPress}
      {...press.pressProps}
      android_ripple={{ color: theme.border }}
      style={[styles.tile, { borderColor: theme.border }, press.animatedStyle]}
      accessibilityLabel="Add files to this group"
    >
      <View style={styles.inner}>
        <Text style={[styles.plus, { color: theme.fgFaint }]}>+</Text>
        <Text style={[styles.label, { color: theme.fgFaint }]}>Add files</Text>
      </View>
    </AnimatedPressable>
  )
}

const styles = StyleSheet.create({
  tile: {
    width: CARD.width,
    height: CARD.height,
    borderRadius: CARD.radius,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    marginRight: CARD.gap,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inner: { alignItems: 'center', gap: 4 },
  plus: { fontSize: 28, fontWeight: '300', lineHeight: 32 },
  label: { fontSize: 12 },
})
