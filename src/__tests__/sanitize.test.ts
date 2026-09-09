import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sanitizeHtml } from '../renderers/webview/sanitize.ts'

/*
 * The native-side pre-sanitiser.
 *
 * Every case below is a payload that could arrive inside an EPUB, a DOCX, or a
 * saved .html file — all three are documents from arbitrary sources. The two
 * halves matter equally: the attack cases must be neutralised, and the benign
 * case must come through untouched, because a sanitiser that quietly mangles
 * ordinary books is a worse bug than the one it prevents.
 */

/** Asserts the payload no longer contains its executable part. */
function blocks(name: string, input: string, forbidden: string) {
  test(`blocks ${name}`, () => {
    const out = sanitizeHtml(input).toLowerCase()
    assert.ok(
      !out.includes(forbidden.toLowerCase()),
      `expected ${forbidden} to be removed, got: ${out}`,
    )
  })
}

blocks('script elements', '<p>hi</p><script>alert(1)</script>', 'alert')
blocks('unterminated script tags', '<script src="x.js">', 'script')
blocks('bare onerror handlers', '<img src=x onerror=alert(1)>', 'onerror')
blocks('quoted onerror handlers', '<img src="x" onerror="alert(1)">', 'onerror')
blocks('namespaced SVG handlers', '<svg><a ev:onload="alert(1)"/></svg>', 'onload')
blocks('xlink javascript URLs', '<svg><a xlink:href="javascript:alert(1)">x</a></svg>', 'javascript:')
blocks('entity-padded schemes', '<a href="java&#09;script:alert(1)">x</a>', 'script:')
blocks('inline style attributes', '<p style="background:url(http://evil/x)">t</p>', 'style=')
blocks('style elements', '<style>@import url(http://evil)</style><p>t</p>', '@import')
blocks('iframes', '<iframe src="http://evil"></iframe>', 'iframe')
blocks('handlers hidden in comments', '<!-- <img onerror=alert(1)> --><p>t</p>', 'onerror')
blocks('data:text/html navigation', '<a href="data:text/html;base64,PHM+">x</a>', 'data:text/html')

test('leaves ordinary book markup byte-identical', () => {
  // Deliberately exercises the constructs a real chapter uses and that the
  // regexes above come closest to catching: a class attribute (near `style`),
  // an inlined data: image (near the URL scheme check), and a fragment link.
  const benign =
    '<p class="c">Hello <em>world</em></p>' +
    '<img src="data:image/png;base64,AAA">' +
    '<a href="#ch2">Ch 2</a>'
  assert.equal(sanitizeHtml(benign), benign)
})

test('keeps chapter structure when stripping an attribute', () => {
  // The element and its text must survive — only the handler goes.
  assert.equal(sanitizeHtml('<p onclick="x()">text</p>'), '<p>text</p>')
})


/*
 * Q4-1 — parity between the two sanitising passes.
 *
 * The app sanitises untrusted markup twice: this regex pre-pass on the native
 * side, and a DOM pass inside the viewer. They are not redundant — the pre-pass
 * runs *before* the markup crosses the bridge, and the DOM pass cannot be
 * fooled by malformed nesting — but they only add up to defence in depth if
 * neither has a gap the other is assumed to cover.
 *
 * They did. The viewer's scheme check tested a value that had only been trimmed
 * and lowercased, with no entity decoding and no control-character stripping,
 * so `java&#09;script:` passed it; and it checked only `href`/`src`, missing
 * `xlink:href`. Neither was exploitable — the pre-pass caught both, and the
 * WebView refuses navigation anyway — but `sanitize.ts`'s own header called the
 * DOM pass "the stronger of the two", which is how a later refactor deletes the
 * wrong layer.
 *
 * These tests pin the pre-pass's behaviour. The viewer's half is verified in
 * `viewerHtml.test.ts`, which can execute the emitted script.
 */

blocks(
  'an entity-padded scheme (java&#09;script:)',
  '<a href="java&#09;script:alert(1)">x</a>',
  'java&#09;script:',
)

blocks(
  'a hex-entity-padded scheme',
  '<a href="java&#x09;script:alert(1)">x</a>',
  'java&#x09;script:',
)

blocks(
  'an entity-encoded colon',
  '<a href="javascript&#58;alert(1)">x</a>',
  'javascript&#58;',
)

blocks(
  'a javascript: target on xlink:href',
  '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  'javascript:',
)

blocks(
  'a namespaced event handler',
  '<svg><circle ev:onload="alert(1)" r="5"/></svg>',
  'ev:onload',
)

test('the benign attributes those payloads share are still allowed', () => {
  /*
   * The other half of every sanitiser test: over-removal is a real bug too. An
   * SVG that legitimately links to a chapter, and an image carried as a data
   * URI, are both ordinary content in the books this app opens — the blob and
   * data mechanisms the viewer uses for images depend on them surviving.
   */
  const ok = '<svg><a xlink:href="chapter2.xhtml"><text>Next</text></a></svg>'
  assert.ok(
    sanitizeHtml(ok).includes('chapter2.xhtml'),
    'an ordinary xlink:href must survive — stripping it would break SVG navigation in real books',
  )

  const img = '<img src="data:image/png;base64,iVBORw0KGgo=" alt="">'
  assert.ok(
    sanitizeHtml(img).includes('data:image/png'),
    'a data: image must survive; only data:text/html is executable',
  )
})
