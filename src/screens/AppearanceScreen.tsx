import { memo } from 'react'
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
  useColorScheme,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, { FadeIn } from 'react-native-reanimated'
import * as Haptics from 'expo-haptics'

import { useAppearance } from '../store/appearance'
import { useIsPro, useProStore, PAYWALL_ENABLED } from '../store/pro'
import { CLASSIC_THEMES, useTheme, type Theme } from '../ui/theme'
import { Duration, Ease } from '../ui/motion'
import { usePressAnimation } from '../ui/usePressAnimation'
import { loadIconsNow } from '../ui/icons'
import { GlyphIcon } from '../components/GlyphIcon'
import { LOOK_CHOICES, chooseLook, skinFor, useLookFonts } from '../looks/registry'
import { isLookLocked, paletteTheme, previewTheme, type Look, type LookTheme, type ReadingFont } from '../looks/appearance'
import { PALETTES, THEME_NAMES, type ThemeName } from '../looks/palettes'
import { READING_FONT_CHOICES } from '../looks/readingFonts'
import { face, type LookFonts } from '../looks/skin'

/**
 * Appearance — the look, its colours and the reading font, in one place
 * (TASKS3 L2).
 *
 * Replaces the plain list of look names that "Look…" opened. Each look is a
 * tile drawing a miniature board in that look's own type, corners and colours,
 * so the choice is made by seeing it rather than by reading a name — and the
 * whole screen re-themes the moment a tile is tapped. Below the tiles:
 *
 *  - **Colours** — follow the phone between a light and a dark theme, or pin
 *    one; every one of the eight app themes is offered as a swatch.
 *  - **Reading font** — the five reading faces, each named in its own type.
 *
 * Both apply only to the optional looks: Classic keeps its own light/dark
 * colours and the reader's own font, and the screen says so instead of
 * offering controls that would do nothing.
 *
 * ## Pro
 *
 * The paywall is off (`PAYWALL_ENABLED`), so nothing is locked today. When it
 * is on, a look without Pro shows a lock, and tapping it explains instead of
 * applying — with an "Unlock (dev)" escape in development builds. The stored
 * choice is never what decides this; `resolveAppearance` is (looks/appearance).
 *
 * A full-screen `Modal`, like the sheets, for Android's back button
 * (`onRequestClose`). Loaded on first open, not at startup: it pulls in every
 * look's module and react-native-svg.
 */

loadIconsNow()

/** The words each reading font is shown with. */
const FONT_SAMPLE = 'The quick brown fox jumps over the lazy dog.'

