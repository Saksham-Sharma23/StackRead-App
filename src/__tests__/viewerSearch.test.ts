import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { buildViewerHtml } from '../renderers/webview/viewerHtml.ts'

/*
 * P10-1 and P11 — the viewer halves of find-in-document and position anchors.
 *
 * Both live inside the viewer's template literal, which is the one place in
 * this codebase where `tsc` proves nothing: it validates the *string*, and a
 * string containing broken JavaScript is a perfectly good string. So the
 * approach here is the one `viewerHtml.test.ts` established — extract the real
 * emitted functions and *execute* them — rather than asserting that source text
 * contains the right words.
 *
 * The DOM stubs below are deliberately minimal: enough to make a TreeWalker,
 * a Range and a getBoundingClientRect answer plausibly, and no more. Anything
 * richer would be testing the stub.
 */

const THEME = {
  bg: '#000',
  fg: '#fff',
  fgDim: '#888',
  accent: '#09f',
  border: '#333',
  surfaceAlt: '#111',
  surface: '#222',
  gutter: '#0a0a0a',
}

function viewerScript(): string {
  const html = buildViewerHtml(THEME, 0)
  const match = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(match, 'viewer HTML contains no script block')
  return match[1]
}

function source(): string {
  return readFileSync(new URL('../renderers/webview/viewerHtml.ts', import.meta.url), 'utf8')
}

/**
 * A tiny text-node model: each "paragraph" is one text node, laid out at a
 * fixed line height, in document order.
 *
 * That is exactly the shape the anchor code assumes (document order implies
 * increasing vertical position), so it exercises the real path rather than a
 * degenerate one.
 */
function fakeDocument(paragraphs: string[], lineHeight = 100) {
  const nodes = paragraphs.map((text, i) => ({
    nodeValue: text,
    _top: i * lineHeight,
  }))

  const doc = {
    createTreeWalker() {
      let i = -1
      return {
        nextNode() {
          i += 1
          return i < nodes.length ? nodes[i] : null
        },
      }
    },
    createRange() {
      let selected: { _top: number } | null = null
      return {
        selectNodeContents(node: { _top: number }) {
          selected = node
        },
        setStart() {},
        setEnd() {},
        getBoundingClientRect() {
          const top = (selected?._top ?? 0) - state.scrollY
          return { top, bottom: top + lineHeight }
        },
      }
    },
  }

  const state = { scrollY: 0, innerHeight: 400, scrolledTo: 0 }
  return { doc, nodes, state }
}

/**
 * Extracts the anchor functions and runs them against the fake document.
 *
 * `buildTextIndex`, `nodeAt`, `anchorAtTop` and `scrollToAnchor` are sliced out
 * together because they are mutually dependent — the flat index is the shared
 * substrate for both search and anchors, which is the design point.
 */
function anchorHarness(paragraphs: string[]) {
  const js = viewerScript()
  const from = js.indexOf('  /** Flat text index')
  const to = js.indexOf('  /** Removes every highlight')
  assert.ok(from > 0 && to > from, 'could not locate the search/anchor block')
  const src = js.slice(from, to)

  const { doc, state } = fakeDocument(paragraphs)

  const factory = new Function(
    'deps',
    `
    var el = deps.el;
    var document = deps.document;
    var window = deps.window;
    var NodeFilter = { SHOW_TEXT: 4 };
    var post = deps.post;
    var reportPosition = function () {};
    ${src}
    return {
      buildTextIndex: buildTextIndex,
      nodeAt: nodeAt,
      anchorAtTop: anchorAtTop,
      scrollToAnchor: scrollToAnchor,
      textAll: function () { return textAll; }
    };
    `,
  ) as (deps: Record<string, unknown>) => {
    buildTextIndex: () => void
    nodeAt: (pos: number) => { index: number; offset: number } | null
    anchorAtTop: () => number
    scrollToAnchor: (offset: number) => boolean
    textAll: () => string
  }

  const posted: Record<string, unknown>[] = []
  const api = factory({
    el: { querySelectorAll: () => [] },
    document: doc,
    window: {
      get scrollY() {
        return state.scrollY
      },
      get innerHeight() {
        return state.innerHeight
      },
      scrollTo: (_x: number, y: number) => {
        state.scrolledTo = y
        state.scrollY = y
      },
    },
    post: (m: Record<string, unknown>) => posted.push(m),
  })

  return { ...api, state, posted }
}

