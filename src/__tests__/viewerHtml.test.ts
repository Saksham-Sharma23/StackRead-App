import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildViewerHtml } from '../renderers/webview/viewerHtml.ts'

/*
 * The viewer is one large TypeScript template literal containing a whole
 * browser-side program, which creates a failure mode `tsc` cannot see: the type
 * checker validates the *string*, not the JavaScript inside it.
 *
 * A single-escaped regex is the concrete trap. Written `/data:text\/html/`, TS
 * consumes the backslash and the browser receives `/data:text/html/` — an
 * unterminated literal, a syntax error, and a viewer that renders nothing at
 * all. It passes typecheck, passes review, and fails only on device. Existing
 * code in that file doubles every backslash (`/^\\s*$/`) for exactly this
 * reason; these tests make the requirement enforceable rather than remembered.
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

test('the emitted viewer script is syntactically valid JavaScript', () => {
  // The whole point: parse what the WebView will actually be handed.
  assert.doesNotThrow(() => new Function(viewerScript()))
})

test('the viewer parses with timing enabled as well as disabled', () => {
  /*
   * `debug` is on for every dev build, so the instrumented viewer is the one
   * that actually runs during development — and it is emitted by a different
   * branch of the same template literal. A syntax error reachable only with
   * timing on would therefore break the viewer for everyone working on it while
   * every test here passed, which is precisely the failure mode this file
   * exists to prevent.
   *
   * The two modes differ by one interpolated boolean and nothing else, and that
   * is asserted rather than assumed: it is the property that lets the rest of
   * this suite test one mode and cover both.
   */
  for (const debug of [false, true]) {
    const html = buildViewerHtml(THEME, 0, debug)
    const match = html.match(/<script>([\s\S]*?)<\/script>/)
    assert.ok(match, `viewer HTML contains no script block (debug=${debug})`)
    assert.doesNotThrow(
      () => new Function(match[1]),
      `the emitted viewer script does not parse with debug=${debug}`,
    )
    assert.match(match[1], debug ? /var SR_DEBUG = true;/ : /var SR_DEBUG = false;/)
  }

  const off = buildViewerHtml(THEME, 0, false)
  const on = buildViewerHtml(THEME, 0, true)
  assert.equal(
    off.replace('var SR_DEBUG = false;', 'var SR_DEBUG = true;'),
    on,
    'timing must gate a value, not a code path — otherwise this suite only ever tests one viewer',
  )
})

test('the viewer reports both boot and ready', () => {
  // Two distinct signals. `boot` means the script is listening and gates
  // pushing content in; `ready` means the document is rendered and measured and
  // gates seeks and style updates. Dropping either one silently breaks TOC
  // jumps and font changes issued right after opening a file.
  const js = viewerScript()
  assert.match(js, /type:\s*'boot'/)
  assert.match(js, /type:\s*'ready'/)
})

test('the viewer reports pinch scale', () => {
  // The pager disables horizontal paging while zoomed. Without this the WebView
  // never reports zoom, and a horizontal drag on a zoomed spreadsheet flips to
  // the next file instead of panning.
  const js = viewerScript()
  assert.match(js, /visualViewport/)
  assert.match(js, /type:\s*'scale'/)
})

test('markdown link targets cannot carry an executable scheme', () => {
  // Markdown is escaped before rendering, but the link rewriter then builds a
  // real href out of the escaped text — so the scheme has to be checked where
  // the attribute is constructed, not before.
  const js = viewerScript()
  const fns = js.slice(js.indexOf('function escapeHtml'), js.indexOf('function sanitize('))
  const { renderMarkdown } = new Function(
    `${fns}; return { renderMarkdown: renderMarkdown };`,
  )() as { renderMarkdown: (s: string) => string }

  for (const payload of [
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '![x](javascript:alert(1))',
  ]) {
    assert.doesNotMatch(
      renderMarkdown(payload).toLowerCase(),
      /javascript:/,
      `executable scheme survived: ${payload}`,
    )
  }
})

test('ordinary markdown links still work', () => {
  const js = viewerScript()
  const fns = js.slice(js.indexOf('function escapeHtml'), js.indexOf('function sanitize('))
  const { renderMarkdown } = new Function(
    `${fns}; return { renderMarkdown: renderMarkdown };`,
  )() as { renderMarkdown: (s: string) => string }

  assert.match(renderMarkdown('[ok](#ch2)'), /href="#ch2"/)
  assert.match(renderMarkdown('[ok](https://example.com/a)'), /href="https:\/\/example\.com\/a"/)
})

