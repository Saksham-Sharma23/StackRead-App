import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { INLINE_STYLE_PROPS, safeInlineStyle, sanitizeHtml } from '../renderers/webview/sanitize.ts'
import { normalizeBookCss } from '../renderers/webview/bookCss.ts'
import {
  MAX_FONT_BYTES,
  MAX_TOTAL_FONT_BYTES,
  chooseFonts,
  encryptedPaths,
  fontMime,
  inlineFontUrls,
  resolvePath,
} from '../renderers/webview/bookFonts.ts'
import { buildViewerHtml } from '../renderers/webview/viewerHtml.ts'

/*
 * Books lost their own fonts and styling. Three causes, all fixed here:
 *
 *  - the book's stylesheet travelled as a <style> inside the content, and the
 *    viewer's sanitiser removes every style element — so it never applied;
 *  - inline `style` attributes were removed outright;
 *  - fonts were url()s the viewer can never load (its CSP fetches nothing).
 */

const THEME = {
  bg: '#000', fg: '#fff', fgDim: '#888', accent: '#09f',
  border: '#333', surfaceAlt: '#111', surface: '#222', gutter: '#0a0a0a',
}

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

function viewerScript(): string {
  const match = buildViewerHtml(THEME, 0).match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)
  assert.ok(match, 'viewer HTML contains no script block')
  return match[1]
}

/** The viewer's own `safeInlineStyle`, lifted from the emitted script and run. */
function viewerSafeInlineStyle(): (raw: string) => string {
  const js = viewerScript()
  const start = js.indexOf('var INLINE_STYLE_PROPS')
  const end = js.indexOf('/**', js.indexOf('function safeInlineStyle'))
  assert.ok(start > 0 && end > start, 'safeInlineStyle not found in the viewer')
  return new Function(`${js.slice(start, end)}; return safeInlineStyle;`)() as (raw: string) => string
}

/* ---------------------------------------------------------- inline style */

test('inline typography and spacing are kept', () => {
  assert.equal(sanitizeHtml('<p style="text-align:center">t</p>'), '<p style="text-align:center">t</p>')
  assert.equal(
    safeInlineStyle('font-style: italic; margin-left: 2em; font-variant: small-caps'),
    'font-style:italic;margin-left:2em;font-variant:small-caps',
  )
})

test('colour, layout and anything that can load are still removed', () => {
  assert.equal(safeInlineStyle('color: red; background: blue; position: absolute; width: 900px'), '')
  for (const hostile of [
    'background:url(https://x)',
    'font-family: url(x)',
    'margin-left: expression(alert(1))',
    'font-family: \\75 rl(x)',
    'font-family: a&#40;b',
    'font-size: var(--x)',
    'text-align: center /* hidden */',
  ]) {
    assert.equal(safeInlineStyle(hostile), '', `kept: ${hostile}`)
  }
  assert.equal(sanitizeHtml('<div style="background:url(https://x)">d</div>'), '<div>d</div>')
})

test('!important is dropped, so a document cannot beat the reader controls', () => {
  assert.equal(safeInlineStyle('font-size: 2em !important'), 'font-size:2em')
})