export function AppearanceScreen({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useTheme()
  const fonts = useLookFonts()
  const insets = useSafeAreaInsets()
  const systemDark = useColorScheme() === 'dark'

  const stored = useAppearance()
  const set = useAppearance((s) => s.set)
  const isPro = useIsPro()
  const devPro = useProStore((s) => s.devPro)
  const setDevPro = useProStore((s) => s.setDevPro)

  const pick = (look: Look) => {
    if (isLookLocked(look, isPro)) {
      Alert.alert(
        'Part of StackRead Pro',
        'The looks are coming with StackRead Pro, which isn’t available yet. Classic is always free.',
        [
          { text: 'OK', style: 'cancel' },
          ...(__DEV__
            ? [{ text: 'Unlock (dev)', onPress: () => { setDevPro(true); chooseLook(look) } }]
            : []),
        ],
      )
      return
    }
    if (look === stored.look) return
    void Haptics.selectionAsync()
    chooseLook(look)
  }

  const pickTheme = (key: 'theme' | 'lightTheme' | 'darkTheme', name: ThemeName) => {
    void Haptics.selectionAsync()
    set(key, name)
    if (key === 'theme') set('followSystem', false)
  }

  const pickFont = (font: ReadingFont) => {
    if (font === stored.readingFont) return
    void Haptics.selectionAsync()
    set('readingFont', font)
  }

  const classic = stored.look === 'classic'

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={[styles.root, { backgroundColor: theme.bg, paddingTop: insets.top }]}>
        <View style={styles.bar}>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={styles.back}
          >
            <GlyphIcon name="back" glyph="‹" color={theme.fg} size={26} />
          </Pressable>
          <Text style={[styles.barTitle, { color: theme.fg }, fonts?.title]}>Appearance</Text>
        </View>

        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
          {/* ---------------------------------------------------------- looks */}
          <SectionTitle theme={theme} fonts={fonts} title="Look" detail="Restyles the board and the reader" />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tiles}>
            {LOOK_CHOICES.map((choice) => (
              <LookTile
                key={choice.look}
                look={choice.look}
                label={choice.label}
                themeName={previewTheme(choice.look, stored, systemDark, choice)}
                systemDark={systemDark}
                selected={choice.look === stored.look}
                locked={isLookLocked(choice.look, isPro)}
                theme={theme}
                onPress={() => pick(choice.look)}
              />
            ))}
          </ScrollView>

          {/* -------------------------------------------------------- colours */}
          <SectionTitle theme={theme} fonts={fonts} title="Colours" />
          {classic ? (
            <Note theme={theme} fonts={fonts}>
              Classic follows your phone’s light and dark setting. Pick another look to choose its colours.
            </Note>
          ) : (
            <Animated.View entering={FadeIn.duration(Duration.medium).easing(Ease.enter)}>
              <View style={[styles.toggleRow, { borderColor: theme.border }]}>
                <View style={styles.toggleText}>
                  <Text style={[styles.rowLabel, { color: theme.fg }, fonts?.body]}>Match phone light / dark</Text>
                  <Text style={[styles.rowDetail, { color: theme.fgFaint }, fonts?.meta]}>
                    Switches between two themes with your phone
                  </Text>
                </View>
                <Switch
                  value={stored.followSystem}
                  onValueChange={(on) => set('followSystem', on)}
                  trackColor={{ true: theme.accent, false: theme.border }}
                  thumbColor="#ffffff"
                />
              </View>

              {stored.followSystem ? (
                <>
                  <SwatchRow
                    label="Light"
                    current={stored.lightTheme}
                    active={!systemDark}
                    theme={theme}
                    fonts={fonts}
                    onPick={(n) => pickTheme('lightTheme', n)}
                  />
                  <SwatchRow
                    label="Dark"
                    current={stored.darkTheme}
                    active={systemDark}
                    theme={theme}
                    fonts={fonts}
                    onPick={(n) => pickTheme('darkTheme', n)}
                  />
                </>
              ) : (
                <SwatchRow
                  label="Theme"
                  current={stored.theme}
                  active
                  theme={theme}
                  fonts={fonts}
                  onPick={(n) => pickTheme('theme', n)}
                />
              )}
            </Animated.View>
          )}

          {/* --------------------------------------------------- reading font */}
          <SectionTitle theme={theme} fonts={fonts} title="Reading font" detail="For books and documents" />
          {classic ? (
            <Note theme={theme} fonts={fonts}>
              Classic reads in each book’s own typeface. Pick another look to choose a reading font.
            </Note>
          ) : (
            <View style={[styles.fontList, { borderColor: theme.border }]}>
              {READING_FONT_CHOICES.map((choice) => (
                <FontRow
                  key={choice.font}
                  label={choice.label}
                  family={choice.preview}
                  selected={choice.font === stored.readingFont}
                  theme={theme}
                  fonts={fonts}
                  onPress={() => pickFont(choice.font)}
                />
              ))}
            </View>
          )}

          {/* --------------------------------------------- developer Pro switch */}
          {__DEV__ ? (
            <>
              <SectionTitle theme={theme} fonts={fonts} title="Developer" />
              <View style={[styles.toggleRow, { borderColor: theme.border }]}>
                <View style={styles.toggleText}>
                  <Text style={[styles.rowLabel, { color: theme.fg }, fonts?.body]}>Pro (development builds only)</Text>
                  <Text style={[styles.rowDetail, { color: theme.fgFaint }, fonts?.meta]}>
                    {PAYWALL_ENABLED
                      ? 'Unlocks the looks without a purchase'
                      : 'The paywall is off, so every look is open either way'}
                  </Text>
                </View>
                <Switch
                  value={devPro}
                  onValueChange={setDevPro}
                  trackColor={{ true: theme.accent, false: theme.border }}
                  thumbColor="#ffffff"
                />
              </View>
            </>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  )
}

export default AppearanceScreen

/* ------------------------------------------------------------------ parts */

function SectionTitle({ theme, fonts, title, detail }: { theme: Theme; fonts: LookFonts | null; title: string; detail?: string }) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.fg }, fonts?.title]}>{title}</Text>
      {detail ? <Text style={[styles.sectionDetail, { color: theme.fgFaint }, fonts?.meta]}>{detail}</Text> : null}
    </View>
  )
}

function Note({ theme, fonts, children }: { theme: Theme; fonts: LookFonts | null; children: string }) {
  return <Text style={[styles.note, { color: theme.fgDim }, fonts?.body]}>{children}</Text>
}

