import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/*
 * R6-6 — the archive text-preview path escapes, and must keep escaping.
 *
 * `TEXT_RE` in `prepare.ts` matches `.html`, `.js`, `.ts` and `.css`, and the
 * branch it guards inlines those entries' bytes straight into the document the
 * viewer renders. That is safe for exactly one reason: `escapeHtml`. A ZIP with
 * an `index.html` in it is an ordinary archive, and the viewer would run its
 * scripts if the markup arrived as markup.
 *
 * `sanitizeHtml` is imported into the same file for the EPUB and DOCX paths,
 * which is what makes this worth a test rather than a comment. Swapping one for
 * the other "for consistency" is a one-line change that compiles, passes every
 * other test, and turns a ZIP listing into an injection vector.
 *
 * `prepare.ts` imports `expo-file-system` and cannot load under Node, so
 * `escapeHtml` is reproduced from source below and exercised directly — the
 * assertion that it is *still the function on that path* is structural.
 */

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

const prepare = source('renderers/webview/prepare.ts')

/** `escapeHtml`, lifted from `prepare.ts` and evaluated, so the real body is under test. */
const escapeHtml = (() => {
  const body = /function escapeHtml\(s: string\): string \{([\s\S]*?)\n\}/.exec(prepare)?.[1]
  assert.ok(body, 'escapeHtml must still exist in prepare.ts')
  // The only TypeScript in the body is a trailing `as string`; stripping it
  // leaves valid JavaScript, which keeps this testing the real implementation
  // rather than a copy that can drift.
  return new Function('s', `${body.replace(/ as string/g, '')}`) as (s: string) => string
})()

test('a script tag inside an archived .html entry renders as literal text', () => {
  const attack = '<script>alert(1)</script>'
  const out = escapeHtml(attack)

  assert.ok(!out.includes('<script'), 'the opening tag must not survive as markup')
  assert.ok(!out.includes('</script'), 'the closing tag must not survive as markup')
  assert.equal(
    out,
    '&lt;script&gt;alert(1)&lt;/script&gt;',
    'the entry must be shown as the text it is — this is a listing, not a render',
  )
})

test('escapeHtml covers every character that can break out of the preview', () => {
  // `<` and `>` open tags; `"` and `'` break out of an attribute value; `&`
  // must be first, or the escapes below are themselves double-escaped.
  assert.equal(escapeHtml('&'), '&amp;')
  assert.equal(escapeHtml('<'), '&lt;')
  assert.equal(escapeHtml('>'), '&gt;')
  assert.equal(escapeHtml('"'), '&quot;')
  assert.equal(escapeHtml("'"), '&#39;')

  // Ampersand first: escaping `<` before `&` would turn `<` into `&amp;lt;`.
  assert.equal(escapeHtml('<&>'), '&lt;&amp;&gt;', 'the ampersand must be escaped first')

  // An entry name is interpolated into the same row and needs the same guard.
  assert.equal(
    escapeHtml('a"b\'c'),
    'a&quot;b&#39;c',
    'quotes must be escaped — the file name lands next to an attribute',
  )
})

test('the archive text branch still escapes rather than sanitises', () => {
  const branch = prepare.slice(
    prepare.indexOf('if (entry && TEXT_RE.test(p)'),
    prepare.indexOf('rows.push(`<div class="sr-chapter">${head}</div>`)'),
  )
  assert.ok(branch.length > 0, 'the text-preview branch must still exist')

  assert.ok(
    branch.includes('escapeHtml(strFromU8(entry))'),
    'the entry bytes must go through escapeHtml',
  )
  assert.ok(
    !branch.includes('sanitizeHtml'),
    'sanitizeHtml keeps markup working and removes what it believes is dangerous — the ' +
      'opposite of what a listing needs, and it is imported into this same file',
  )
  assert.ok(
    branch.includes('<pre><code>'),
    'the preview must stay inside a pre/code block, which is what makes escaped text read correctly',
  )

  // The entry name is attacker-influenced too: a ZIP can contain a path with
  // markup in it, and `head` is interpolated into the same row.
  const head = /const head = `<h3>\$\{([^}]*)\}<\/h3>/.exec(prepare)?.[1] ?? ''
  assert.ok(
    head.includes('escapeHtml('),
    'the entry path must be escaped too — a ZIP can name a file `<img onerror=...>`',
  )
})

test('TEXT_RE covers the extensions that make escaping load-bearing', () => {
  const src = /const TEXT_RE = (\/.*\/i)/.exec(prepare)?.[1]
  assert.ok(src, 'TEXT_RE must still be a literal regex')

  // Rebuilt from source rather than imported, for the same reason as above.
  const TEXT_RE = new Function(`return ${src}`)() as RegExp

  // If any of these stops matching, this path stopped inlining that file type
  // and the guard above is about something that no longer happens — which is a
  // reason to revisit the test, not to delete the escaping.
  for (const name of ['index.html', 'a.htm', 'main.js', 'app.ts', 'style.css']) {
    assert.ok(TEXT_RE.test(name), `${name} is inlined as text and must stay escaped`)
  }
})
