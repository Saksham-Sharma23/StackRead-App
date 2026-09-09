import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated'

import type { Theme } from '../ui/theme'
import { usePressAnimation } from '../ui/usePressAnimation'
import { SheetShell } from './SheetShell'

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

/**
 * A bottom sheet of choices.
 *
 * The Modal, backdrop and slide all live in `SheetShell`, including the reason
 * this is a `Modal` at all rather than an in-tree sheet library — Android's back
 * button.
 */

export interface SheetAction {
  key: string
  label: string
  /**
   * Secondary text, right-aligned on the same row.
   *
   * Kept separate from `label` rather than appended to it so the label can
   * ellipsize on its own — a long filename with the size glued on the end would
   * push the size out of sight, which is precisely when it matters most.
   */
  meta?: string
  /** Rendered dimmed and unpressable. */
  disabled?: boolean
  destructive?: boolean
  onPress: () => void
}

interface Props {
  visible: boolean
  title?: string
  subtitle?: string
  actions: SheetAction[]
  theme: Theme
  onClose: () => void
}

/** One row. Split out so each can own its own press progress. */
function Item({
  action,
  theme,
  onClose,
}: {
  action: SheetAction
  theme: Theme
  onClose: () => void
}) {
  // Tint rather than scale: a full-width row that shrinks on touch looks like
  // it is detaching from the sheet.
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
      disabled={action.disabled}
      onPress={() => {
        onClose()
        // Let the sheet start dismissing before the action mutates state.
        requestAnimationFrame(action.onPress)
      }}
      {...press.pressProps}
      android_ripple={{ color: theme.surfaceAlt }}
      style={[styles.item, tint]}
    >
      <Text
        numberOfLines={1}
        style={[
          styles.itemText,
          {
            color: action.disabled
              ? theme.fgFaint
              : action.destructive
                ? theme.danger
                : theme.fg,
          },
        ]}
      >
        {action.label}
      </Text>

      {action.meta ? (
        <Text style={[styles.itemMeta, { color: theme.fgDim }]}>{action.meta}</Text>
      ) : null}
    </AnimatedPressable>
  )
}

export function ActionSheet({ visible, title, subtitle, actions, theme, onClose }: Props) {
  return (
    <SheetShell visible={visible} theme={theme} onClose={onClose}>
      {title ? (
        <View style={styles.head}>
          <Text numberOfLines={1} style={[styles.title, { color: theme.fg }]}>
            {title}
          </Text>
          {subtitle ? (
            <Text numberOfLines={1} style={[styles.subtitle, { color: theme.fgFaint }]}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      ) : null}

      <ScrollView style={styles.list} bounces={false}>
        {actions.map((a) => (
          <Item key={a.key} action={a} theme={theme} onClose={onClose} />
        ))}
      </ScrollView>
    </SheetShell>
  )
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: 20, paddingBottom: 10 },
  title: { fontSize: 16, fontWeight: '600' },
  subtitle: { fontSize: 13, marginTop: 2 },
  list: { flexGrow: 0 },
  item: {
    paddingVertical: 15,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  // `flexShrink` so a long filename ellipsizes instead of pushing the size off
  // the row; `flex: 1` so the size stays hard against the right edge.
  itemText: { fontSize: 16, flexShrink: 1, flexGrow: 1 },
  itemMeta: { fontSize: 13, fontVariant: ['tabular-nums'], flexShrink: 0 },
})
