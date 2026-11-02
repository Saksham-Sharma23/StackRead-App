import { useAppearance } from '../store/appearance'
import { useLook } from '../ui/theme'
import type { Look } from './appearance'
import type { ThemeName } from './palettes'
import type { LookFonts, Skin } from './skin'
import type { SheetAction } from '../components/ActionSheet'

/**
 * Which skin draws each look. Classic has none, on purpose: a screen that gets
 * `undefined` renders exactly what it rendered before looks existed.
 *
 * ## Loaded on first use, not at startup
 *
 * The board and the shared sheets ask for the skin, and both are in the startup
 * graph. Static imports here would make every launch — Classic included —
 * evaluate all three looks and react-native-svg behind them. A `require` inside
 * a function is only evaluated when called (Metro's `inlineRequires` is off, so
 * this is the explicit form of it), so a look's code loads the first time that
 * look is drawn and never otherwise. `startupBundle.test.ts` pins this.
 *
 */
const LOADERS: Partial<Record<Look, () => Skin>> = {
  modern: () => require('./modern').modernSkin,
  notebook: () => require('./notebook').notebookSkin,
  shelf: () => require('./shelf').shelfSkin,
  terminal: () => require('./terminal').terminalSkin,
}

const loaded = new Map<Look, Skin>()

/** The skin for a look, loading its module the first time. Same object every call. */
export function skinFor(look: Look): Skin | undefined {
  const hit = loaded.get(look)
  if (hit) return hit
  const load = LOADERS[look]
  if (!load) return undefined
  const skin = load()
  loaded.set(look, skin)
  return skin
}

/** The looks the picker offers, in order, with the theme each one starts in. */
export const LOOK_CHOICES: { look: Look; label: string; home?: ThemeName; follow?: [ThemeName, ThemeName] }[] = [
  { look: 'classic', label: 'Classic' },
  { look: 'modern', label: 'Modern', home: 'Midnight', follow: ['Daylight', 'Midnight'] },
  { look: 'notebook', label: 'Notebook', home: 'Paper' },
  { look: 'shelf', label: 'Shelf', home: 'Ember' },
  { look: 'terminal', label: 'Terminal', home: 'Terminal' },
]

/**
 * Switches look, in the look's own colour theme.
 *
 * Modern follows the phone between a light and a dark theme, as Classic does.
 * The others are designed around one theme each, so they pin it. Choosing
 * other pairs is the full Appearance screen's job (TASKS3 L2).
 */
export function chooseLook(look: Look) {
  const s = useAppearance.getState()
  const choice = LOOK_CHOICES.find((c) => c.look === look)
  s.set('look', look)
  if (choice?.follow) {
    s.set('lightTheme', choice.follow[0])
    s.set('darkTheme', choice.follow[1])
    s.set('followSystem', true)
  } else if (choice?.home) {
    s.set('theme', choice.home)
    s.set('followSystem', false)
  }
}

/**
 * The look picker's rows, shared by the board's ⋯ sheet and the reader's ⋯
 * menu so the two can never offer different looks. `current` is the stored
 * look; it is shown, marked and not selectable.
 */
export function lookSheetActions(current: Look): SheetAction[] {
  return LOOK_CHOICES.map((c) => ({
    key: c.look,
    label: c.label,
    meta: c.look === current ? 'current' : undefined,
    disabled: c.look === current,
    onPress: () => chooseLook(c.look),
  }))
}

export function useSkin(): Skin | undefined {
  return skinFor(useLook())
}

/** The look's type for shared sheets; null in Classic, so they keep their own. */
export function useLookFonts(): LookFonts | null {
  return useSkin()?.fonts ?? null
}
