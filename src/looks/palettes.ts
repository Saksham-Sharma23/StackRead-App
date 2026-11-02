/**
 * Colour data for the optional looks — copied from the "StackRead colour"
 * variables in the Figma redesign sheet (design/redesign-plugin), role for role.
 *
 * Pure data with no imports, so it costs nothing at startup and the tests can
 * check it directly. The Classic look does not use any of this: its colours stay
 * in ui/theme.ts, untouched.
 */

/** The 17 roles every app theme defines. */
export interface Palette {
  bg: string
  surface: string
  /** theme.ts calls this surfaceAlt. */
  raised: string
  /** theme.ts calls this border. */
  line: string
  /** theme.ts calls these fg / fgDim / fgFaint. */
  ink: string
  ink2: string
  ink3: string
  accent: string
  /** Text and icons drawn on the accent. */
  onAccent: string
  danger: string
  /** Notebook's ruled lines. */
  rule: string
  /** Notebook's margin rule. */
  margin: string
  /** Five group colours, tuned per theme. */
  groups: readonly [string, string, string, string, string]
}

export const THEME_NAMES = ['Midnight', 'Daylight', 'Paper', 'Sepia', 'Forest', 'Ember', 'Terminal', 'OLED'] as const
export type ThemeName = (typeof THEME_NAMES)[number]

// Same order as the Figma sheet's role list, so the two can be compared by eye.
const ROLE_ORDER = ['bg', 'surface', 'raised', 'line', 'ink', 'ink2', 'ink3', 'accent', 'onAccent', 'danger', 'rule', 'margin'] as const
const RAW: Record<ThemeName, string> = {
  Midnight: '0B1020 121A2F 1A2440 26304F EEF1F8 A2ABC3 66708E 8AB0FF 0B1020 FF6B5E 1C2742 5A3346 8AB0FF F2B66D 7DD3B0 E98FB6 B7A0FF',
  Daylight: 'F5F5F1 FFFFFF ECECE7 DFDED8 16171B 5B5D64 94959B 2A57DE FFFFFF D53A2A E6E9EF F0C7C4 2A57DE D07A1E 23926A C2457E 6E4FD6',
  Paper: 'F3EEE2 FFFDF6 E9E2D1 D9CFBA 29251F 675F51 A0978A 2D4C8C FFFFFF BF3A2B CFDCEB E6A6A2 F0CF5A A3D1BC EFAEA8 AFC6EA CDB7E4',
  Sepia: 'EEE3CC F7EED9 E4D5B7 D3BF9B 3A2E21 6C5A43 9F8A6B 9A4719 FFF8EC A33120 DECDAA D9A08A 9A4719 56713D 2F5D7C 8C3D5E B48A2C',
  Forest: '0E1613 15201B 1D2B24 293930 E5EEE8 A1B4A8 6A8074 93D5A2 0E1613 F2775F 17241E 4A3530 93D5A2 E8C46B 82BBD8 E2917C C5A9E2',
  // Ember's group colours were dark book-cloth for Shelf's old covers; with one
  // layout for every look they mark chips and progress lines on a dark board,
  // so they are lifted to read there (brick, steel, sage, ochre, plum).
  Ember: '15110D 1F1914 2A221B 3A3027 F2E8DA BBA992 85735E E2A653 15110D F06B4F 2A221B 4E2E25 C7604F 6C93C2 7FAF86 D0A24A A985C2',
  Terminal: '0A0C09 10130E 171B14 2A3225 D5E2C4 92A282 5B6A50 A8E361 0A0C09 FF6E5A 141911 3A2A22 A8E361 FFB454 6CC5EA F27DAA C7A3FF',
  OLED: '000000 0C0C0E 161619 242428 F2F2F2 A5A5AC 6A6A71 F4C75B 000000 FF6159 111114 3B2222 F4C75B 8AB0FF 7DD3B0 E98FB6 B7A0FF',
}

function parse(raw: string): Palette {
  const hex = raw.split(' ').map((h) => `#${h.toLowerCase()}`)
  const p = Object.fromEntries(ROLE_ORDER.map((role, i) => [role, hex[i]])) as Omit<Palette, 'groups'>
  const g = hex.slice(ROLE_ORDER.length)
  return { ...p, groups: [g[0], g[1], g[2], g[3], g[4]] }
}

export const PALETTES: Record<ThemeName, Palette> = Object.fromEntries(
  THEME_NAMES.map((name) => [name, parse(RAW[name])]),
) as Record<ThemeName, Palette>

/**
 * Text colour for anything drawn *on* a group colour (tape labels, cloth
 * covers). Some themes' group colours are pastel and need dark text; others
 * are deep and need light text.
 */
export const ON_GROUP: Record<ThemeName, string> = {
  Midnight: '#0b1020', Daylight: '#ffffff', Paper: '#1b1a17', Sepia: '#fff8ec',
  Forest: '#0e1613', Ember: '#f4ecdf', Terminal: '#0a0c09', OLED: '#000000',
}

// ------------------------------------------------------------------ reading
export const READING_THEME_NAMES = ['Paper', 'Sepia', 'Mist', 'Dusk', 'Night', 'OLED'] as const
export type ReadingThemeName = (typeof READING_THEME_NAMES)[number]

export interface ReadingPalette {
  page: string
  ink: string
  ink2: string
  link: string
  code: string
}

const READING_RAW: Record<ReadingThemeName, string> = {
  Paper: 'FBF8F1 25221D 6B645A 2D4C8C F0EBDF',
  Sepia: 'F3E7CF 46382A 7A6650 9A4719 E8DABD',
  Mist: 'ECF0EA 1E2620 5B665D 2E6B4F DFE5DC',
  Dusk: '1D2130 D6DAE4 9097A8 9DB8FF 262B3D',
  Night: '131316 C9CBD1 85878F 8AB0FF 1D1D22',
  OLED: '000000 B9B9BC 76767B F4C75B 121214',
}

export const READING_PALETTES: Record<ReadingThemeName, ReadingPalette> = Object.fromEntries(
  READING_THEME_NAMES.map((name) => {
    const [page, ink, ink2, link, code] = READING_RAW[name].split(' ').map((h) => `#${h.toLowerCase()}`)
    return [name, { page, ink, ink2, link, code }]
  }),
) as Record<ReadingThemeName, ReadingPalette>
