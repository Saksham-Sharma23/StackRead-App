import { useColorScheme } from 'react-native'
import { useMemo } from 'react'

/**
 * Single palette, resolved from the OS colour scheme.
 *
 * `app.json` sets `userInterfaceStyle: "automatic"`, so this follows the phone's
 * system setting. Every colour used anywhere in the app comes from here — no
 * literal hex outside this file, so dark mode can't drift out of sync.
 */

export interface Theme {
  dark: boolean
  bg: string
  surface: string
  surfaceAlt: string
  border: string
  fg: string
  fgDim: string
  fgFaint: string
  accent: string
  danger: string
  overlay: string
  /** The grey behind document pages, so each page reads as a separate sheet. */
  gutter: string
  /**
   * The frosted strip drawn behind the Android navigation bar, bottom-most stop
   * last.
   *
   * A ramp rather than one colour because the app runs edge-to-edge: content
   * scrolls *under* a transparent navigation bar, and a single flat fill draws a
   * hard line across the screen where the strip begins. Stacking a few
   * increasing alphas fades content out into the bar instead, which is what
   * reads as glass.
   *
   * Four stops, and they live here rather than in the component for the reason
   * stated at the top of this file: a hard-coded `rgba()` in a component is a
   * colour that cannot follow the theme.
   */
  navScrim: readonly [string, string, string, string]
  /** The hairline that gives the scrim a top edge rather than a fade to nothing. */
  navScrimEdge: string
}

const light: Theme = {
  dark: false,
  bg: '#f7f7f9',
  surface: '#ffffff',
  surfaceAlt: '#eceef2',
  border: '#dcdfe5',
  fg: '#14141a',
  fgDim: '#5c5c68',
  fgFaint: '#9a9aa6',
  accent: '#0a66ff',
  danger: '#e5342a',
  overlay: 'rgba(0,0,0,0.45)',
  gutter: '#b8bcc4',
  // Built from `bg` (#f7f7f9) so the strip resolves to the page colour at full
  // strength rather than to a grey that reads as a foreign surface.
  navScrim: [
    'rgba(247,247,249,0.25)',
    'rgba(247,247,249,0.55)',
    'rgba(247,247,249,0.80)',
    'rgba(247,247,249,0.94)',
  ],
  navScrimEdge: 'rgba(0,0,0,0.05)',
}

/**
 * The dark theme, tinted toward the logo's navy.
 *
 * ## Why these are not neutral greys any more
 *
 * The splash is `#0e1a3b`, sampled from the logo's own tile, and getting three
 * colour layers to agree so launch does not flash white was real work
 * ([DETAIL.md §7.3](../../DETAIL.md)). Then the app opened onto a pure neutral
 * grey scale that carried none of it — so the launch promised a brand the UI
 * immediately dropped, and the app read as defaulted rather than authored.
 *
 * These are the same *values* as before, rotated toward the splash's hue: the
 * blue channel leads by a few points at each step, which is enough for the eye
 * to read the surface as continuous with the launch screen and far too little
 * to read as a blue theme. Lightness is unchanged, so every contrast pair that
 * held before still holds.
 *
 * The reader's own four themes are deliberately **not** touched. Those are page
 * colours, chosen for reading a document rather than for the app's identity,
 * and they live in `WebViewRenderer`.
 */
const dark: Theme = {
  dark: true,
  bg: '#0b0c11',
  surface: '#15171e',
  surfaceAlt: '#1f222c',
  border: '#2b2f3b',
  fg: '#f3f3f6',
  fgDim: '#a0a2ad',
  fgFaint: '#6b6e78',
  accent: '#4c8dff',
  danger: '#ff5a4e',
  overlay: 'rgba(0,0,0,0.6)',
  /*
   * The surface a page sits *on*, so it is read against the page — not against
   * `bg`.
   *
   * This was `#000000`, and the separation it has to provide is from the
   * reader's paper colour (`#17171b` in the dark reader theme, `#000000` in
   * black). Against a black page, a black gutter meant the sheet edges vanished
   * entirely and the "each page is a separate sheet" promise held only in light
   * mode.
   *
   * Kept dark and given the same navy lean as the rest of the palette, so the
   * gutter still recedes behind the page while remaining a distinct surface
   * from it.
   */
  gutter: '#04050a',
  // From `bg` (#0b0c11) for the same reason as the light ramp. The top stop is
  // deliberately weak: over a near-black board a strong first step is a visible
  // band rather than a fade.
  navScrim: [
    'rgba(11,12,17,0.20)',
    'rgba(11,12,17,0.50)',
    'rgba(11,12,17,0.78)',
    'rgba(11,12,17,0.94)',
  ],
  navScrimEdge: 'rgba(255,255,255,0.06)',
}

export function useTheme(): Theme {
  const scheme = useColorScheme()
  return useMemo(() => (scheme === 'dark' ? dark : light), [scheme])
}

/** Card geometry, shared by the row and the drag layer so they cannot disagree. */
export const CARD = {
  width: 132,
  height: 176,
  gap: 12,
  radius: 14,
} as const
