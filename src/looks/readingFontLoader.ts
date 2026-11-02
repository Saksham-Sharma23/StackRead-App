import { File } from 'expo-file-system'

import type { ReadingFont } from './appearance'
import { READING_FONT_SPECS, fontFaceCss } from './readingFonts'

/**
 * Reads a reading font's two faces out of the APK and builds its `@font-face`.
 *
 * The files are already in the APK: the expo-font plugin copies every font in
 * app.json to `assets/fonts/`, which expo-file-system reads as `asset:///`.
 * No second copy of the fonts, and no new module.
 *
 * Cached per font for the life of the process — a font is read and encoded
 * once, however many documents are opened with it. A failed read is not
 * cached, so it is retried next time rather than remembered as permanent.
 * Null means "use the viewer's own font", which is always a safe answer.
 */
const cache = new Map<ReadingFont, Promise<string | null>>()

export function loadReadingFontCss(font: ReadingFont): Promise<string | null> {
  if (font === 'default') return Promise.resolve(null)
  const hit = cache.get(font)
  if (hit) return hit
  const spec = READING_FONT_SPECS[font]
  const read = (name: string) => new File(`asset:///fonts/${name}.ttf`).base64()
  const p = Promise.all([read(spec.regular), read(spec.bold)])
    .then(([regular, bold]) => fontFaceCss(font, regular, bold))
    .catch(() => {
      cache.delete(font)
      return null
    })
  cache.set(font, p)
  return p
}