test('the flat text index concatenates every node in document order', () => {
  const h = anchorHarness(['Hello ', 'world', '!'])
  h.buildTextIndex()
  assert.equal(h.textAll(), 'Hello world!')
})

test('nodeAt maps a character offset back to its node and local offset', () => {
  const h = anchorHarness(['abc', 'defgh', 'ij'])
  h.buildTextIndex()

  assert.deepEqual(h.nodeAt(0), { index: 0, offset: 0 })
  assert.deepEqual(h.nodeAt(2), { index: 0, offset: 2 })
  // First character of the second node.
  assert.deepEqual(h.nodeAt(3), { index: 1, offset: 0 })
  assert.deepEqual(h.nodeAt(7), { index: 1, offset: 4 })
  assert.deepEqual(h.nodeAt(8), { index: 2, offset: 0 })
})

test('nodeAt handles the boundaries rather than running off the ends', () => {
  const h = anchorHarness(['abc'])
  h.buildTextIndex()

  assert.deepEqual(h.nodeAt(0), { index: 0, offset: 0 })
  // Past the end resolves to the last node; a null here would make a restore
  // near the document end silently fail.
  assert.equal(h.nodeAt(99)?.index, 0)
})

test('an anchor taken at the top of the document is the first offset', () => {
  const h = anchorHarness(['alpha', 'beta', 'gamma'])
  h.state.scrollY = 0
  assert.equal(h.anchorAtTop(), 0)
})

test('the anchor tracks the text actually on screen', () => {
  // Three paragraphs at 100px each, 400px viewport. Scrolled to 200 puts the
  // third paragraph ("gamma", offset 9) at the top.
  const h = anchorHarness(['alpha', 'beta', 'gamma'])
  h.state.scrollY = 200

  const offset = h.anchorAtTop()
  assert.equal(offset, 9, `expected the offset of "gamma", got ${offset}`)
})

test('storing and restoring an anchor is a round trip', () => {
  /*
   * The property that matters: take an anchor, move away, restore it, and the
   * same text is at the top.
   *
   * Asserted on the resulting *scroll position*, not just on the offset that
   * comes back. Re-reading the offset is too weak a check — with coarse line
   * spacing a restore can land a fraction of a screen off and still resolve to
   * the same text node, so a mismatched store/restore bias survives it. The
   * pixel position is what actually drifts, and it is what a reader sees creep
   * on every reopen.
   */
  const h = anchorHarness(['alpha', 'beta', 'gamma', 'delta'])

  h.state.scrollY = 200
  const saved = h.anchorAtTop()
  const wasAt = h.state.scrollY

  h.state.scrollY = 0
  assert.equal(h.scrollToAnchor(saved), true)
  assert.equal(h.anchorAtTop(), saved, 'restoring an anchor must land back on it')

  /*
   * The anchored text was 60px below the top edge when the anchor was taken
   * (the 15% bias), so restoring must put it back at the same place. Storing
   * with a bias and restoring without one is off by exactly that much — a fifth
   * of a screen, every single reopen.
   */
  assert.equal(
    h.state.scrollY,
    wasAt - 60,
    'store and restore must use the same bias, or the position creeps on every reopen',
  )
})

test('a restore is stable under repetition', () => {
  // The drift this guards against is cumulative: each reopen re-anchors from
  // wherever the last restore landed. Three round trips must be a fixed point.
  const h = anchorHarness(['alpha', 'beta', 'gamma', 'delta', 'epsilon'])

  h.state.scrollY = 200
  let anchor = h.anchorAtTop()
  const positions: number[] = []

  for (let i = 0; i < 3; i++) {
    h.scrollToAnchor(anchor)
    positions.push(h.state.scrollY)
    anchor = h.anchorAtTop()
  }

  assert.deepEqual(
    positions,
    [positions[0], positions[0], positions[0]],
    `reopening must not creep: got ${positions.join(', ')}`,
  )
})

