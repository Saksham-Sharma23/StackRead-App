import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { canSnippet, snippetFrom, trimToWord } from '../storage/snippet.ts'

/**
 * Card previews for the formats that would otherwise show only a badge.
 *
 * The whole module is a string transform, so all of it is testable here — which
 * is the point of keeping the file reading at the call site. The failure mode
 * being guarded against is not a crash: it is a preview full of `##` and
 * `<div class=`, which looks like a bug in the app rather than like a summary.
 */

test('zip-container formats are not snippetable', () => {
  // Their first bytes are archive headers, not prose. Extracting them means
  // unzipping, which is prepareFile's job.
  assert.equal(canSnippet('docx'), false)
  assert.equal(canSnippet('xlsx'), false)
  assert.equal(canSnippet('pdf'), false)
  assert.equal(canSnippet('epub'), false)
  assert.equal(canSnippet('comic'), false)
  assert.equal(canSnippet('image'), false)
})

test('text-shaped formats are snippetable', () => {
  assert.equal(canSnippet('text'), true)
  assert.equal(canSnippet('markdown'), true)
  assert.equal(canSnippet('csv'), true)
  assert.equal(canSnippet('html'), true)
})

test('plain text collapses its whitespace', () => {
  const out = snippetFrom('The quick brown fox\n\n   jumps over the lazy dog again', 'text')
  assert.equal(out, 'The quick brown fox jumps over the lazy dog again')
})

test('markdown loses its markers but keeps its words', () => {
  const out = snippetFrom('# A Heading\n\nSome **bold** and `code` text that runs on.', 'markdown')
  assert.ok(out)
  assert.ok(!out.includes('#'), 'heading marker survived')
  assert.ok(!out.includes('**'), 'emphasis marker survived')
  assert.ok(!out.includes('`'), 'code marker survived')
  assert.ok(out.startsWith('A Heading'), `unexpected start: ${out}`)
})

test('a markdown link keeps its text and drops its target', () => {
  const out = snippetFrom(
    'See [the documentation](https://example.com/very/long/url) for more detail here.',
    'markdown',
  )
  assert.ok(out)
  assert.ok(out.includes('the documentation'))
  assert.ok(!out.includes('example.com'), 'URL leaked into the preview')
})

test('a markdown image contributes nothing, not its alt text', () => {
  // Alt text surviving would put a caption where the body should be.
  const out = snippetFrom(
    '![a photo of the thing](img.png) The actual body text of this document follows.',
    'markdown',
  )
  assert.ok(out)
  assert.ok(!out.includes('a photo of the thing'), 'alt text leaked')
  assert.ok(out.includes('The actual body text'))
})

test('a fenced code block is dropped entirely', () => {
  const out = snippetFrom(
    'Intro prose that is long enough to matter here.\n\n```js\nconst x = 1\n```\n',
    'markdown',
  )
  assert.ok(out)
  assert.ok(!out.includes('const x'), 'code block leaked into the preview')
})

test('html tags and entities are resolved to text', () => {
  const out = snippetFrom(
    '<p>Hello &amp; welcome to <b>the page</b> you were looking for today.</p>',
    'html',
  )
  assert.equal(out, 'Hello & welcome to the page you were looking for today.')
})

test('script and style contents never reach the preview', () => {
  const out = snippetFrom(
    '<style>.a{color:red}</style><script>alert(1)</script><p>The real readable body text here.</p>',
    'html',
  )
  assert.ok(out)
  assert.ok(!out.includes('color:red'), 'stylesheet leaked')
  assert.ok(!out.includes('alert'), 'script leaked')
  assert.ok(out.includes('The real readable body text'))
})

test('csv separators become spacing, so a row reads as a row', () => {
  const out = snippetFrom('name,quantity,price\nwidget,12,3.50\ngadget,7,9.99', 'csv')
  assert.ok(out)
  assert.ok(!out.includes(','), 'raw commas survived')
  assert.ok(out.includes('name'))
  assert.ok(out.includes('quantity'))
})

test('too little text yields no snippet at all', () => {
  // Two words look like a failed read; the card keeps its badge instead.
  assert.equal(snippetFrom('Hi', 'text'), null)
  assert.equal(snippetFrom('   \n\n  ', 'text'), null)
  assert.equal(snippetFrom('# ', 'markdown'), null)
})

test('markup that cleans away to nothing yields no snippet', () => {
  assert.equal(snippetFrom('<script>var a = 12345678;</script>', 'html'), null)
})

test('trimming breaks on a word boundary and marks the cut', () => {
  const out = trimToWord('alpha beta gamma delta epsilon', 12)
  assert.ok(out.endsWith('…'))
  assert.ok(!out.includes('gam'), `cut mid-word: ${out}`)
})

test('text shorter than the limit is returned untouched', () => {
  assert.equal(trimToWord('short', 40), 'short')
})

test('an unbroken token is hard-cut rather than returned whole', () => {
  // A URL or a base64 blob has no space to break on. Returning it whole would
  // defeat the length bound the card's layout depends on.
  const long = 'x'.repeat(400)
  const out = trimToWord(long, 50)
  assert.ok(out.length <= 51, `not bounded: ${out.length}`)
  assert.ok(out.endsWith('…'))
})

test('a long document is bounded to roughly one card of text', () => {
  const out = snippetFrom('word '.repeat(500), 'text')
  assert.ok(out)
  assert.ok(out.length <= 221, `preview too long: ${out.length}`)
})