/**
 * One look, drawn as a miniature board in its own colours, type and corners.
 *
 * Memoised on primitives: the tiles re-render only when what they show changes,
 * not on every unrelated appearance update.
 */
const LookTile = memo(function LookTile({
  look,
  label,
  themeName,
  systemDark,
  selected,
  locked,
  theme,
  onPress,
}: {
  look: Look
  label: string
  themeName: ThemeName | null
  systemDark: boolean
  selected: boolean
  locked: boolean
  theme: Theme
  onPress: () => void
}) {
  const press = usePressAnimation()
  const skin = skinFor(look)
  const tileTheme = themeName ? paletteTheme(themeName) : systemDark ? CLASSIC_THEMES.dark : CLASSIC_THEMES.light

  return (
    <AnimatedPressable
      onPress={onPress}
      {...press.pressProps}
      accessibilityRole="button"
      accessibilityLabel={`${label} look${selected ? ', current' : ''}${locked ? ', Pro' : ''}`}
      accessibilityState={{ selected }}
      style={[styles.tile, press.animatedStyle]}
    >
      <View
        style={[
          styles.tileFrame,
          { borderColor: selected ? theme.accent : theme.border, borderWidth: selected ? 2 : StyleSheet.hairlineWidth },
        ]}
      >
        <MiniBoard theme={tileTheme} fonts={skin?.fonts ?? null} corner={skin?.corner ?? 14} />
        {locked ? (
          <View style={[styles.lock, { backgroundColor: theme.overlay }]}>
            <Text style={styles.lockText}>PRO</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.tileLabelRow}>
        {selected ? <GlyphIcon name="check" color={theme.accent} size={16} /> : null}
        <Text style={[styles.tileLabel, { color: selected ? theme.fg : theme.fgDim }]}>{label}</Text>
      </View>
      {themeName ? <Text style={[styles.tileTheme, { color: theme.fgFaint }]}>{themeName}</Text> : (
        <Text style={[styles.tileTheme, { color: theme.fgFaint }]}>Light & dark</Text>
      )}
    </AnimatedPressable>
  )
})

/** A board in miniature: wordmark, then two groups of three cards with progress. */
function MiniBoard({ theme, fonts, corner }: { theme: Theme; fonts: LookFonts | null; corner: number }) {
  const groups = (theme as LookTheme).ext?.groups
  const tint = (i: number) => (groups ? groups[i % groups.length] : theme.accent)
  const radius = Math.max(2, Math.round(corner / 2.5))

  return (
    <View style={[styles.mini, { backgroundColor: theme.bg }]}>
      <Text numberOfLines={1} style={[styles.miniTitle, { color: theme.fg }, fonts?.display, styles.miniTitleSize]}>
        StackRead
      </Text>
      {[0, 1].map((row) => (
        <View key={row} style={styles.miniRow}>
          <View style={styles.miniHead}>
            <View style={[styles.miniChip, { backgroundColor: tint(row) }]} />
            <View style={[styles.miniBar, { backgroundColor: theme.fgDim, width: row ? 30 : 44 }]} />
          </View>
          <View style={styles.miniCards}>
            {[0, 1, 2].map((c) => (
              <View
                key={c}
                style={[styles.miniCard, { backgroundColor: theme.surface, borderColor: theme.border, borderRadius: radius }]}
              >
                <View style={[styles.miniLine, { backgroundColor: theme.fgFaint }]} />
                <View style={[styles.miniLine, { backgroundColor: theme.fgFaint, width: '62%' }]} />
                <View style={[styles.miniTrack, { backgroundColor: theme.border }]}>
                  <View style={[styles.miniFill, { backgroundColor: tint(row + c), width: `${[72, 34, 100][c]}%` }]} />
                </View>
              </View>
            ))}
          </View>
        </View>
      ))}
    </View>
  )
}

/** The eight app themes as swatches: page colour, accent dot, name. */
function SwatchRow({
  label,
  current,
  active,
  theme,
  fonts,
  onPick,
}: {
  label: string
  current: ThemeName
  /** Whether this is the theme on screen right now (the light or dark half). */
  active: boolean
  theme: Theme
  fonts: LookFonts | null
  onPick: (name: ThemeName) => void
}) {
  return (
    <View style={styles.swatchBlock}>
      <Text style={[styles.swatchLabel, { color: theme.fgDim }, fonts?.meta]}>
        {label}
        {active && label !== 'Theme' ? '  · now' : ''}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.swatches}>
        {THEME_NAMES.map((name) => {
          const p = PALETTES[name]
          const selected = name === current
          return (
            <Pressable
              key={name}
              onPress={() => onPick(name)}
              accessibilityRole="button"
              accessibilityLabel={`${name} theme${selected ? ', selected' : ''}`}
              accessibilityState={{ selected }}
              style={styles.swatch}
            >
              <View style={[styles.swatchRing, { borderColor: selected ? theme.accent : 'transparent' }]}>
                <View style={[styles.swatchDisc, { backgroundColor: p.bg, borderColor: p.line }]}>
                  <View style={[styles.swatchCard, { backgroundColor: p.surface }]} />
                  <View style={[styles.swatchDot, { backgroundColor: p.accent }]} />
                </View>
              </View>
              <Text style={[styles.swatchName, { color: selected ? theme.fg : theme.fgFaint }]}>{name}</Text>
            </Pressable>
          )
        })}
      </ScrollView>
    </View>
  )
}

