import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated'

import type { TocEntry } from '../renderers/webview/pagination'
import type { Theme } from '../ui/theme'
import { usePressAnimation } from '../ui/usePressAnimation'
import { SheetShell } from './SheetShell'

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

/** One chapter row, indented by depth. */
function Entry({
  entry,
  theme,
  onPress,
}: {
  entry: TocEntry
  theme: Theme
  onPress: () => void
}) {
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
      onPress={onPress}
      {...press.pressProps}
      android_ripple={{ color: theme.surfaceAlt }}
      style={[styles.item, { paddingLeft: 20 + entry.depth * 18 }, tint]}
    >
      <Text
        numberOfLines={2}
        style={[
          styles.itemText,
          {
            color: entry.depth === 0 ? theme.fg : theme.fgDim,
            fontWeight: entry.depth === 0 ? '500' : '400',
          },
        ]}
      >
        {entry.title}
      </Text>
    </AnimatedPressable>
  )
}

/**
 * The book's chapter list.
 *
 * EPUBs carry a navigation document (EPUB 3 `nav epub:type="toc"`, EPUB 2 NCX
 * `navMap`) that the app previously ignored entirely — leaving no way to move
 * around a long book except by scrolling.
 *
 * Entries are indented by their nesting depth, so a book's section structure
 * stays legible rather than being flattened.
 */
export function TocSheet({
  visible,
  entries,
  theme,
  onSelect,
  onClose,
}: {
  visible: boolean
  entries: TocEntry[]
  theme: Theme
  onSelect: (href: string) => void
  onClose: () => void
}) {
  return (
    <SheetShell visible={visible} theme={theme} onClose={onClose}>
      <View style={styles.head}>
        <Text style={[styles.title, { color: theme.fg }]}>Chapters</Text>
        <Text style={[styles.count, { color: theme.fgFaint }]}>
          {entries.length === 0 ? 'none' : `${entries.length}`}
        </Text>
      </View>

      {entries.length === 0 ? (
        <Text style={[styles.empty, { color: theme.fgDim }]}>
          This file doesn’t include a chapter list.
        </Text>
      ) : (
        <ScrollView style={styles.list} bounces={false}>
          {entries.map((entry, i) => (
            <Entry
              key={`${entry.href}-${i}`}
              entry={entry}
              theme={theme}
              onPress={() => {
                onClose()
                // Let the sheet start dismissing before the document scrolls.
                requestAnimationFrame(() => onSelect(entry.href))
              }}
            />
          ))}
        </ScrollView>
      )}
    </SheetShell>
  )
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  title: { fontSize: 16, fontWeight: '600' },
  count: { fontSize: 13, fontVariant: ['tabular-nums'] },
  empty: { fontSize: 14, paddingHorizontal: 20, paddingVertical: 18 },
  list: { flexGrow: 0 },
  item: { paddingVertical: 13, paddingRight: 20 },
  itemText: { fontSize: 15, lineHeight: 20 },
})
