import { useCallback, useEffect, useRef } from 'react'
import { StyleSheet, Text, TextInput } from 'react-native'
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated'

import { useSearch } from '../store/search'
import type { Theme } from '../ui/theme'
import { Duration, Ease } from '../ui/motion'
import { ToolButton } from './ToolButton'

/**
 * Find-in-document bar, shown under the reader's top bar.
 *
 * ## Why the query is submitted on change rather than on a button
 *
 * A reader searching a book is looking for a word they already know is there,
 * and the useful feedback is the match count moving as they type. Waiting for a
 * submit turns two keystrokes of confirmation into a round trip.
 *
 * The cost is a full document walk per keystroke, which is why the input is
 * debounced below rather than posting on every character. 180ms is short enough
 * to feel live and long enough that typing a six-letter word is one search
 * rather than six.
 *
 * ## Why the count lives here and not in the top bar
 *
 * It belongs next to the thing it describes. The top bar already carries the
 * file and group pickers and the page stepper; adding a third number there
 * would make a row of unrelated digits.
 */

interface Props {
  fileId: string
  theme: Theme
  /** Sits below the top bar, which owns the safe-area inset. */
  topOffset: number
  /** Disabled formats (PDF, for now) show why rather than a dead input. */
  unsupportedReason?: string
}

/** Debounce for the live search. See the note above about typing. */
const TYPING_MS = 180

export function SearchBar({ fileId, theme, topOffset, unsupportedReason }: Props) {
  const query = useSearch((s) => s.query)
  const setQuery = useSearch((s) => s.setQuery)
  const submit = useSearch((s) => s.submit)
  const stepMatch = useSearch((s) => s.stepMatch)
  const close = useSearch((s) => s.close)
  const status = useSearch((s) => s.byFile[fileId])

  const inputRef = useRef<TextInput>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Focused on mount so the keyboard is up and the reader can type
  // immediately — opening a search bar and then having to tap it is a wasted
  // step, and this bar only ever mounts because someone asked for it.
  useEffect(() => {
    const handle = setTimeout(() => inputRef.current?.focus(), 60)
    return () => clearTimeout(handle)
  }, [])

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const handleChange = useCallback(
    (text: string) => {
      setQuery(text)
      if (unsupportedReason) return

      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => submit(fileId, text), TYPING_MS)
    },
    [fileId, setQuery, submit, unsupportedReason],
  )

  // Enter runs the search immediately rather than waiting out the debounce, and
  // on a document already searched it advances — which is what Enter does in
  // every find bar the reader has used.
  const handleSubmit = useCallback(() => {
    if (unsupportedReason) return
    if (timer.current) clearTimeout(timer.current)

    if (status && status.query === query && status.total > 0) stepMatch(fileId, 1)
    else submit(fileId, query)
  }, [fileId, query, status, stepMatch, submit, unsupportedReason])

  const total = status?.total ?? 0
  const current = status?.current ?? 0
  const searched = Boolean(status && status.query === query && query.length > 0)

  const countLabel = unsupportedReason
    ? ''
    : !searched
      ? ''
      : total === 0
        ? 'none'
        : `${current}/${total}${status?.truncated ? '+' : ''}`

  return (
    <Animated.View
      entering={FadeInUp.duration(Duration.fast).easing(Ease.enter)}
      exiting={FadeOutUp.duration(Duration.fast).easing(Ease.exit)}
      style={[styles.bar, { top: topOffset, backgroundColor: 'rgba(0,0,0,0.9)' }]}
    >
      <TextInput
        ref={inputRef}
        value={query}
        onChangeText={handleChange}
        onSubmitEditing={handleSubmit}
        placeholder={unsupportedReason ?? 'Find in document'}
        placeholderTextColor="rgba(255,255,255,0.45)"
        editable={!unsupportedReason}
        style={[styles.input, unsupportedReason ? styles.inputDisabled : null]}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        // Keeps the keyboard up while stepping through matches; dismissing it
        // on every jump would hide half the document the reader is scanning.
        blurOnSubmit={false}
        selectionColor={theme.accent}
      />

      {/*
        The count holds a fixed width so stepping from 9/40 to 10/40 does not
        shift the buttons beside it — a control that moves under the finger
        while being tapped repeatedly is the one thing this bar must not do.
      */}
      <Text style={styles.count} numberOfLines={1}>
        {countLabel}
      </Text>

      <ToolButton
        glyph="‹"
        onPress={() => stepMatch(fileId, -1)}
        accessibilityLabel="Previous match"
        style={styles.stepBtn}
        textStyle={[styles.stepGlyph, total === 0 ? styles.stepDisabled : null]}
      />
      <ToolButton
        glyph="›"
        onPress={() => stepMatch(fileId, 1)}
        accessibilityLabel="Next match"
        style={styles.stepBtn}
        textStyle={[styles.stepGlyph, total === 0 ? styles.stepDisabled : null]}
      />
      <ToolButton
        glyph="✕"
        onPress={() => close(fileId)}
        accessibilityLabel="Close search"
        style={styles.stepBtn}
        textStyle={styles.closeGlyph}
      />
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  input: {
    flex: 1,
    color: '#fff',
    fontSize: 15,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  inputDisabled: { color: 'rgba(255,255,255,0.5)' },
  count: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    minWidth: 52,
    textAlign: 'right',
  },
  stepBtn: { width: 30, height: 34, alignItems: 'center', justifyContent: 'center' },
  stepGlyph: { color: '#fff', fontSize: 24, lineHeight: 26 },
  stepDisabled: { color: 'rgba(255,255,255,0.3)' },
  closeGlyph: { color: '#fff', fontSize: 16, fontWeight: '600' },
})