/**
 * Pulls `anchorIndexAt` out of the emitted viewer.
 *
 * Sliced by name rather than re-implemented, so the test exercises the code the
 * WebView actually runs — a copy here would pass while the shipped version was
 * broken.
 */
function anchorIndexAt(): (anchors: number[], y: number) => number {
  const js = viewerScript()
  const fn = js.slice(js.indexOf('function anchorIndexAt'), js.indexOf('function currentPage'))
  return new Function(`${fn}; return anchorIndexAt;`)() as (a: number[], y: number) => number
}

/** The linear scan this replaced, kept as the reference implementation. */
function linearIndexAt(anchors: number[], y: number): number {
  let page = 1
  for (let i = 0; i < anchors.length; i++) {
    if (anchors[i] <= y) page = i + 1
    else break
  }
  return Math.max(1, page)
}

test('binary anchor search agrees with the linear scan it replaced', () => {
  // The scan ran on every scroll frame, so a long book cost a comparison per
  // page per frame. Binary search is only safe because `offsetTop` values are
  // collected in document order and are therefore sorted — this pins that the
  // swap changed the cost and not the answer.
  const search = anchorIndexAt()

  // Irregular gaps: real chapters are not evenly spaced, and equal-value
  // neighbours (two anchors at the same offsetTop) are the case a naive
  // bisection gets wrong.
  const anchors = [0, 40, 40, 120, 300, 301, 900, 1500, 1500, 1501, 4000]

  for (let y = -50; y <= 4200; y += 7) {
    assert.equal(
      search(anchors, y),
      linearIndexAt(anchors, y),
      `disagreement at y=${y}`,
    )
  }
})

test('binary anchor search handles the degenerate arrays', () => {
  const search = anchorIndexAt()

  // Above the first anchor is still page one — never 0, which would render as
  // a blank page indicator.
  assert.equal(search([0, 100], -10), 1)
  assert.equal(search([500], 0), 1)
  // Single anchor, scrolled past it.
  assert.equal(search([500], 900), 1)
  // Exactly on a boundary counts as having reached it.
  assert.equal(search([0, 100, 200], 100), 2)
  assert.equal(search([0, 100, 200], 200), 3)
  // Past the end clamps to the last page.
  assert.equal(search([0, 100, 200], 99999), 3)
})

test('the viewer stays locked down', () => {
  // These are load-bearing security properties, not styling. The viewer must
  // not gain a way to reach the network or the filesystem by accident.
  const html = buildViewerHtml(THEME, 0)
  assert.doesNotMatch(html, /<script[^>]+src=/i, 'viewer loads an external script')
  assert.doesNotMatch(html, /https?:\/\/(?!example\.com)/i, 'viewer references a remote origin')
})

/**
 * Runs the viewer's real `reportPosition` against stubbed geometry.
 *
 * Sliced out of the emitted script rather than reimplemented, for the same
 * reason as `anchorIndexAt` above: a copy here would keep passing while the
 * shipped viewer regressed. The dependencies it closes over (`currentPage`,
 * `totalPages`, `progress`, `currentLabel`, `post`, `window`) are supplied as
 * parameters, so the harness controls what "moved" means.
 */
function reportPositionHarness() {
  const js = viewerScript()
  const src = js.slice(js.indexOf('  var lastCurrent'), js.indexOf('  var ticking'))

  const factory = new Function(
    'deps',
    `
    var post = deps.post;
    var window = deps.window;
    var currentPage = deps.currentPage;
    var totalPages = deps.totalPages;
    var progress = deps.progress;
    var currentLabel = deps.currentLabel;
    // reportPosition also schedules a debounced anchor report (P11). That path
    // measures DOM ranges, which this harness has no document for — and being a
    // timer, it would fire after the test ended and surface as an unhandled
    // rejection rather than a failure. Stubbed so this test keeps measuring the
    // one thing it is about: which frames cross the bridge.
    var scheduleAnchorReport = function () {};
    ${src}
    return reportPosition;
    `,
  ) as (deps: Record<string, unknown>) => (force?: boolean) => void

  const posted: Array<Record<string, number>> = []
  const state = { page: 1, total: 10, scrollY: 0 }

  const reportPosition = factory({
    post: (m: Record<string, number>) => posted.push(m),
    window: {
      get scrollY() {
        return state.scrollY
      },
    },
    currentPage: () => state.page,
    totalPages: () => state.total,
    progress: () => state.scrollY / 1000,
    currentLabel: () => String(state.page),
  })

  return { reportPosition, posted, state }
}

