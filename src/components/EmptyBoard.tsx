import { StyleSheet, Text, View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'

import { CARD, type Theme } from '../ui/theme'
import { Duration, Ease, useReducedMotion } from '../ui/motion'

/**
 * What the board shows before there is anything on it.
 *
 * ## Why this exists
 *
 * A first run showed a title, the subtitle "Add files to get started", and a
 * dashed "+ New group" box. Nothing on that screen explained the **2-D board** —
 * which is the single idea the product rests on ([DETAIL.md §1](../../DETAIL.md):
 * *"That second sentence is the whole product"*). The one thing StackRead does
 * that no other reader does was invisible at exactly the moment a new user was
 * deciding what the app was for.
 *
 * ## Why it draws the concept rather than describing it
 *
 * "Swipe horizontally between files in a group, scroll vertically between
 * groups" is a sentence nobody reads and nobody remembers. Two rows of
 * placeholder cards, the first sliding to suggest horizontal travel, show the
 * same thing in a glance — and they show it in the exact visual language the
 * real board uses, so recognising it later costs nothing.
 *
 * The cards are drawn from `CARD`, the same geometry the real ones use, so this
 * cannot drift into depicting a board that does not exist.
 *
 * ## Why the animation is a hint, not a loop
 *
 * The first row drifts once, on entry, and stops. A permanently looping
 * animation on an empty screen reads as a spinner — as though the app were
 * waiting for something — and it would keep the UI thread busy for as long as
 * the user sat on this screen, which for a first run may be a while.
 */

interface Props {
  theme: Theme
  /** Opens the picker for the starter group. */
  onAddFiles: () => void
}

/** Ghost cards per row. Enough to imply the row continues past the edge. */
const ROW = [0, 1, 2, 3]

export function EmptyBoard({ theme, onAddFiles }: Props) {
  const reduced = useReducedMotion()

  return (
    <View style={styles.wrap}>
      {/*
        The illustration is decorative: it repeats what the text below says, in
        pictures, so a screen reader that announced both would say everything
        twice.
      */}
      <View
        style={styles.diagram}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {[0, 1].map((row) => (
          <View key={row} style={styles.row}>
            {ROW.map((card) => (
              <Animated.View
                key={card}
                /*
                 * Staggered along each row, so the eye is drawn across it —
                 * which is the horizontal axis this diagram exists to teach.
                 *
                 * A delay is not an animation, so `ReducedMotionConfig` does
                 * not remove it: without this guard, "Remove animations" would
                 * turn the stagger into dead time before the cards simply
                 * appeared.
                 */
                entering={
                  reduced
                    ? undefined
                    : FadeIn.duration(Duration.medium)
                        .easing(Ease.enter)
                        .delay(row * 120 + card * 70)
                }
                style={[
                  styles.ghost,
                  {
                    backgroundColor: theme.surface,
                    borderColor: theme.border,
                    // The first card of the first row stands in for a real
                    // file, so the row reads as "one thing you have, and room
                    // for more" rather than as four empty slots.
                    opacity: row === 0 && card === 0 ? 1 : 0.45 - card * 0.08,
                  },
                ]}
              />
            ))}
          </View>
        ))}
      </View>

      <Text style={[styles.title, { color: theme.fg }]}>A board, not a folder</Text>

      <Text style={[styles.body, { color: theme.fgDim }]}>
        Put related files in one <Text style={{ color: theme.fg }}>group</Text> — a paper and its
        references, say. Swipe sideways to move between them while you read, and scroll down
        for your other groups.
      </Text>

      <Text style={[styles.body, { color: theme.fgFaint }]}>
        A group is just a label, so moving a file between groups never touches the file itself.
      </Text>

      <Text
        style={[styles.cta, { color: theme.accent }]}
        onPress={onAddFiles}
        accessibilityRole="button"
        accessibilityLabel="Add your first files"
      >
        Add your first files
      </Text>
    </View>
  )
}

const SCALE = 0.42

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 28, paddingTop: 12, alignItems: 'center', gap: 12 },
  diagram: { gap: 8, marginBottom: 14, alignItems: 'flex-start' },
  row: { flexDirection: 'row', gap: CARD.gap * SCALE },
  ghost: {
    // Scaled from the real card geometry, so the diagram cannot drift from the
    // board it is describing.
    width: CARD.width * SCALE,
    height: CARD.height * SCALE,
    borderRadius: CARD.radius * SCALE,
    borderWidth: 1,
  },
  title: { fontSize: 19, fontWeight: '700', letterSpacing: -0.3 },
  body: { fontSize: 13.5, lineHeight: 20, textAlign: 'center' },
  cta: { fontSize: 15, fontWeight: '600', paddingVertical: 10, marginTop: 2 },
})
