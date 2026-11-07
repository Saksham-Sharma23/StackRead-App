import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { DEFAULT_APPEARANCE, isLookLocked, previewTheme, type StoredAppearance } from '../looks/appearance.ts'

/*
 * The Appearance screen (TASKS3 L2), SVG icons in Classic, and the card's
 * long-press preview.
 */

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
/** Source without comments, so prose that names a pattern cannot satisfy or trip a check. */
const code = (path: string) => source(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const MODERN = { home: 'Midnight' as const, follow: ['Daylight', 'Midnight'] as const }
const NOTEBOOK = { home: 'Paper' as const }

/* --------------------------------------------------------- Appearance */

test('a look tile previews exactly what choosing it would give', () => {
  const stored: StoredAppearance = { ...DEFAULT_APPEARANCE, look: 'notebook', theme: 'Sepia', followSystem: false }

  // The look in use: its stored theme.
  assert.equal(previewTheme('notebook', stored, false, NOTEBOOK), 'Sepia')
  // Another look: what chooseLook would set — Modern follows the phone…
  assert.equal(previewTheme('modern', stored, false, MODERN), 'Daylight')
  assert.equal(previewTheme('modern', stored, true, MODERN), 'Midnight')
  // …a single-theme look opens in its home theme.
  assert.equal(previewTheme('notebook', { ...stored, look: 'modern' }, true, NOTEBOOK), 'Paper')
  // Classic draws its own colours.
  assert.equal(previewTheme('classic', stored, true, {}), null)
})

test('the look in use follows the phone when the user asked it to', () => {
  const stored: StoredAppearance = { ...DEFAULT_APPEARANCE, look: 'shelf', followSystem: true, lightTheme: 'Paper', darkTheme: 'Ember' }
  assert.equal(previewTheme('shelf', stored, false, { home: 'Ember' }), 'Paper')
  assert.equal(previewTheme('shelf', stored, true, { home: 'Ember' }), 'Ember')
})

test('only a non-Classic look without Pro is locked', () => {
  assert.equal(isLookLocked('classic', false), false)
  assert.equal(isLookLocked('modern', false), true)
  assert.equal(isLookLocked('modern', true), false)
})

test('the screen offers looks, every colour theme, the follow toggle and the reading fonts', () => {
  const screen = code('screens/AppearanceScreen.tsx')
  assert.match(screen, /LOOK_CHOICES\.map\(\(choice\) => \(\s*\n\s*<LookTile/)
  assert.match(screen, /THEME_NAMES\.map\(\(name\) =>/, 'all eight app themes as swatches')
  assert.match(screen, /value=\{stored\.followSystem\}/)
  assert.match(screen, /pickTheme\('lightTheme', n\)/)
  assert.match(screen, /pickTheme\('darkTheme', n\)/)
  assert.match(screen, /READING_FONT_CHOICES\.map\(/)
  assert.match(screen, /<MiniBoard theme=\{tileTheme\} fonts=\{skin\?\.fonts \?\? null\} corner=\{skin\?\.corner \?\? 14\}/,
    'each tile is drawn in the look’s own type, corners and colours')
  assert.match(screen, /if \(isLookLocked\(look, isPro\)\)/, 'a locked look explains instead of applying')
  assert.match(screen, /\{__DEV__ \? \(\s*\n\s*<>\s*\n\s*<SectionTitle theme=\{theme\} fonts=\{fonts\} title="Developer"/, 'the Pro switch is development-only')
  assert.match(screen, /onRequestClose=\{onClose\}/, 'Android back closes it')
})

test('the board and the reader open the same screen; the board loads it lazily', () => {
  const board = code('screens/LibraryScreen.tsx')
  assert.match(board, /const AppearanceScreen = lazy\(\(\) => import\('\.\/AppearanceScreen'\)\)/)
  assert.match(board, /label: 'Appearance…'/)
  assert.doesNotMatch(board, /lookSheetActions/, 'the plain list of look names is gone')

  const reader = code('screens/ReaderScreen.tsx')
  assert.match(reader, /<AppearanceScreen visible=\{sheet === 'look'\}/)
  assert.doesNotMatch(reader, /lookSheetActions/)
})

/* ----------------------------------------------------- Classic icons */

test('icons load after launch, and never on a build without react-native-svg', () => {
  const icons = code('ui/icons.ts')
  assert.match(icons, /TurboModuleRegistry\.get\('RNSVGSvgViewModule'\)/, 'the build is asked first')
  assert.match(icons, /if \(svgInBuild\(\)\) \{\s*\n\s*try \{\s*\n\s*icons = require\('\.\.\/looks\/Icon'\)/, 'a deferred, guarded require')
  assert.doesNotMatch(icons, /^import [^t].*looks\/Icon/m, 'never a static import — startupBundle.test.ts pins why')
  assert.match(icons, /InteractionManager\.runAfterInteractions/, 'the board waits for idle')
  assert.match(code('screens/ReaderScreen.tsx'), /^loadIconsNow\(\)/m, 'the lazy reader loads them at once')
})

test('every Classic icon keeps its text glyph as the stand-in', () => {
  const glyph = code('components/GlyphIcon.tsx')
  assert.match(glyph, /icons \? \(\s*\n\s*<icons\.Icon/)
  assert.match(glyph, /width: size, height: size/, 'one box for both, so the swap moves nothing')

  const sites: [string, RegExp][] = [
    ['screens/ReaderScreen.tsx', /glyph="‹"\s*\n\s*icon="back"/],
    ['screens/ReaderScreen.tsx', /glyph="⋯"\s*\n\s*icon="more"/],
    ['screens/ReaderScreen.tsx', /glyph: 'Aa', icon: 'type'/],
    ['screens/ReaderScreen.tsx', /glyph: '☰', icon: 'toc'/],
    ['components/SearchBar.tsx', /glyph="✕"\s*\n\s*icon="x"/],
    ['components/Dropdown.tsx', /<GlyphIcon name="down" glyph="⌄"/],
    ['components/FileCard.tsx', /<GlyphIcon name="more" glyph="⋯"/],
    ['components/GroupRow.tsx', /<GlyphIcon name="more" glyph="⋯"/],
    ['components/AddTile.tsx', /<GlyphIcon name="plus" glyph="\+"/],
    ['components/LibrarySearch.tsx', /<GlyphIcon name="search" glyph="⌕"/],
    ['screens/LibraryScreen.tsx', /<GlyphIcon name="more" glyph="⋯"/],
  ]
  for (const [path, pattern] of sites) assert.match(code(path), pattern, `${path}: ${pattern}`)

  // No bare text glyph left standing in for an icon in Classic's chrome.
  for (const path of ['components/FileCard.tsx', 'components/GroupRow.tsx', 'components/AddTile.tsx', 'components/LibrarySearch.tsx']) {
    assert.doesNotMatch(code(path), /<Text[^>]*>(⋯|⌕|\+)<\/Text>/, `${path} still draws a text glyph`)
  }
})

/* ------------------------------------------------------ card preview */

test('hold and release previews; hold and drag still reorders', () => {
  const card = code('components/DraggableCard.tsx')
  assert.match(card, /const HOLD_SLOP = 8/)
  assert.match(card, /if \(Math\.abs\(x - downX\.value\) > HOLD_SLOP\) state\.activate\(\)/, 'a drag starts past the slop')
  assert.match(card, /\.onStart\(\(\) => \{\s*\n\s*moved\.value = 1/, 'a started drag is remembered')
  assert.match(card, /if \(lifted\.value > 0 && moved\.value === 0\) \{\s*\n\s*lifted\.value = withSpring\(0/, 'a hold always puts the card back down')
  assert.match(card, /if \(released\) onPreview\?\.\(fileId\)/, 'only a released hold previews — a cancelled touch does not')
  assert.match(card, /if \(lifted\.value === 0\) \{\s*\n\s*state\.fail\(\)/, 'moving before the lift is still a row scroll')
})

test('the preview shows the cover, the facts and the opening lines, and leads to Open', () => {
  const preview = code('components/CardPreview.tsx')
  assert.match(preview, /source=\{file\.thumb \? \{ uri: thumbUri\(file\.thumb\) \} : undefined\}/)
  assert.match(preview, /snippetOf\(file\)/, 'text formats: the cards’ own bounded, cached read')
  assert.match(preview, /pdf\.pageText\(fileUri\(file\.storedName\), 1\)/, 'PDF: page one’s text')
  assert.match(preview, /onPress=\{\(\) => act\(onOpen\)\}/)
  assert.match(preview, /onPress=\{\(\) => act\(onMenu\)\}/)
  assert.match(preview, /onRequestClose=\{onClose\}/)

  const snippet = code('components/useSnippet.ts')
  assert.match(snippet, /export function snippetOf\(/)
  assert.match(snippet, /handle\.readBytes\(SNIPPET_READ_BYTES\)/, 'still a bounded read')

  const board = code('screens/LibraryScreen.tsx')
  assert.match(board, /onPreviewFile=\{handlePreview\}/)
  assert.match(board, /<CardPreview\s*\n\s*fileId=\{previewId\}/)
})