test('an unchanged scroll frame posts nothing across the bridge', () => {
  /*
   * This is the busiest path in the app. Every 'pos' message is a JSON string
   * over the bridge that the native side answers with MMKV reads, MMKV writes
   * and a Zustand set — and during a flick most frames land on the same page,
   * because a page is hundreds of pixels tall.
   *
   * Pinned as a test because it is invisible: dropping the comparison would
   * cost frames on device while every existing test still passed.
   */
  const { reportPosition, posted } = reportPositionHarness()

  reportPosition()
  assert.equal(posted.length, 1, 'the first report must always send')

  // Same position, many frames — exactly what holding a finger still produces.
  for (let i = 0; i < 60; i++) reportPosition()
  assert.equal(posted.length, 1, 'an unchanged frame crossed the bridge')
})

test('sub-pixel scroll drift does not defeat the comparison', () => {
  /*
   * Momentum scrolling produces fractional offsets, so comparing the raw float
   * would differ on every frame and the coalescing above would never fire —
   * the optimization would be present in the source and absent in effect.
   */
  const { reportPosition, posted, state } = reportPositionHarness()

  state.scrollY = 400
  reportPosition()
  const baseline = posted.length

  for (const drift of [400.1, 400.25, 400.4, 400.49]) {
    state.scrollY = drift
    reportPosition()
  }
  assert.equal(posted.length, baseline, 'sub-pixel drift crossed the bridge')

  // A real whole-pixel move must still report.
  state.scrollY = 402
  reportPosition()
  assert.equal(posted.length, baseline + 1, 'a real scroll was swallowed')
})

test('a page change always reports, and a forced report bypasses the check', () => {
  const { reportPosition, posted, state } = reportPositionHarness()

  reportPosition()
  const baseline = posted.length

  // Crossing a page boundary is the event the indicator exists to show.
  state.page = 2
  reportPosition()
  assert.equal(posted.length, baseline + 1, 'a page change was swallowed')

  /*
   * `force` is what a seek uses. Landing where you already were still has to
   * confirm arrival, or the native side waits forever on a jump it believes
   * never completed.
   */
  reportPosition(true)
  assert.equal(posted.length, baseline + 2, 'a forced report was swallowed')
})


/*
 * Q4-1 — the viewer's own scheme check.
 *
 * This is the half of the parity work that actually changed code. The DOM pass
 * inside the viewer tested `/^(javascript|data:text\/html|vbscript):/` against a
 * value that had only been `.trim().toLowerCase()`'d, so an entity-padded
 * scheme walked straight past it, and it inspected only `href`/`src`, missing
 * `xlink:href`.
 *
 * Executed rather than pattern-matched: the viewer is a template literal, so
 * the only honest check is to pull the emitted functions out and run them. That
 * is the same technique the file uses above, and it is what catches the class of
 * break where the TypeScript is valid and the JavaScript inside the string is
 * not.
 */

/** Extracts one `function name(...) { ... }` from the emitted script. */
function emittedFunction(name: string): string {
  const js = viewerScript()
  const at = js.indexOf('function ' + name + '(')
  assert.ok(at >= 0, `the viewer no longer defines ${name}()`)

  const open = js.indexOf('{', at)
  let depth = 0
  for (let j = open; j < js.length; j++) {
    if (js[j] === '{') depth += 1
    else if (js[j] === '}') {
      depth -= 1
      if (depth === 0) return js.slice(at, j + 1)
    }
  }
  throw new Error(`unbalanced braces in ${name}()`)
}

function schemeHelpers(): {
  isUrlAttr: (a: string) => boolean
  isExecutableScheme: (v: string) => boolean
} {
  const factory = new Function(
    emittedFunction('isUrlAttr') +
      '\n' +
      emittedFunction('isExecutableScheme') +
      '\nreturn { isUrlAttr: isUrlAttr, isExecutableScheme: isExecutableScheme };',
  ) as () => {
    isUrlAttr: (a: string) => boolean
    isExecutableScheme: (v: string) => boolean
  }
  return factory()
}