test('the native and viewer passes keep exactly the same list and rule', () => {
  const js = viewerScript()
  const list = js.slice(js.indexOf('var INLINE_STYLE_PROPS'), js.indexOf('];', js.indexOf('var INLINE_STYLE_PROPS')))
  const viewerProps = [...list.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
  assert.deepEqual(viewerProps, [...INLINE_STYLE_PROPS], 'two sanitisers must agree about their scope')

  const viewer = viewerSafeInlineStyle()
  for (const sample of [
    'text-align:center',
    'color:red;font-style:italic',
    'background:url(x)',
    'font-family:"Iowan Old Style", serif',
    'margin:0 0 1em 2em',
    'font-size:var(--x)',
    'display:none',
  ]) {
    assert.equal(viewer(sample), safeInlineStyle(sample), `passes disagree on: ${sample}`)
  }
})

/* ------------------------------------------------------------ book CSS */

test('book rules are scoped under the content root, nested ones included', () => {
  const css = normalizeBookCss('body { margin: 0 } @media screen { body { display: none } p { text-indent: 1em } }')
  assert.match(css, /#paper\{margin:0\}/)
  assert.match(css, /@media screen\{#paper\{display:none\}\s*#paper p\{text-indent:1em\}\}/)
  assert.doesNotMatch(css, /(^|[^#\w])body\s*\{/, 'no rule may reach the viewer shell')
})

test('colour, line height and reflow-breaking layout are the reader’s', () => {
  const css = normalizeBookCss('p { color: #000; background: #fff; line-height: 1.1; position: absolute; font-style: italic }')
  assert.equal(css, '#paper p{font-style:italic}')
})

test('absolute type becomes relative and !important is gone', () => {
  assert.equal(normalizeBookCss('h1 { font-size: 24px !important }'), '#paper h1{font-size:1.500em}')
})

test('a @font-face keeps a data: source and its descriptors only', () => {
  const data = 'data:font/ttf;base64,AAEC+/='
  const css = normalizeBookCss(`@font-face { font-family: "Book"; src: url("${data}") format("truetype"); font-weight: bold; size-adjust: 90% }`)
  assert.equal(css, `@font-face{font-family:"Book";src:url("${data}") format("truetype");font-weight:bold}`)
})

test('a @font-face whose file was not inlined is dropped, not left pointing nowhere', () => {
  assert.equal(normalizeBookCss('@font-face { font-family: X; src: url(fonts/x.ttf) }'), '')
  assert.equal(normalizeBookCss('@font-face { font-family: X; src: url(https://evil/x.ttf) }'), '')
})

test('other at-rules and remote loads go', () => {
  const css = normalizeBookCss('@import url(https://x); @page { margin: 2cm } @keyframes a { from { color: red } } p { background-image: url(https://x/y.png) }')
  assert.equal(css, '')
})

/* ---------------------------------------------------------------- fonts */

test('fonts are chosen within both budgets, skipping obfuscated ones', () => {
  const items = [
    { href: 'fonts/a.ttf', type: 'application/x-font-ttf' },
    { href: 'fonts/b.otf', type: 'application/vnd.ms-opentype' },
    { href: 'fonts/huge.ttf', type: 'font/ttf' },
    { href: 'fonts/secret.otf', type: 'font/otf' },
    { href: 'images/c.jpg', type: 'image/jpeg' },
  ]
  const sizeOf = new Map([
    ['OEBPS/fonts/a.ttf', 300_000],
    ['OEBPS/fonts/b.otf', 200_000],
    ['OEBPS/fonts/huge.ttf', MAX_FONT_BYTES + 1],
    ['OEBPS/fonts/secret.otf', 100_000],
    ['OEBPS/images/c.jpg', 50_000],
  ])
  const chosen = chooseFonts(items, 'OEBPS/content.opf', sizeOf, new Set(['OEBPS/fonts/secret.otf']))
  assert.deepEqual(chosen, ['OEBPS/fonts/a.ttf', 'OEBPS/fonts/b.otf'])

  const many = Array.from({ length: 20 }, (_, i) => ({ href: `f${i}.ttf`, type: 'font/ttf' }))
  const sizes = new Map(many.map((f) => [f.href, 1_000_000]))
  const total = chooseFonts(many, 'x.opf', sizes, new Set()).length * 1_000_000
  assert.ok(total <= MAX_TOTAL_FONT_BYTES)
})

test('encryption.xml names the obfuscated fonts', () => {
  const xml = `<encryption><enc:EncryptedData><enc:CipherData>
    <enc:CipherReference URI="OEBPS/fonts/My%20Font.otf"/></enc:CipherData></enc:EncryptedData></encryption>`
  assert.deepEqual([...encryptedPaths(xml)], ['OEBPS/fonts/My Font.otf'])
  assert.equal(encryptedPaths(null).size, 0)
})

test('a stylesheet’s font urls resolve against the stylesheet, and become data: URIs', () => {
  const fonts = new Map([['OEBPS/fonts/a.ttf', 'data:font/ttf;base64,QQ==']])
  const css = '@font-face { src: url("../fonts/a.ttf") } p { background: url(../img/x.png) }'
  const out = inlineFontUrls(css, 'OEBPS/styles/book.css', fonts)
  assert.match(out, /url\("data:font\/ttf;base64,QQ=="\)/)
  assert.match(out, /url\(\.\.\/img\/x\.png\)/, 'a URL that is not an inlined font is left for the normaliser')
  assert.equal(resolvePath('OEBPS/styles/book.css', '../fonts/a.ttf'), 'OEBPS/fonts/a.ttf')
  assert.equal(fontMime('x.woff2'), 'font/woff2')
  assert.equal(fontMime('x.otf'), 'font/otf')
})

/* --------------------------------------------------------------- wiring */

test('the book stylesheet travels beside the content, and the viewer installs it', () => {
  const epub = source('renderers/webview/epub.ts')
  assert.doesNotMatch(epub, /`<style>\$\{/, 'no <style> in the content: the viewer would strip it')
  assert.match(epub, /html: chapters\.join\('\\n'\),\s*\n\s*css,/)

  const prepare = source('renderers/webview/prepare.ts')
  assert.match(prepare, /css: book\.css \|\| undefined/)

  const js = viewerScript()
  assert.match(js, /installBookCss\(payload\.css \|\| ''\)/, 'every render installs its own stylesheet, or none')
  assert.match(js, /tag\.textContent = css/, 'as text, never as markup')

  const cache = source('renderers/webview/prepareCache.ts')
  assert.match(cache, /if \(prepared\.css\) bytes \+= prepared\.css\.length \* 2/, 'inlined fonts are budgeted')
  assert.match(source('renderers/webview/diskCache.ts'), /const FORMAT_VERSION = 2/, 'cached books re-parse to gain css')
})

test('a reading font the user chose beats the book’s, except in code', () => {
  const html = buildViewerHtml(THEME, 0)
  assert.match(html, /\.sr-user-font #paper \*:not\(pre\):not\(code\):not\(kbd\):not\(samp\) \{\s*font-family: var\(--sr-font\) !important;/)
  assert.match(viewerScript(), /cl\.add\('sr-user-font'\)/)
})

/* ---------------------------------------------------------- SVG covers */

test('an SVG cover’s image becomes a token the viewer fills', () => {
  const epub = source('renderers/webview/epub.ts')
  assert.match(epub, /body = body\.replace\(\/<image\\b\[\^>\]\*>\/gi/, 'SVG <image> tags are rewritten')
  assert.match(epub, /`<image data-sr-img="\$\{token\}"`/)

  const js = viewerScript()
  const attach = js.slice(js.indexOf('function attachImage'), js.indexOf('function onImageSettled'))
  assert.match(attach, /toLowerCase\(\) === 'image'/)
  assert.match(attach, /setAttribute\('href', url\)/, 'an SVG image takes href, not src')
  assert.match(buildViewerHtml(THEME, 0), /svg\[viewBox\] \{ max-width: 100%; height: auto; \}/)
})

test('the native sanitiser keeps an SVG image and its token', () => {
  const out = sanitizeHtml('<svg viewBox="0 0 10 10"><image data-sr-img="sr-img-0" width="10" height="10"/></svg>')
  assert.match(out, /<image data-sr-img="sr-img-0"/)
})
