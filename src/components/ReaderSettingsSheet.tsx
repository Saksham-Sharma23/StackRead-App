import { useEffect } from 'react'
import { SheetShell } from './SheetShell'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated'

import {
  FONT_SIZE_RANGE,
  LINE_HEIGHT_RANGE,
  MARGIN_RANGE,
  stepValue,
  useReaderSettings,
  type ReaderTheme,
} from '../store/readerSettings'
import type { Theme } from '../ui/theme'
import { Spring } from '../ui/motion'
import { usePressAnimation } from '../ui/usePressAnimation'

/**
 * Typography and theme controls, the settings a reader actually reaches for.
 *
 * Built on `Modal` rather than a draggable sheet for the same reason as
 * `ActionSheet`: `onRequestClose` handles the Android back button natively, so
 * dismissing this can never fall through and close the whole reader.
 *
 * Changes apply live — the viewer restyles through CSS custom properties
 * without re-parsing the document.
 */

const THEMES: { key: ReaderTheme; label: string; swatch: string; ink: string }[] = [
  { key: 'system', label: 'Auto', swatch: '#8e8e93', ink: '#ffffff' },
  { key: 'light', label: 'Light', swatch: '#ffffff', ink: '#14141a' },
  { key: 'sepia', label: 'Sepia', swatch: '#f4ecd8', ink: '#4a3f2f' },
  { key: 'dark', label: 'Dark', swatch: '#17171b', ink: '#e8e8ee' },
  { key: 'black', label: 'Black', swatch: '#000000', ink: '#e8e8ee' },
]

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

/**
 * One half of a stepper.
 *
 * Its own component so the press animation has somewhere to live — a hook
 * cannot be called twice from one render for two buttons. The scale is deep
 * because these are small targets tapped repeatedly: font size is adjusted by
 * feel, several taps in a row, and each one needs to register.
 */
/**
 * One theme choice.
 *
 * Selection animates rather than switching: the border colour and its width
 * both change, and snapping two properties at once is the difference between
 * "the app responded" and "the screen redrew". The swatch also lifts slightly
 * when chosen, which is what makes the selection feel like a physical pick
 * rather than a repaint.
 */
function ThemeSwatch({
  label,
  swatchColor,
  ink,
  selected,
  onPress,
  theme,
}: {
  label: string
  swatchColor: string
  ink: string
  selected: boolean
  onPress: () => void
  theme: Theme
}) {
  const press = usePressAnimation({ scale: 0.92 })

  /*
   * Shared value plus an effect, not `useDerivedValue`.
   *
   * A derived value's worklet re-runs when the *shared values it reads* change,
   * and `selected` is a plain prop — so on a swatch that stays mounted the
   * spring does not reliably re-fire. That exact mistake left two page dots
   * rendering as selected at once; it is not repeated here.
   */
  const on = useSharedValue(selected ? 1 : 0)

  useEffect(() => {
    on.value = withSpring(selected ? 1 : 0, Spring.snappy)
  }, [selected, on])

  const swatchStyle = useAnimatedStyle(() => ({
    borderWidth: 1 + on.value * 1.5,
    borderColor: interpolateColor(on.value, [0, 1], [theme.border, theme.accent]),
    transform: [{ scale: 1 + on.value * 0.06 }],
  }))

  const nameStyle = useAnimatedStyle(() => ({
    color: interpolateColor(on.value, [0, 1], [theme.fgDim, theme.accent]),
  }))

  return (
    <AnimatedPressable
      onPress={onPress}
      {...press.pressProps}
      style={[styles.themeItem, press.animatedStyle]}
      accessibilityLabel={`${label} theme`}
      accessibilityState={{ selected }}
    >
      <Animated.View style={[styles.swatch, { backgroundColor: swatchColor }, swatchStyle]}>
        <Text style={[styles.swatchText, { color: ink }]}>Aa</Text>
      </Animated.View>
      <Animated.Text style={[styles.themeName, nameStyle]}>{label}</Animated.Text>
    </AnimatedPressable>
  )
}

function StepButton({
  glyph,
  onPress,
  disabled,
  theme,
}: {
  glyph: string
  onPress: () => void
  disabled: boolean
  theme: Theme
}) {
  const press = usePressAnimation({ scale: 0.85 })

  return (
    <AnimatedPressable
      onPress={onPress}
      disabled={disabled}
      {...press.pressProps}
      hitSlop={6}
      android_ripple={{ color: theme.surfaceAlt }}
      accessibilityLabel={glyph === '+' ? 'Increase' : 'Decrease'}
      style={[styles.stepBtn, press.animatedStyle]}
    >
      <Text style={[styles.stepGlyph, { color: disabled ? theme.fgFaint : theme.fg }]}>
        {glyph}
      </Text>
    </AnimatedPressable>
  )
}