test('the viewer sees through entity and control-character padding', () => {
  const { isExecutableScheme } = schemeHelpers()

  /*
   * The browser's URL parser decodes these before deciding what to do, so a
   * check comparing against the raw string is checking a different value from
   * the one that will actually be used. `java&#09;script:` is the case the old
   * implementation missed.
   */
  for (const payload of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)',
    'java&#09;script:alert(1)',
    'java&#x09;script:alert(1)',
    'javascript&#58;alert(1)',
    'java\tscript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
  ]) {
    assert.equal(
      isExecutableScheme(payload),
      true,
      `${JSON.stringify(payload)} must be recognised as executable`,
    )
  }
})

test('the viewer still allows the URLs a book legitimately uses', () => {
  const { isExecutableScheme } = schemeHelpers()

  /*
   * Over-blocking is the other failure mode, and here it would be severe:
   * `data:` and `blob:` are how every image in this app reaches the viewer, so
   * a check that rejected them would blank every illustration, comic page and
   * archive preview.
   */
  for (const url of [
    'https://example.com',
    '/chapter2.xhtml',
    '#footnote-3',
    'mailto:a@b.c',
    'data:image/png;base64,iVBORw0KGgo=',
    'blob:abc-123',
    '',
  ]) {
    assert.equal(
      isExecutableScheme(url),
      false,
      `${JSON.stringify(url)} must be left alone`,
    )
  }
})

test('the viewer checks the same URL attributes as the native pre-pass', () => {
  const { isUrlAttr } = schemeHelpers()

  // The pre-pass in sanitize.ts covers exactly these. Two sanitisers that
  // disagree about their own scope are worse than one, because the gap is
  // invisible in both.
  for (const attr of ['href', 'src', 'action', 'formaction', 'data', 'poster']) {
    assert.equal(isUrlAttr(attr), true, `${attr} must be treated as a URL attribute`)
  }
  for (const attr of ['class', 'id', 'alt', 'title', 'width']) {
    assert.equal(isUrlAttr(attr), false, `${attr} is not a URL attribute`)
  }
})

