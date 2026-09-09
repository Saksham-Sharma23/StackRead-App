import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated'

import type { SearchPage } from '../storage/db'
import { badgeOf } from '../storage/formats'
import type { FileEntry } from '../types'
import type { Theme } from '../ui/theme'
import { Duration, Ease, layoutTransition } from '../ui/motion'

/**
 * Find a file by name, anywhere in the library.
 *
 * ## Why this exists
 *
 * The board was the only index. Finding a paper in a library of a few thousand
 * meant remembering which group it was in and scrolling the row — and the
 * groups are a *reading* organisation, not an alphabetical one, so there was no
 * systematic way to look something up at all.
 *
 * The index is already SQLite, so this costs one FTS5 virtual table and answers
 * from an index rather than scanning. See `storage/db.ts`.
 *
 * ## Why results are a flat list, not a board
 *
 * The board's whole meaning is the 2-D arrangement: a row is a group, and
 * horizontal position is reading order within it. Search results have neither
 * property — they are ranked by relevance and span every group — so drawing
 * them as rows would imply a structure that is not there. A list says "these
 * matched", which is what happened.
 *
 * Each row names its group, because "which group is this in" is the question a
 * search result most often raises next.
 */

interface Props {
  query: string
  results: SearchPage
  /** Rows to render. Raised a page at a time by `onShowMore`. */
  limit: number
  theme: Theme
  onQueryChange: (text: string) => void
  onShowMore: () => void
  onOpenFile: (file: FileEntry) => void
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

export function LibrarySearch({
  query,
  results,
  limit,
  theme,
  onQueryChange,
  onShowMore,
  onOpenFile,
}: Props) {
  const searching = query.trim().length > 0
  const shown = results.files.slice(0, limit)

  /*
   * Counted against the *database* total, not against the rows in hand.
   *
   * `results.files` is itself capped by the query's LIMIT, so measuring the
   * remainder against it reported "+42 more" for a library with 214 matches —
   * understating by every result past the first fifty. `total` is what the
   * MATCH actually found.
   */
  const extra = results.total - shown.length

  return (
    <View style={styles.wrap}>
      <View style={[styles.field, { backgroundColor: theme.surfaceAlt, borderColor: theme.border }]}>
        <Text style={[styles.glyph, { color: theme.fgFaint }]}>⌕</Text>
        <TextInput
          value={query}
          onChangeText={onQueryChange}
          placeholder="Search your library"
          placeholderTextColor={theme.fgFaint}
          style={[styles.input, { color: theme.fg }]}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          selectionColor={theme.accent}
        />
        {searching && (
          <Pressable onPress={() => onQueryChange('')} hitSlop={10}>
            <Text style={[styles.clear, { color: theme.fgDim }]}>✕</Text>
          </Pressable>
        )}
      </View>

      {searching && (
        <Animated.View
          entering={FadeIn.duration(Duration.fast).easing(Ease.enter)}
          exiting={FadeOut.duration(Duration.fast).easing(Ease.exit)}
          style={[styles.results, { backgroundColor: theme.surface, borderColor: theme.border }]}
        >
          {shown.length === 0 ? (
            <Text style={[styles.empty, { color: theme.fgFaint }]}>No files match</Text>
          ) : (
            shown.map((file) => {
              const badge = badgeOf(file.name)
              return (
                <AnimatedPressable
                  key={file.id}
                  /*
                   * Each row fades in and the list closes its own gaps, so
                   * refining a query reads as the results *narrowing* rather
                   * than as a new list replacing the old one.
                   *
                   * No stagger here, unlike the board's cards. A search result
                   * list is scanned in one glance and the user is mid-keystroke
                   * — anything sequential would still be arriving when the next
                   * character lands. `layout` is what does the work: rows that
                   * survive a refinement slide to their new position instead of
                   * blinking out and back.
                   */
                  entering={FadeIn.duration(Duration.fast).easing(Ease.enter)}
                  exiting={FadeOut.duration(Duration.instant).easing(Ease.exit)}
                  layout={layoutTransition()}
                  onPress={() => onOpenFile(file)}
                  android_ripple={{ color: theme.border }}
                  style={styles.row}
                >
                  {/*
                    The format badge rather than a thumbnail: a result row is
                    scanned, not browsed, and a 320px cover would make the list
                    a second board — which is exactly what it should not be.
                  */}
                  <View style={[styles.badge, { backgroundColor: badge.color }]}>
                    <Text style={styles.badgeText} numberOfLines={1}>
                      {badge.label}
                    </Text>
                  </View>
                  <Text style={[styles.name, { color: theme.fg }]} numberOfLines={1}>
                    {file.name}
                  </Text>
                </AnimatedPressable>
              )
            })
          )}

          {extra > 0 && (
            /*
              Says what is missing *and* offers to show it. Truncating silently
              and truncating visibly are different facts about the library, and
              a count with no way past it is a third: the user is told the file
              exists and given no route to it.
            */
            <Pressable onPress={onShowMore} android_ripple={{ color: theme.border }}>
              <Text style={[styles.more, { color: theme.accent }]}>
                Showing {shown.length} of {results.total} — show more
              </Text>
            </Pressable>
          )}
        </Animated.View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { marginTop: 12, gap: 8 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  glyph: { fontSize: 16 },
  input: { flex: 1, fontSize: 15, paddingVertical: 9 },
  clear: { fontSize: 14, fontWeight: '600' },
  results: { borderRadius: 10, borderWidth: 1, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  badge: { minWidth: 42, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 5, alignItems: 'center' },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  name: { flex: 1, fontSize: 14 },
  empty: { fontSize: 13, padding: 14, textAlign: 'center' },
  more: { fontSize: 12, paddingHorizontal: 12, paddingBottom: 10, paddingTop: 2 },
})
