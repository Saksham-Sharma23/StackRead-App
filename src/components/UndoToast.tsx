import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
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

/** Gap between the lowest toast and whatever is below it. */
const TOAST_GAP = 18
/** Row pitch: toast height (~45) plus the gap. */
const TOAST_PITCH = 58

function Toast({
  id,
  label,
  theme,
  index,
  bottomInset,
}: {
  id: string
  label: string
  theme: Theme
  index: number
  bottomInset: number
}) {
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
        {
          backgroundColor: theme.dark ? '#2a2a32' : '#23232b',
          /*
           * The safe-area inset is not optional here.
           *
           * The app runs edge-to-edge with both system bars transparent, so the
           * parent `absoluteFill` spans the whole window — `bottom: 18` put the
           * toast *underneath* the 3-button navigation bar, with UNDO half
           * unreachable. Every other bottom-anchored surface in the app already
           * pads by this; this was the one that did not.
           *
           * It matters more here than anywhere else because the undo window is
           * five seconds: a target that has to be fought for is a target that
           * expires.
           */
          bottom: bottomInset + TOAST_GAP + index * TOAST_PITCH,
        },
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
  // Read once here rather than per toast: the whole stack shares one inset, and
  // a hook per row would recompute it for every pending removal.
  const insets = useSafeAreaInsets()
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
          bottomInset={insets.bottom}
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