/** One reading font, named in its own face. */
function FontRow({
  label,
  family,
  selected,
  theme,
  fonts,
  onPress,
}: {
  label: string
  /** The React Native family (the asset file name); undefined for "Original". */
  family?: string
  selected: boolean
  theme: Theme
  fonts: LookFonts | null
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: theme.surfaceAlt }}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={styles.fontRow}
    >
      <View style={styles.fontText}>
        <Text style={[styles.fontName, { color: theme.fg }, family ? face(family) : fonts?.strong]}>{label}</Text>
        <Text numberOfLines={1} style={[styles.fontSample, { color: theme.fgDim }, family ? face(family) : fonts?.body]}>
          {family ? FONT_SAMPLE : 'Each book’s own typeface'}
        </Text>
      </View>
      {selected ? <GlyphIcon name="check" color={theme.accent} size={20} /> : null}
    </Pressable>
  )
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

const TILE_W = 132

const styles = StyleSheet.create({
  root: { flex: 1 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  back: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  barTitle: { fontSize: 20, fontWeight: '700' },

  section: { paddingHorizontal: 20, marginTop: 22, marginBottom: 10 },
  sectionTitle: { fontSize: 16, fontWeight: '600' },
  sectionDetail: { fontSize: 12, marginTop: 2 },
  note: { fontSize: 14, lineHeight: 20, paddingHorizontal: 20 },

  tiles: { paddingHorizontal: 16, gap: 12 },
  tile: { width: TILE_W },
  tileFrame: { borderRadius: 14, overflow: 'hidden' },
  tileLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8 },
  tileLabel: { fontSize: 14, fontWeight: '600' },
  tileTheme: { fontSize: 11, marginTop: 1 },
  lock: {
    position: 'absolute',
    top: 8,
    right: 8,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
  },
  lockText: { color: '#fff', fontSize: 10, fontWeight: '700', letterSpacing: 0.6 },

  mini: { height: 168, padding: 10, gap: 9 },
  miniTitle: { fontWeight: '700' },
  // After the look's own display style, so its size cannot overflow the tile.
  miniTitleSize: { fontSize: 13, lineHeight: 17 },
  miniRow: { gap: 5 },
  miniHead: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  miniChip: { width: 7, height: 7, borderRadius: 2 },
  miniBar: { height: 4, borderRadius: 2, opacity: 0.7 },
  miniCards: { flexDirection: 'row', gap: 5 },
  miniCard: { flex: 1, height: 48, borderWidth: StyleSheet.hairlineWidth, padding: 4, gap: 3 },
  miniLine: { height: 2.5, borderRadius: 1, opacity: 0.6 },
  miniTrack: { marginTop: 'auto', height: 2.5, borderRadius: 1, overflow: 'hidden' },
  miniFill: { height: 2.5 },

  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  toggleText: { flex: 1 },
  rowLabel: { fontSize: 15 },
  rowDetail: { fontSize: 12, marginTop: 2 },

  swatchBlock: { marginTop: 14 },
  swatchLabel: { fontSize: 12, fontWeight: '600', paddingHorizontal: 20, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.6 },
  swatches: { paddingHorizontal: 14, gap: 6 },
  swatch: { width: 64, alignItems: 'center', gap: 5 },
  swatchRing: { padding: 3, borderRadius: 30, borderWidth: 2 },
  swatchDisc: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  swatchCard: { position: 'absolute', left: 8, right: 8, top: 10, bottom: 10, borderRadius: 4 },
  swatchDot: { width: 12, height: 12, borderRadius: 6 },
  swatchName: { fontSize: 11 },

  fontList: { marginHorizontal: 16, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  fontRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, gap: 12 },
  fontText: { flex: 1 },
  fontName: { fontSize: 16 },
  fontSample: { fontSize: 13, marginTop: 2 },
})
