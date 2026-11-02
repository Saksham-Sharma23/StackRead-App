import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LOOK_PAGE,
  PAGE_CHOICES,
  READING_FONT_CHOICES,
  READING_FONT_SPECS,
  fontFaceCss,
  lookPageColors,
  readingFontFamily,
} from '../looks/readingFonts.ts'
import { READING_PALETTES } from '../looks/palettes.ts'
import { buildViewerHtml } from '../renderers/webview/viewerHtml.ts'

/**
 * TASKS3 L5: reading fonts and page themes for the optional looks.
 *
 * The rules pinned here are the ones that would fail silently on a device: a
 * font named in code but missing from the APK renders as the system font with
 * no error; a viewer stylesheet that lost its fallback would restyle Classic.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('font-face CSS declares both faces as data: URLs with weight ranges', () => {
  const css = fontFaceCss('literata', 'AAAA', 'BBBB')
  assert.equal((css.match(/@font-face/g) ?? []).length, 2)
  assert.match(css, /src:url\(data:font\/ttf;base64,AAAA\)/)
  assert.match(css, /src:url\(data:font\/ttf;base64,BBBB\)/)
  assert.match(css, /font-weight:100 549/)
  assert.match(css, /font-weight:550 900/)
  // Nothing but data: — the viewer's CSP allows no other font source.
  assert.doesNotMatch(css, /url\((?!data:)/)
})

test('the family named in settings matches the one the CSS declares', () => {
  for (const font of Object.keys(READING_FONT_SPECS) as (keyof typeof READING_FONT_SPECS)[]) {
    const family = readingFontFamily(font)
    const declared = /font-family:"([^"]+)"/.exec(fontFaceCss(font, 'A', 'B'))![1]
    assert.ok(family.startsWith(`"${declared}"`), `${font}: ${family} vs ${declared}`)
    assert.match(family, /, (serif|sans-serif|monospace)$/, 'always ends in a generic fallback')
  }
  assert.equal(readingFontFamily('default'), '', 'default sends an empty family, i.e. the viewer\'s own')
})

test('the Display sheet offers the original font first, then every reading font', () => {
  assert.equal(READING_FONT_CHOICES[0].font, 'default')
  assert.equal(READING_FONT_CHOICES.length, 1 + Object.keys(READING_FONT_SPECS).length)
})

test('page themes map to the redesign palettes; Auto follows the app', () => {
  assert.equal(lookPageColors('system', true), READING_PALETTES.Night)
  assert.equal(lookPageColors('system', false), READING_PALETTES.Paper)
  assert.equal(lookPageColors('mist', false), READING_PALETTES.Mist)
  assert.equal(lookPageColors('dusk', true), READING_PALETTES.Dusk)
  assert.equal(lookPageColors('black', true), READING_PALETTES.OLED)
  // Every stored key is offered, and every offered key resolves.
  for (const { key } of PAGE_CHOICES) assert.ok(lookPageColors(key, false).page)
  assert.deepEqual(Object.keys(LOOK_PAGE).sort(), PAGE_CHOICES.filter((c) => c.key !== 'system').map((c) => c.key).sort())
})

test('every font face the looks name is bundled and listed in the expo-font plugin', () => {
  const app = JSON.parse(readFileSync(resolve(ROOT, 'app.json'), 'utf8'))
  const plugin = app.expo.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-font')
  assert.ok(plugin, 'expo-font plugin present in app.json')
  const listed = new Set<string>(plugin[1].fonts.map((f: string) => f.replace('./assets/fonts/', '').replace('.ttf', '')))

  const named = new Set<string>()
  const dir = resolve(ROOT, 'src/looks')
  for (const f of readdirSync(dir).filter((n) => /\.tsx?$/.test(n))) {
    for (const m of readFileSync(resolve(dir, f), 'utf8').matchAll(/face\('([^']+)'\)/g)) named.add(m[1])
  }
  for (const s of Object.values(READING_FONT_SPECS)) {
    named.add(s.regular)
    named.add(s.bold)
  }
  assert.ok(named.size > 20, 'the scan really found the looks\' fonts')
  for (const name of named) {
    assert.ok(existsSync(resolve(ROOT, 'assets/fonts', `${name}.ttf`)), `assets/fonts/${name}.ttf exists`)
    assert.ok(listed.has(name), `${name} is in the expo-font plugin list`)
  }
})

test('the viewer keeps its own font, link and code colours unless a look sets them', () => {
  const html = buildViewerHtml(
    { bg: '#000', fg: '#fff', fgDim: '#888', accent: '#09f', border: '#333', surfaceAlt: '#111', surface: '#222', gutter: '#0a0a0a' },
    0,
  )
  // Each look-only variable falls back to exactly what Classic had before.
  assert.ok(html.includes('font-family: var(--sr-font, -apple-system, "Segoe UI", Roboto, sans-serif);'))
  assert.ok(html.includes('a { color: var(--sr-link, #09f); }'))
  assert.equal((html.match(/background: var\(--sr-code, #111\);/g) ?? []).length, 2)
  // The font arrives by message and is installed as a style element.
  assert.ok(html.includes("msg.type === 'font'"))
  assert.ok(html.includes('function installFont(css)'))
  // And the CSP still allows fonts from data: only.
  assert.match(html, /font-src data:;/)
})
