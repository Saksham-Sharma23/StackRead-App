import type { Theme } from '../ui/theme.ts'
import { PALETTES, THEME_NAMES, type Palette, type ThemeName } from './palettes.ts'

/**
 * Which look and colour theme the app draws with — the pure half.
 *
 * Classic is the app as it was before looks existed, and it is what anyone
 * without Pro sees. The rule that keeps it that way lives in one place,
 * `resolveAppearance`: the *stored* choice is kept exactly as the user made it,
 * and resolution returns Classic whenever Pro is off. So a refund or a lapsed
 * entitlement falls back to Classic without deleting anything, and buying again
 * brings the choice straight back. Nothing else in the app asks whether the user
 * is Pro in order to pick colours.
 *
 * No React or React Native here, so the tests run it directly.
 */

export const LOOKS = ['classic', 'modern', 'notebook', 'shelf', 'terminal'] as const
export type Look = (typeof LOOKS)[number]

export const READING_FONTS = ['default', 'literata', 'sourceSerif', 'atkinson', 'geist', 'mono'] as const
export type ReadingFont = (typeof READING_FONTS)[number]

/** What is saved. Every field is the user's own choice, Pro or not. */
export interface StoredAppearance {
  look: Look
  /** The theme used when `followSystem` is off. */
  theme: ThemeName
  /** Switch between `lightTheme` and `darkTheme` with the phone's setting. */
  followSystem: boolean
  lightTheme: ThemeName
  darkTheme: ThemeName
  /** `default` keeps the reader's current typeface. */
  readingFont: ReadingFont
}

export const DEFAULT_APPEARANCE: StoredAppearance = {
  look: 'classic',
  theme: 'Midnight',
  followSystem: true,
  lightTheme: 'Daylight',
  darkTheme: 'Midnight',
  readingFont: 'default',
}

/** What to draw with. Classic carries no theme: it keeps its own colours. */
export type ResolvedAppearance =
  | { look: 'classic' }
  | { look: Exclude<Look, 'classic'>; theme: ThemeName }

/** One shared object, so React sees the same value every time Classic resolves. */
export const CLASSIC: ResolvedAppearance = Object.freeze({ look: 'classic' as const })

export function resolveAppearance(stored: StoredAppearance, isPro: boolean, systemDark: boolean): ResolvedAppearance {
  if (!isPro || stored.look === 'classic') return CLASSIC
  const theme = stored.followSystem ? (systemDark ? stored.darkTheme : stored.lightTheme) : stored.theme
  return { look: stored.look, theme }
}

/**
 * Reads whatever was saved and keeps only valid values, field by field.
 *
 * Storage outlives code: a value written by a newer build, or a look that was
 * later renamed, must fall back to the default for that field rather than throw
 * on launch or leave a hole the UI cannot render.
 */
export function sanitizeAppearance(raw: unknown): StoredAppearance {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
  return {
    look: pick(r.look, LOOKS, DEFAULT_APPEARANCE.look),
    theme: pick(r.theme, THEME_NAMES, DEFAULT_APPEARANCE.theme),
    followSystem: typeof r.followSystem === 'boolean' ? r.followSystem : DEFAULT_APPEARANCE.followSystem,
    lightTheme: pick(r.lightTheme, THEME_NAMES, DEFAULT_APPEARANCE.lightTheme),
    darkTheme: pick(r.darkTheme, THEME_NAMES, DEFAULT_APPEARANCE.darkTheme),
    readingFont: pick(r.readingFont, READING_FONTS, DEFAULT_APPEARANCE.readingFont),
  }
}

// ------------------------------------------------------------------- theme

/** The extra roles a non-Classic look needs, on top of today's `Theme`. */
export interface LookExtras {
  name: ThemeName
  onAccent: string
  rule: string
  margin: string
  groups: Palette['groups']
}
export type LookTheme = Theme & { ext: LookExtras }

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
const rgba = (hex: string, a: number) => `rgba(${rgb(hex).join(',')},${a})`
/** Relative luminance, WCAG definition. */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** Moves a colour toward black by `amount` (0..1). */
const shade = (hex: string, amount: number) =>
  '#' + rgb(hex).map((c) => Math.round(c * (1 - amount)).toString(16).padStart(2, '0')).join('')

/**
 * A full `Theme` from a palette, so today's components can draw with it
 * unchanged. The derived roles follow the same rules theme.ts uses for Classic:
 * the nav scrim is a ramp of `bg` at the same alphas, the overlay is black, and
 * the gutter is a darker step that still reads as separate from the page.
 */
function buildTheme(name: ThemeName): LookTheme {
  const p = PALETTES[name]
  const dark = luminance(p.bg) < 0.2
  const alphas = dark ? [0.2, 0.5, 0.78, 0.94] : [0.25, 0.55, 0.8, 0.94]
  return {
    dark,
    bg: p.bg,
    surface: p.surface,
    surfaceAlt: p.raised,
    border: p.line,
    fg: p.ink,
    fgDim: p.ink2,
    fgFaint: p.ink3,
    accent: p.accent,
    danger: p.danger,
    overlay: dark ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.45)',
    gutter: dark ? shade(p.bg, 0.55) : shade(p.line, 0.15),
    navScrim: [rgba(p.bg, alphas[0]), rgba(p.bg, alphas[1]), rgba(p.bg, alphas[2]), rgba(p.bg, alphas[3])],
    navScrimEdge: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
    ext: { name, onAccent: p.onAccent, rule: p.rule, margin: p.margin, groups: p.groups },
  }
}

// Built once per theme: a component that compares themes by reference must see
// the same object for the same theme, or every consumer re-renders on each read.
const built = new Map<ThemeName, LookTheme>()
export function paletteTheme(name: ThemeName): LookTheme {
  let t = built.get(name)
  if (!t) {
    t = buildTheme(name)
    built.set(name, t)
  }
  return t
}

// ------------------------------------------------------------- group colour

/**
 * Which of the five group colours a group gets, from its id.
 *
 * Derived rather than stored so it needs no schema change, no migration and no
 * entry in backups. FNV-1a, because it is tiny and spreads short ids well. A
 * user-chosen colour can later be stored and take precedence over this.
 */
export function groupColorIndex(groupId: string): 0 | 1 | 2 | 3 | 4 {
  let h = 0x811c9dc5
  for (let i = 0; i < groupId.length; i++) {
    h ^= groupId.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return ((h >>> 0) % 5) as 0 | 1 | 2 | 3 | 4
}