test('an anchor survives a layout change, which is the whole point', () => {
  /*
   * The bug P11 fixes: scrollY is a position in a *layout*. Rotating or
   * changing the font rewrites that layout, so the same pixel offset is a
   * different place in the book.
   *
   * Here the same document is laid out at a different line height — the effect
   * of a font-size change — and the anchor still names the same text, while the
   * pixel offset that produced it now points somewhere else entirely.
   */
  const before = anchorHarness(['alpha', 'beta', 'gamma', 'delta'])
  before.state.scrollY = 200
  const savedAnchor = before.anchorAtTop()
  const savedPixels = before.state.scrollY

  // Re-laid out: every line is now 160px tall instead of 100px.
  const js = viewerScript()
  const from = js.indexOf('  /** Flat text index')
  const to = js.indexOf('  /** Removes every highlight')
  const src = js.slice(from, to)

  const { doc, state } = fakeDocument(['alpha', 'beta', 'gamma', 'delta'], 160)
  const factory = new Function(
    'deps',
    `
    var el = deps.el;
    var document = deps.document;
    var window = deps.window;
    var NodeFilter = { SHOW_TEXT: 4 };
    var post = function () {};
    var reportPosition = function () {};
    ${src}
    return { anchorAtTop: anchorAtTop, scrollToAnchor: scrollToAnchor };
    `,
  ) as (deps: Record<string, unknown>) => {
    anchorAtTop: () => number
    scrollToAnchor: (o: number) => boolean
  }

  const after = factory({
    el: { querySelectorAll: () => [] },
    document: doc,
    window: {
      get scrollY() {
        return state.scrollY
      },
      get innerHeight() {
        return state.innerHeight
      },
      scrollTo: (_x: number, y: number) => {
        state.scrollY = y
      },
    },
  })

  // The anchor restores to the same *text*.
  assert.equal(after.scrollToAnchor(savedAnchor), true)
  assert.equal(after.anchorAtTop(), savedAnchor, 'the anchor must survive re-layout')

  // The pixel offset, applied to the new layout, does not.
  state.scrollY = savedPixels
  assert.notEqual(
    after.anchorAtTop(),
    savedAnchor,
    'if the raw pixel offset still worked, this test would be proving nothing',
  )
})

test('restoring an unreachable anchor reports failure rather than guessing', () => {
  // With progressive delivery a saved position can name text that has not been
  // appended yet. The caller parks it; it must not silently scroll to 0.
  const h = anchorHarness([])
  assert.equal(h.scrollToAnchor(500), false)
})

test('a negative or non-numeric anchor is rejected', () => {
  const h = anchorHarness(['alpha'])
  assert.equal(h.scrollToAnchor(-1), false)
  assert.equal(h.scrollToAnchor(NaN as unknown as number), false)
})

test('the anchor report is debounced, never posted per scroll frame', () => {
  /*
   * Computing an anchor measures a Range per binary-search probe, each forcing
   * layout. Once on settle is nothing; sixty times a second is ruinous — and
   * this is the app's busiest path, which P6-1 already had to rescue once.
   */
  const js = viewerScript()

  assert.ok(
    /function scheduleAnchorReport\(\)[\s\S]{0,400}setTimeout/.test(js),
    'the anchor report must be debounced',
  )
  /*
   * The per-frame function must *delegate*, not compute.
   *
   * Sliced precisely to reportPosition's own body, and asserted both ways: it
   * calls the debouncer, and it does not call anchorAtTop itself. Checking only
   * that a debouncer exists elsewhere in the file would pass even if the
   * expensive call had been inlined here as well.
   */
  const reportBody = js.slice(
    js.indexOf('function reportPosition'),
    js.indexOf('function scheduleAnchorReport'),
  )
  assert.ok(
    reportBody.includes('scheduleAnchorReport()'),
    'reportPosition must hand the anchor off to the debouncer',
  )
  assert.ok(
    !reportBody.includes('anchorAtTop()'),
    'reportPosition must not compute an anchor inline — it measures Ranges, and this runs at 60fps',
  )
})

test('the emitted viewer still parses with search and anchors in it', () => {
  // Both features are hundreds of lines of browser code inside a TypeScript
  // template literal. This is the only cheap check that they are valid
  // JavaScript — and it caught raw backticks twice while writing them.
  assert.doesNotThrow(() => new Function(viewerScript()))
})

test('highlights are painted from the last match backwards', () => {
  /*
   * Wrapping a match in <mark> mutates the DOM and invalidates every offset
   * after it. Painting forwards would corrupt the position of every subsequent
   * match — the highlights would drift further wrong the further down the page
   * they are, which looks like a rendering bug rather than an ordering one.
   */
  const src = source()
  assert.ok(
    /for \(var i = found\.length - 1; i >= 0; i--\)/.test(src),
    'matches must be painted last-first',
  )
})

