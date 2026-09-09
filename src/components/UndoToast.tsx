import { Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated'

import { usePendingRemoval } from '../store/pendingRemoval'
import type { Theme } from '../ui/theme'
import { Duration, Ease, layoutTransition } from '../ui/motion'

/**
 * Undo affordance for a file inside its 5-second removal window.
 *
 * Multiple removals can be pending at once, so these stack — each with its own
 * timer, exactly as on desktop.
 */

function Toast({ id, label, theme, index }: { id: string; label: string; theme: Theme; index: number }) {
  const undo = usePendingRemoval((s) => s.undo)

  return (
    <Animated.View
      entering={FadeInDown.duration(Duration.fast).easing(Ease.enter)}
      exiting={FadeOutDown.duration(Duration.fast).easing(Ease.exit)}
      // Toasts stack by index, so undoing the first one moves the rest. Without
      // this they would teleport into their new slots while the first fades.
      layout={layoutTransition()}
      style={[
        styles.toast,
        { backgroundColor: theme.dark ? '#2a2a32' : '#23232b', bottom: 18 + index * 58 },
      ]}
    >
      <Text numberOfLines={1} style={styles.text}>
        {label}
      </Text>
      <Pressable onPress={() => undo(id)} hitSlop={8}>
        <Text style={[styles.action, { color: theme.dark ? '#7fb0ff' : '#8fbaff' }]}>UNDO</Text>
      </Pressable>
    </Animated.View>
  )
}

export function UndoToasts({ theme }: { theme: Theme }) {
  const pending = usePendingRemoval((s) => s.pending)
  if (!pending.length) return null

  /*
   * One toast per *action*, not per file.
   *
   * Deleting a group queues every file in it, and a stack of twelve toasts is
   * not an undo affordance. Batched removals carry a shared `batchId` and their
   * label on the first item; undoing any member restores the whole batch, so
   * rendering just that first item is enough to drive it.
   */
  const toasts = pending.filter(
    (p, i) => !p.batchId || pending.findIndex((q) => q.batchId === p.batchId) === i,
  )

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {toasts.map((p, i) => (
        <Toast
          key={p.batchId ?? p.entry.id}
          id={p.entry.id}
          label={p.batchLabel ?? `Removed “${p.entry.name}”`}
          theme={theme}
          index={i}
        />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  text: { color: '#fff', flex: 1, fontSize: 14 },
  action: { fontWeight: '700', fontSize: 13, letterSpacing: 0.6 },
})
