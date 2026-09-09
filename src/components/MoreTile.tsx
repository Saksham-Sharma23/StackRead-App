import { Pressable, StyleSheet, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'

import { CARD, type Theme } from '../ui/theme'
import { usePressAnimation } from '../ui/usePressAnimation'

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

/**
 * The "+340 more" tile that ends a windowed group row.
 *
 * ## Why a row is windowed at all
 *
 * The board virtualizes its vertical axis, but each row is a plain
 * `ScrollView` — deliberately, since nesting a virtualized list inside another
 * costs more in measurement complexity and gesture conflicts than it saves. The
 * consequence is that every card in a row mounts as soon as the row scrolls
 * into view, and a card is not cheap: an `expo-image` instance, an MMKV
 * subscription and two Reanimated shared values.
 *
 * At "tens of files" — the size the row was designed for — that is fine. At
 * four hundred it is four hundred view trees built for a row the reader is
 * scrolling past. This tile is what lets the row stop early without giving up
 * the plain `ScrollView`.
 *
 * ## Why it looks like `AddTile` rather than like a card
 *
 * It is an action, not a file, and the row already has a vocabulary for that:
 * the dashed tile at the end. Making it look like a card would imply there is
 * something to open.
 */
export function MoreTile({
  count,
  theme,
  onPress,
}: {
  count: number
  theme: Theme
  onPress: () => void
}) {
  const press = usePressAnimation()

  return (
    <AnimatedPressable
      onPress={onPress}
      {...press.pressProps}
      android_ripple={{ color: theme.border }}
      style={[styles.tile, { borderColor: theme.border }, press.animatedStyle]}
      accessibilityLabel={`Show ${count} more file${count === 1 ? '' : 's'} in this group`}
    >
      <View style={styles.inner}>
        <Text style={[styles.count, { color: theme.fgDim }]} numberOfLines={1}>
          +{count}
        </Text>
        <Text style={[styles.label, { color: theme.fgFaint }]}>more</Text>
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
  inner: { alignItems: 'center', gap: 2 },
  // Tabular figures so the width does not jump between +9 and +10 as the row
  // is expanded — the tile stays under the finger that is tapping it.
  count: { fontSize: 20, fontWeight: '600', fontVariant: ['tabular-nums'] },
  label: { fontSize: 12 },
})
