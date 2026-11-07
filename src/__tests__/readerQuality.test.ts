import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { buildViewerHtml, isDarkColor } from '../renderers/webview/viewerHtml.ts'
import { PALETTES, READING_PALETTES } from '../looks/palettes.ts'
import { SUPPORT_EMAIL, crashReportMailto, crashReportText, parseCrashRecord } from '../ui/crashReport.ts'
import { tidyPdfText } from '../renderers/pdfPageText.ts'

/*
 * P1 fixes from REVIEW.md §6: dark pages declared light (#12), no crash
 * reporting (#10), no text selection in PDFs (#7) and deprecated
 * navigation-bar APIs (#9).
 */

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const THEME = {
  bg: '#0b0c11', fg: '#fff', fgDim: '#888', accent: '#09f',
  border: '#333', surfaceAlt: '#111', surface: '#222', gutter: '#0a0a0a',
}

function viewerScript(theme = THEME): string {
  const match = buildViewerHtml(theme, 0).match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)
  assert.ok(match, 'viewer HTML contains no script block')
  return match[1]
}

/* ------------------------------------------------- #12 color-scheme */

test('Classic dark is declared dark — it was compared against a hex no theme used', () => {
  assert.match(buildViewerHtml(THEME, 0), /color-scheme: dark;/)
  assert.match(buildViewerHtml({ ...THEME, bg: '#f7f7f9' }, 0), /color-scheme: light;/)
})

test('every app and reading palette is classified by its own luminance', () => {
  // The dark ones by design; anything else in these lists is light.
  const dark = new Set(['Midnight', 'Forest', 'Ember', 'Terminal', 'OLED', 'Dusk', 'Night'])
  for (const [name, p] of Object.entries(PALETTES)) {
    assert.equal(isDarkColor(p.bg), dark.has(name), `app theme ${name} (${p.bg})`)
  }
  for (const [name, p] of Object.entries(READING_PALETTES)) {
    assert.equal(isDarkColor(p.page), dark.has(name), `reading theme ${name} (${p.page})`)
  }
  assert.equal(isDarkColor('#000'), true)
  assert.equal(isDarkColor('#fff'), false)
  assert.equal(isDarkColor('rgb(0,0,0)'), false, 'a non-hex colour falls back to light')
})

test('the viewer follows the page colour it is sent, with the same test', () => {
  const js = viewerScript()
  const start = js.indexOf('function isDarkHex')
  const viewerIsDark = new Function(
    `${js.slice(start, js.indexOf('/**', start))}; return isDarkHex;`,
  )() as (c: string) => boolean
  for (const c of ['#000000', '#ffffff', '#f4ecd8', '#17171b', '#0b0c11', '#abc', 'nope']) {
    assert.equal(viewerIsDark(c), isDarkColor(c), `host and viewer disagree on ${c}`)
  }
  const apply = js.slice(js.indexOf('function applySettings'))
  assert.match(apply, /root\.colorScheme = isDarkHex\(s\.paper\) \? 'dark' : 'light'/)
})

/* ---------------------------------------------- #10 crash reports */

const RECORD = JSON.stringify({
  at: Date.UTC(2026, 10, 7, 12, 0, 0),
  where: 'global',
  fatal: true,
  name: 'TypeError',
  message: "Cannot read properties of null (reading 'mode')",
  stack: 'at render (viewer:1:2)\nat handle (viewer:3:4)',
})

test('a stored crash record is parsed, and junk is not', () => {
  const record = parseCrashRecord(RECORD)
  assert.equal(record?.name, 'TypeError')
  assert.equal(parseCrashRecord(null), null)
  assert.equal(parseCrashRecord('not json'), null)
  assert.equal(parseCrashRecord('{"message": 1}'), null)
})

test('the report says what happened and where, and is short enough for a mail link', () => {
  const record = parseCrashRecord(RECORD)!
  const text = crashReportText(record, 'android 34')
  assert.match(text, /When: 2026-11-07T12:00:00\.000Z/)
  assert.match(text, /Error: TypeError: Cannot read properties of null/)
  assert.match(text, /Device: android 34/)

  const long = parseCrashRecord(JSON.stringify({ ...JSON.parse(RECORD), stack: 'x'.repeat(10_000) }))!
  assert.ok(crashReportText(long, 'android').length <= 1502)

  const mailto = crashReportMailto(record, 'android 34')
  assert.ok(mailto.startsWith(`mailto:${SUPPORT_EMAIL}?subject=`))
  assert.equal(decodeURIComponent(mailto.split('&body=')[1]), text)
})

test('nothing is sent on its own: the report is offered once, after launch', () => {
  const log = source('ui/crashLog.ts')
  assert.match(log, /export function takePendingCrashReport\(\)/)
  assert.match(log, /storage\.remove\(LAST_CRASH_KEY\)[\s\S]{0,200}pendingReport = parseCrashRecord\(raw\)/,
    'cleared from storage before any UI, so a failing prompt cannot repeat forever')

  const prompt = source('ui/crashPrompt.ts')
  assert.match(prompt, /text: 'Not now'/)
  assert.match(prompt, /Linking\.openURL\(crashReportMailto\(/, 'sent from the user’s own mail app')
  assert.doesNotMatch(prompt, /fetch\(|XMLHttpRequest/, 'the app never uploads a report itself')

  const app = source('../App.tsx')
  assert.match(app, /const crash = takePendingCrashReport\(\)\s*\n\s*if \(crash\) offerCrashReport\(crash\)/)

  assert.match(source('../PRIVACY.md'), /nothing is sent unless you\s+send it/)
})

/* ------------------------------------------------- #7 PDF text */

test('a PDF page’s text is tidied for copying without guessing at words', () => {
  assert.equal(tidyPdfText('Line one  \r\nLine two\r\n\r\n\r\n\r\nNext\u0000 para\f'), 'Line one\nLine two\n\nNext para')
  assert.equal(tidyPdfText('co-\nop'), 'co-\nop', 'a hyphen at a line end is left alone')
  assert.equal(tidyPdfText('   \n  '), '')
})

test('PDFs offer Select text, through the pdfium text module already in the build', () => {
  const reader = source('screens/ReaderScreen.tsx')
  assert.match(reader, /const pdfTextAvailable = current\?\.format === 'pdf' && pdfSearchAvailable/)
  assert.match(reader, /if \(pdfTextAvailable\) \{\s*\n\s*items\.push\(\{ key: 'text'/)
  assert.match(reader, /<PdfTextSheet\s*\n\s*visible=\{sheet === 'text'\}/)
  // Primitive selectors only (CLAUDE.md §5.1).
  assert.match(reader, /s\.byFile\[current\.id\]\?\.current \?\? 1/)

  const sheet = source('components/PdfTextSheet.tsx')
  assert.match(sheet, /pageText\(uri, shown\)/)
  assert.match(sheet, /<Text selectable/, 'the system copy toolbar does the copying')
})

/* ---------------------------------------- #9 navigation-bar APIs */

test('immersive mode uses the SDK 57 APIs, not the deprecated ones', () => {
  const hook = source('ui/useFullscreen.ts')
  const code = hook.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const deprecated of ['setVisibilityAsync', 'setBehaviorAsync', 'setStatusBarHidden']) {
    assert.ok(!code.includes(deprecated), `${deprecated} is deprecated in SDK 57`)
  }
  assert.match(code, /mod\.NavigationBar\.setHidden\(hidden\)/)
  assert.match(code, /StatusBar\.setHidden\(hidden, 'fade'\)/)
  assert.match(code, /await import\('expo-navigation-bar'\)/, 'still lazy, so a build without it degrades')
})
