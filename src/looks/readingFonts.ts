import type { ReadingFont } from './appearance.ts'
import { READING_PALETTES, type ReadingPalette, type ReadingThemeName } from './palettes.ts'

/**
 * Reading type and page colours for the optional looks (TASKS3 L5). Pure, so
 * the tests run it directly; the loader that reads the font files is
 * readingFontLoader.ts.
 *
 * ## How a font reaches the viewer
 *
 * The viewer is deliberately inert — no file access, and a CSP whose only font
 * source is `data:` (viewerHtml.ts). So the font travels *in* the page: its two
 * faces are read from the APK's assets once, base64-encoded, and sent as one
 * `@font-face` block. Nothing about the WebView's settings or its CSP changes.
 *
 * Two faces per family — regular, and a bold for headings. Italic is left to
 * the browser to slant: a third face would be a third of the payload again for
 * the one style a reader can do without.
 */

type FontKey = Exclude<ReadingFont, 'default'>

export interface ReadingFontSpec {
  label: string
  /** Asset file names, without extension; also the React Native family names. */
  regular: string
  bold: string
  /** CSS generic family used until the face arrives, and if it never does. */
  fallback: 'serif' | 'sans-serif' | 'monospace'
}

export const READING_FONT_SPECS: Record<FontKey, ReadingFontSpec> = {
  literata: { label: 'Literata', regular: 'Literata-Regular', bold: 'Literata-SemiBold', fallback: 'serif' },
  sourceSerif: { label: 'Source Serif', regular: 'SourceSerif4-Regular', bold: 'SourceSerif4-SemiBold', fallback: 'serif' },
  atkinson: { label: 'Atkinson', regular: 'AtkinsonHyperlegible-Regular', bold: 'AtkinsonHyperlegible-Bold', fallback: 'sans-serif' },
  geist: { label: 'Geist', regular: 'Geist-Regular', bold: 'Geist-SemiBold', fallback: 'sans-serif' },
  mono: { label: 'Mono', regular: 'JetBrainsMono-Regular', bold: 'JetBrainsMono-Bold', fallback: 'monospace' },
}

/** The choices the Display sheet offers, in order. `default` is the viewer's own font. */
export const READING_FONT_CHOICES: { font: ReadingFont; label: string; preview?: string }[] = [
  { font: 'default', label: 'Original' },
  ...(Object.keys(READING_FONT_SPECS) as FontKey[]).map((font) => ({
    font,
    label: READING_FONT_SPECS[font].label,
    preview: READING_FONT_SPECS[font].regular,
  })),
]

/** The CSS family name inside the viewer, or '' for the viewer's own font. */
export function readingFontFamily(font: ReadingFont): string {
  if (font === 'default') return ''
  const s = READING_FONT_SPECS[font]
  return `"SR ${s.label}", ${s.fallback}`
}

/**
 * One `@font-face` block for both faces.
 *
 * Weight *ranges*, so every weight the viewer asks for maps to one of the two
 * real faces: body text (400) to regular, headings (the viewer uses 650) to
 * bold. A single declared weight would leave the browser synthesising the rest.
 */
export function fontFaceCss(font: FontKey, regularBase64: string, boldBase64: string): string {
  const family = `SR ${READING_FONT_SPECS[font].label}`
  const face = (b64: string, weights: string) =>
    `@font-face{font-family:"${family}";src:url(data:font/ttf;base64,${b64}) format("truetype");font-weight:${weights};font-style:normal;font-display:swap}`
  return face(regularBase64, '100 549') + face(boldBase64, '550 900')
}

// ----------------------------------------------------------- page colours

export type PageThemeKey = 'system' | 'light' | 'sepia' | 'mist' | 'dusk' | 'dark' | 'black'

/**
 * The reader's stored theme keys, drawn with the redesign's reading palettes.
 * The keys stay the ones Classic already stores, so a reader who switches look
 * keeps their page choice.
 */
export const LOOK_PAGE: Record<Exclude<PageThemeKey, 'system'>, ReadingThemeName> = {
  light: 'Paper',
  sepia: 'Sepia',
  mist: 'Mist',
  dusk: 'Dusk',
  dark: 'Night',
  black: 'OLED',
}

/** Page colours for a look; `system` follows the app's light or dark theme. */
export function lookPageColors(key: PageThemeKey, appIsDark: boolean): ReadingPalette {
  const name = key === 'system' ? (appIsDark ? 'Night' : 'Paper') : LOOK_PAGE[key]
  return READING_PALETTES[name]
}

/** The order the Display sheet shows page themes in, with their names. */
export const PAGE_CHOICES: { key: PageThemeKey; label: string }[] = [
  { key: 'system', label: 'Auto' },
  { key: 'light', label: 'Paper' },
  { key: 'sepia', label: 'Sepia' },
  { key: 'mist', label: 'Mist' },
  { key: 'dusk', label: 'Dusk' },
  { key: 'dark', label: 'Night' },
  { key: 'black', label: 'OLED' },
]