test('search rejects an empty query instead of matching everywhere', () => {
  // indexOf('') returns a hit at every position, so without the guard this is
  // an unbounded list of zero-length matches.
  const src = source()
  assert.ok(/if \(!matchQuery\) \{[\s\S]{0,200}return;/.test(src))
})

test('search advances past a rejected whole-word candidate', () => {
  // The `from` cursor moves before the `continue`, or the first rejected
  // candidate spins forever and locks the WebView.
  const src = source()
  const run = src.slice(src.indexOf('function runSearch'), src.indexOf('function goToMatch'))
  const advance = run.indexOf('from = at + needle.length')
  const skip = run.indexOf('continue')
  assert.ok(advance > 0 && advance < skip, 'the cursor must advance before any skip')
})

test('match navigation wraps in both directions', () => {
  // Past the last match is the first; before the first is the last. The double
  // modulo is what makes a negative index wrap rather than going out of range.
  const src = source()
  assert.ok(/\(\(index % matches\.length\) \+ matches\.length\) % matches\.length/.test(src))
})

test('appended content invalidates the text index', () => {
  // Streaming appends new text; an index built before it describes a document
  // that no longer exists, and a search would miss everything after the join.
  const src = source()
  const append = src.slice(src.indexOf('function appendChunk'), src.indexOf('function attachImage'))
  assert.ok(append.includes('textIndexStale = true'), 'appending must stale the index')
})

test('clearing highlights re-normalizes the text it split', () => {
  /*
   * Wrapping splits one text node into three. Without normalize() a second
   * search sees a document fragmented by the first, so offsets stop being
   * comparable between searches — the same query would return different
   * anchors depending on what had been searched before.
   */
  const src = source()
  const clear = src.slice(
    src.indexOf('function clearHighlights'),
    src.indexOf('function cssEscape'),
  )
  assert.ok(clear.includes('parent.normalize()'))
  assert.ok(clear.includes('textIndexStale = true'))
})

test('a match spanning a tag boundary is skipped, not fatal', () => {
  // surroundContents throws when a range partially selects an element — "the
  // <em>cat</em>". One lost highlight is acceptable; a thrown search is not.
  const src = source()
  const run = src.slice(src.indexOf('function runSearch'), src.indexOf('function goToMatch'))
  assert.ok(/try \{[\s\S]*?surroundContents[\s\S]*?\} catch/.test(run))
})

test('the restore path prefers the anchor and keeps the pixel fallback', () => {
  const src = source()
  const render = src.slice(
    src.indexOf('function render(payload)'),
    src.indexOf('function handle(raw)'),
  )

  const anchorAt = render.indexOf('payload.anchor')
  const scrollAt = render.indexOf('payload.scroll')
  assert.ok(anchorAt > 0, 'the payload must carry an anchor')
  assert.ok(scrollAt > 0, 'the pixel offset must survive as a fallback')
  assert.ok(anchorAt < scrollAt, 'the anchor must be tried first')

  /*
   * Ordering alone is too weak: it still passes if the anchor branch has been
   * disabled and merely left in place above the fallback. Assert the guard is
   * a live check on the payload, and that a successful restore short-circuits
   * the pixel path rather than falling through to it — running both would
   * scroll twice and land on the fallback's answer.
   */
  assert.ok(
    /if \(typeof payload\.anchor === 'number' && payload\.anchor > 0\) \{/.test(render),
    'the anchor branch must be a live condition on the payload',
  )
  assert.ok(
    /if \(scrollToAnchor\(payload\.anchor\)\) \{[\s\S]{0,200}?return;/.test(render),
    'a successful anchor restore must return rather than also applying the pixel offset',
  )
})

test('an unreachable anchor is parked for streaming content', () => {
  const src = source()
  assert.ok(/if \(payload\.streaming\) pendingAnchor = payload\.anchor/.test(src))

  const append = src.slice(src.indexOf('function appendChunk'), src.indexOf('function attachImage'))
  assert.ok(
    /pendingAnchor > 0 && scrollToAnchor\(pendingAnchor\)/.test(append),
    'appended content must retry a parked anchor',
  )
})