function Stepper({
  label,
  display,
  theme,
  onStep,
  atMin,
  atMax,
}: {
  label: string
  display: string
  theme: Theme
  onStep: (delta: number) => void
  atMin: boolean
  atMax: boolean
}) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: theme.fgDim }]}>{label}</Text>

      <View style={[styles.stepper, { borderColor: theme.border }]}>
        <StepButton glyph="−" onPress={() => onStep(-1)} disabled={atMin} theme={theme} />

        <Text style={[styles.stepValue, { color: theme.fg }]}>{display}</Text>

        <StepButton glyph="+" onPress={() => onStep(1)} disabled={atMax} theme={theme} />
      </View>
    </View>
  )
}

export function ReaderSettingsSheet({
  visible,
  theme,
  onClose,
}: {
  visible: boolean
  theme: Theme
  onClose: () => void
}) {

  const fontSize = useReaderSettings((s) => s.fontSize)
  const lineHeight = useReaderSettings((s) => s.lineHeight)
  const margin = useReaderSettings((s) => s.margin)
  const readerTheme = useReaderSettings((s) => s.theme)
  const set = useReaderSettings((s) => s.set)
  const reset = useReaderSettings((s) => s.reset)

  return (
    <SheetShell visible={visible} theme={theme} onClose={onClose}>
      {/* The shell owns the card and its vertical padding; this sheet's
          controls additionally need side padding. */}
      <View style={styles.body}>
        <View style={styles.head}>
          <Text style={[styles.title, { color: theme.fg }]}>Display</Text>
          <Pressable onPress={reset} hitSlop={8}>
            <Text style={[styles.reset, { color: theme.accent }]}>Reset</Text>
          </Pressable>
        </View>

        <Stepper
          label="Text size"
          display={`${fontSize}`}
          theme={theme}
          atMin={fontSize <= FONT_SIZE_RANGE.min}
          atMax={fontSize >= FONT_SIZE_RANGE.max}
          onStep={(d) => set('fontSize', stepValue(fontSize, d, FONT_SIZE_RANGE))}
        />

        <Stepper
          label="Line spacing"
          display={lineHeight.toFixed(1)}
          theme={theme}
          atMin={lineHeight <= LINE_HEIGHT_RANGE.min}
          atMax={lineHeight >= LINE_HEIGHT_RANGE.max}
          onStep={(d) => set('lineHeight', stepValue(lineHeight, d, LINE_HEIGHT_RANGE))}
        />

        <Stepper
          label="Margins"
          display={`${margin}`}
          theme={theme}
          atMin={margin <= MARGIN_RANGE.min}
          atMax={margin >= MARGIN_RANGE.max}
          onStep={(d) => set('margin', stepValue(margin, d, MARGIN_RANGE))}
        />

        <Text style={[styles.rowLabel, styles.themeLabel, { color: theme.fgDim }]}>Theme</Text>
        <View style={styles.themes}>
          {THEMES.map((t) => (
            <ThemeSwatch
              key={t.key}
              label={t.label}
              swatchColor={t.swatch}
              ink={t.ink}
              selected={readerTheme === t.key}
              onPress={() => set('theme', t.key)}
              theme={theme}
            />
          ))}
        </View>
      </View>
    </SheetShell>
  )
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingBottom: 4 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  title: { fontSize: 16, fontWeight: '600' },
  reset: { fontSize: 14, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 11,
  },
  rowLabel: { fontSize: 15 },
  themeLabel: { marginTop: 12, marginBottom: 10 },
  stepper: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 9 },
  stepBtn: { width: 46, height: 38, alignItems: 'center', justifyContent: 'center' },
  stepGlyph: { fontSize: 20, fontWeight: '500' },
  stepValue: {
    minWidth: 46,
    textAlign: 'center',
    fontSize: 15,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  themes: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  themeItem: { alignItems: 'center', gap: 6 },
  swatch: { width: 54, height: 46, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  swatchText: { fontSize: 15, fontWeight: '600' },
  themeName: { fontSize: 12, fontWeight: '500' },
})