test('the viewer strips namespaced handlers and xlink URLs by local name', () => {
  const js = viewerScript()

  /*
   * `name.indexOf('on') === 0` misses `ev:onload`, and an attribute-name test
   * of `name === 'href'` misses `xlink:href`. Both are handled by reducing the
   * name to its local part first, which is what these assert.
   */
  assert.ok(
    /var local = name\.indexOf\(':'\) >= 0 \? name\.slice\(name\.indexOf\(':'\) \+ 1\) : name/.test(js),
    'the DOM pass must reduce an attribute name to its local part',
  )
  assert.ok(
    /local\.indexOf\('on'\) === 0/.test(js),
    'event handlers must be matched on the local name, so ev:onload is caught',
  )
  assert.ok(
    /isUrlAttr\(local\) && isExecutableScheme\(/.test(js),
    'URL attributes must be matched on the local name and tested with the decoding check',
  )
})

/**
 * Runs the viewer's real `measureImpl` against a stubbed DOM.
 *
 * Sliced out of the emitted script rather than reimplemented, for the same
 * reason as `reportPosition` above: a copy here would keep passing while the
 * shipped viewer regressed — and the property under test is precisely that an
 * incremental measure agrees with a full one, which a reimplementation would
 * satisfy by construction.
 *
 * The anchors are given fixed offsets, so "an append does not move what came
 * before it" is modelled exactly as the DOM behaves for appended content.
 */
function measureHarness() {
  const js = viewerScript()
  const src = js.slice(js.indexOf('  function measureImpl('), js.indexOf('  function totalPages('))

  const anchors: { top: number; label: string }[] = []

  const factory = new Function(
    'deps',
    `
    var mode = 'paper';
    var pageHeight = 0;
    var itemTops = [];
    var measuredItems = 0;
    var pbTops = [];
    var pbLabels = [];
    var measuredAnchors = 0;
    var scrollRange = 0;
    var PAGE_ASPECT = 1.414;
    var MAX_PAPER_WIDTH = 704;
    var window = deps.window;
    var document = deps.document;
    var el = deps.el;
    ${src}
    return {
      measure: measureImpl,
      read: function () { return { tops: pbTops.slice(), labels: pbLabels.slice() }; },
    };
    `,
  ) as (deps: Record<string, unknown>) => {
    measure: (incremental?: boolean) => void
    read: () => { tops: number[]; labels: string[] }
  }

  const harness = factory({
    window: { innerWidth: 400, innerHeight: 800 },
    document: { body: { scrollHeight: 10000 } },
    el: {
      style: {},
      querySelectorAll: (sel: string) =>
        sel === '.sr-pb'
          ? anchors.map((a) => ({
              offsetTop: a.top,
              getAttribute: () => a.label,
            }))
          : [],
    },
  })

  return {
    /** Appends anchors, as a delivered batch does. */
    append(count: number) {
      for (let i = 0; i < count; i++) {
        anchors.push({ top: anchors.length * 100, label: 'p' + (anchors.length + 1) })
      }
    },
    ...harness,
  }
}

test('measuring in batches agrees with one full measure', () => {
  /*
   * The property R3-1 rests on.
   *
   * `appendChunk` calls `measure(true)` once per delivered batch and reads only
   * the anchors that arrived — which is correct exactly while appending cannot
   * move what came before it. If that ever stops holding, a streamed book
   * reports different page positions than the same book delivered whole, and
   * the failure is invisible short of counting pages by hand.
   */
  const streamed = measureHarness()
  streamed.append(3)
  streamed.measure(false)
  streamed.append(4)
  streamed.measure(true)
  streamed.append(5)
  streamed.measure(true)

  const whole = measureHarness()
  whole.append(12)
  whole.measure(false)

  assert.deepEqual(streamed.read(), whole.read())
  assert.equal(streamed.read().tops.length, 12)
})

test('a full measure rebuilds from scratch rather than appending to itself', () => {
  /*
   * The other half. A resize, a font change or an image finishing decode moves
   * anchors that were already measured, so those call sites pass no flag and
   * must start over — if a full measure appended instead, the arrays would
   * double and every page number past the first would be wrong.
   */
  const h = measureHarness()
  h.append(5)
  h.measure(false)
  h.measure(false)
  h.measure(false)

  assert.equal(h.read().tops.length, 5, 'repeated full measures must not accumulate')
})

test('an incremental measure with nothing new is a no-op', () => {
  // `appendChunk` can be called with a batch carrying no anchors at all.
  const h = measureHarness()
  h.append(4)
  h.measure(false)
  const before = h.read()
  h.measure(true)

  assert.deepEqual(h.read(), before)
})

/* ==================== the first-paint island (R3-2) ==================== */

const SAMPLE_PAYLOAD = {
  format: 'html',
  content: '<p>hello</p>',
  mode: 'paper',
  totalPages: 3,
  scroll: 0,
  anchor: 0,
  settings: { fontSize: 17, lineHeight: 1.65, margin: 22, paper: '#fff', ink: '#000' },
}

function island(html: string): string | null {
  const m = html.match(/<script id="sr-initial" type="application\/json">([\s\S]*?)<\/script>/)
  return m ? m[1] : null
}

test('no island is emitted when the host has nothing to inline', () => {
  // A cold open still gets an empty shell and the message path.
  assert.equal(island(buildViewerHtml(THEME, 0)), null)
  assert.equal(island(buildViewerHtml(THEME, 0, false)), null)
})

test('an inlined payload round-trips through the island', () => {
  const html = buildViewerHtml(THEME, 0, false, SAMPLE_PAYLOAD)
  const raw = island(html)
  assert.ok(raw, 'no island emitted for an inlined payload')
  assert.deepEqual(JSON.parse(raw), SAMPLE_PAYLOAD)
})

test('content cannot break out of the island', () => {
  /*
   * The one injection risk this design carries.
   *
   * A JSON island is read as raw text by the HTML parser, and the *only*
   * sequence that ends it is `</script`. Content comes from arbitrary files —
   * an EPUB chapter, a saved web page — so a document containing that literal
   * would otherwise terminate the block early and drop the rest of itself into
   * the document as live markup.
   *
   * Escaping `<` to `\u003c` inside the JSON is what prevents it, and it is
   * content-preserving: `JSON.parse` decodes it straight back.
   */
  const hostile = {
    ...SAMPLE_PAYLOAD,
    content: '</script><img src=x onerror=alert(1)><script>alert(2)</script>',
  }
  const html = buildViewerHtml(THEME, 0, false, hostile)

  const raw = island(html)
  assert.ok(raw, 'the island was terminated early by the payload')
  assert.deepEqual(JSON.parse(raw), hostile, 'escaping must preserve the content exactly')

  // And nothing escaped into the document as markup.
  assert.doesNotMatch(raw, /<\/script/i, 'a raw closing tag survived into the island')
  assert.doesNotMatch(raw, /<img/i, 'a raw tag survived into the island')
})

test('every < in a payload is escaped, not just the dangerous one', () => {
  // Blanket escaping rather than matching `</script` specifically: the HTML
  // parser has more ways to end a raw-text element than a regex should be
  // trusted to enumerate.
  const html = buildViewerHtml(THEME, 0, false, {
    ...SAMPLE_PAYLOAD,
    content: '<p>a < b</p><div>x</div>',
  })
  const raw = island(html)!
  assert.doesNotMatch(raw, /</, 'an unescaped < reached the island')
  assert.ok(
    raw.includes(String.fromCharCode(92) + 'u003c'),
    'the escape is not being applied at all',
  )
})

test('the emitted viewer still parses with an island present', () => {
  // The island sits outside the program, but the boot code that reads it does
  // not — so this is the same guarantee the top of this file exists for.
  const html = buildViewerHtml(THEME, 0, true, SAMPLE_PAYLOAD)
  const match = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(match, 'viewer HTML contains no program block')
  assert.doesNotThrow(() => new Function(match[1]))
})

test('boot is still posted when a payload is inlined', () => {
  /*
   * The handshake is not what the island replaces — the content push is.
   *
   * If `boot` stopped firing, a host that had inlined a payload would be fine
   * and a host that had not would hang forever waiting for it. Keeping the
   * signal unconditional means the two sides can disagree about inlining and
   * still render, once, rather than not at all.
   */
  const js = buildViewerHtml(THEME, 0, false, SAMPLE_PAYLOAD).match(
    /<script>([\s\S]*?)<\/script>/,
  )![1]
  assert.match(js, /post\(\{ type: 'boot'/)
  assert.match(js, /getElementById\('sr-initial'\)/)
})

/* ==================== streamed batches (R3-3) ==================== */

test('the viewer exposes __srAppend and no longer handles an append message', () => {
  /*
   * Batches now arrive through `injectJavaScript`, which calls this by name.
   * The message branch that used to serve them is gone rather than left as a
   * fallback: both halves ship in the same bundle — the viewer *is* a template
   * literal in the same file — so there is no version skew for it to absorb,
   * and an unreachable branch is the dead code R6-5 exists to remove.
   */
  const js = viewerScript()
  assert.match(js, /window\.__srAppend = function/)
  assert.doesNotMatch(js, /msg\.type === 'append'/)
})

test('a batch survives the base64 round trip with real book characters', async () => {
  /*
   * The encode and decode live on opposite sides of the bridge — `strToU8` plus
   * `btoa` in the app, `atob` plus `TextDecoder` in the viewer — so a mismatch
   * would corrupt text rather than fail loudly. Exercised against the
   * characters a book actually contains: curly quotes, em dashes, accents,
   * CJK, and an emoji outside the BMP.
   */
  const { strToU8, strFromU8 } = await import('fflate')
  const { toBase64 } = await import('../renderers/webview/bytes.ts')

  const chapter =
    '<p>“Some text” — with an em dash, café, naïve, 日本語のテキスト, and 👋 too.</p>'

  const b64 = toBase64(strToU8(chapter))

  // The viewer's half: atob to a binary string, then decode as UTF-8.
  const binary = Buffer.from(b64, 'base64')
  assert.equal(strFromU8(new Uint8Array(binary)), chapter)
})

test('base64 needs no escaping inside the injected string literal', () => {
  /*
   * The reason the payload is base64 rather than the markup itself.
   *
   * The host builds `window.__srAppend('<payload>',false);true;` as JavaScript
   * source. Raw HTML would need quotes, backslashes and newlines escaped by
   * hand — the exact class of bug the top of this file exists to catch. Base64
   * output is A-Z a-z 0-9 + / = only, none of which a single-quoted literal
   * has to escape.
   */
  const alphabet = /^[A-Za-z0-9+/=]*$/
  const samples = [
    '<p>quote \' and "double" and \backslash\</p>',
    'line one\nline two\r\nline three',
    '</script><script>alert(1)</script>',
  ]

  for (const sample of samples) {
    const b64 = Buffer.from(sample, 'utf8').toString('base64')
    assert.match(b64, alphabet, `base64 of ${JSON.stringify(sample)} needs escaping`)
  }
})
