/**
 * The WebView renderer host.
 *
 * This is the mobile equivalent of the desktop app's HTML renderers. Electron
 * *was* a browser, so every non-PDF format there was web code; a WebView gives
 * us the same environment back, which means the same rendering approach works
 * with no native module per format.
 *
 * The page is deliberately self-contained (no network, no CDN): content is
 * pushed in over `postMessage`, and results are posted back the same way. That
 * keeps the security surface tiny — the WebView never navigates anywhere.
 *
 * Formats handled here: markdown, plain text, sanitized HTML, spreadsheets,
 * comics and archive listings. EPUB and DOCX are converted to HTML natively and
 * share this path.
 */

export interface ViewerTheme {
  bg: string
  fg: string
  fgDim: string
  accent: string
  border: string
  surfaceAlt: string
  surface: string
  gutter: string
}

/**
 * How a format is measured and presented.
 *
 *  - `paper`  — reflowable text laid out as A4-proportioned sheets.
 *  - `items`  — genuinely discrete pages (comic images); counted exactly.
 *  - `flow`   — a grid or listing with no meaningful page concept.
 */
export type ViewerMode = 'paper' | 'items' | 'flow'

export function buildViewerHtml(
  theme: ViewerTheme,
  initialScroll: number,
  /**
   * Emit timing for the viewer's own long tasks.
   *
   * Optional and defaulting to off, so the four existing tests keep calling
   * this with two arguments. The host passes `__DEV__`.
   *
   * It gates a *value*, not a code path — see SR_DEBUG in the emitted script.
   * The script the tests parse is therefore the same script in both modes,
   * which it would not be if the timing were interpolated in or out.
   */
  debug = false,
  /**
   * The first-paint payload, delivered **inside the document**.
   *
   * When present it is embedded below as a `<script type="application/json">`
   * island and rendered at boot, instead of crossing the bridge as a message.
   *
   * ## Why this is worth a parameter
   *
   * `postMessage` on Android compiles to `evaluateJavascript` with the payload
   * JSON-escaped **twice** — once by us, once by `JSONObject.toString()` in
   * `RNCWebViewManagerImpl.kt` — and the result is then handed to V8 as
   * JavaScript *source*. So the document is escaped twice, parsed by a
   * JavaScript parser, and parsed again by `JSON.parse`
   * ([AUDIT2 §2.1](../../AUDIT2.md)).
   *
   * A JSON island is read by Chromium's HTML parser as ordinary text, so all
   * of that collapses to one `JSON.parse`. The `boot` -> push -> `ready` round
   * trip disappears with it.
   *
   * ## Why not the content directly in the div
   *
   * Because `render()` is where the viewer's DOM sanitiser runs, and it is the
   * stronger of the two passes. Writing content straight into the markup would
   * skip it — a security regression, and exactly the kind
   * [CLAUDE.md](../../CLAUDE.md) requires be called out rather than slipped in.
   * The island keeps the entire existing render path, sanitiser included, and
   * changes only how the bytes arrive.
   */
  initialPayload?: unknown,
): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=6, user-scalable=yes">
<style>
  :root {
    color-scheme: ${theme.bg === '#0b0b0d' ? 'dark' : 'light'};
    /* Reader controls live here, so changing one restyles the document
       instantly without re-parsing or re-sending it. */
    --sr-font-size: 17px;
    --sr-line-height: 1.65;
    --sr-margin: 22px;
    --sr-paper: ${theme.surface};
    --sr-ink: ${theme.fg};
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    background: ${theme.gutter};
    color: var(--sr-ink);
  }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: var(--sr-font-size);
    line-height: var(--sr-line-height);
    word-wrap: break-word;
    overflow-wrap: break-word;
    -webkit-text-size-adjust: 100%;
  }

  /* Publisher page boundaries. Invisible, but their positions are what let a
     reflowable book report its real print page number. */
  .sr-pb { display: block; height: 0; overflow: hidden; }

  /* ---- paper mode: A4-proportioned sheets on a grey gutter ---- */
  #paper {
    margin: 0 auto;
    background: var(--sr-paper);
    box-shadow: 0 1px 6px rgba(0,0,0,0.28);
    /* Page separators are painted, not DOM nodes, so they cost nothing to
       scroll past and never interfere with text selection. */
    background-repeat: repeat-y;
  }
  #paper.paper-mode {
    padding: 34px var(--sr-margin) 60px;
  }

  /* ---- flow / items modes fill the screen instead ---- */
  #paper.flow-mode  { background: ${theme.bg}; box-shadow: none; padding: 14px 14px 60px; max-width: none; }
  #paper.items-mode { background: ${theme.gutter}; box-shadow: none; padding: 0 0 60px; max-width: none; }

  h1, h2, h3, h4 { line-height: 1.28; margin: 1.6em 0 .6em; font-weight: 650; }
  h1 { font-size: 1.7em; } h2 { font-size: 1.4em; } h3 { font-size: 1.18em; }
  p { margin: 0 0 1em; }
  a { color: ${theme.accent}; }
  hr { border: 0; border-top: 1px solid ${theme.border}; margin: 1.8em 0; }
  blockquote {
    margin: 1em 0; padding: .2em 0 .2em 1em;
    border-left: 3px solid ${theme.border}; color: ${theme.fgDim};
  }
  code {
    background: ${theme.surfaceAlt};
    padding: .15em .38em; border-radius: 4px;
    font: .88em/1.5 ui-monospace, Menlo, Consolas, monospace;
  }
  pre {
    background: ${theme.surfaceAlt};
    padding: 12px 14px; border-radius: 9px;
    overflow-x: auto;
  }
  pre code { background: none; padding: 0; }
  img { max-width: 100%; height: auto; }
  ul, ol { padding-left: 1.5em; margin: 0 0 1em; }
  li { margin: .3em 0; }

  /* ---- tables ----
     A width of 100% was the bug behind unreachable spreadsheet columns: it
     forces the table to the container width, so columns squeeze instead of
     overflowing and there is nothing left for overflow-x to scroll. */
  .sr-scroll-x {
    /* hidden, not auto: a single-finger drag must reach the pager so
       swipe-to-change-file keeps working. Horizontal movement comes from the
       two-finger handler below, which sets scrollLeft directly. */
    overflow-x: hidden;
    overflow-y: visible;
    max-width: 100%;
  }
  table {
    width: max-content;
    min-width: 100%;
    border-collapse: collapse;
    margin: 1em 0;
    font-size: 14px;
  }
  th, td {
    border: 1px solid ${theme.border};
    padding: 7px 10px;
    text-align: left;
    white-space: nowrap;
  }
  thead th {
    position: sticky;
    top: 0;
    z-index: 2;
    background: ${theme.surfaceAlt};
    font-weight: 600;
  }

  /* ---- spreadsheet grid: column letters across, row numbers down ----
     Both are pinned, and the corner cell is pinned on both axes so it stays
     put while scrolling in either direction. */
  .sr-grid .sr-colhead {
    text-align: center;
    min-width: 72px;
    color: ${theme.fgDim};
    font-weight: 600;
  }
  .sr-grid .sr-rowhead {
    position: sticky;
    left: 0;
    z-index: 2;
    min-width: 44px;
    text-align: right;
    background: ${theme.surfaceAlt};
    color: ${theme.fgDim};
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .sr-grid .sr-corner {
    position: sticky;
    left: 0;
    top: 0;
    z-index: 4;
    min-width: 44px;
    background: ${theme.surfaceAlt};
  }
  .sr-grid thead th { z-index: 3; }
  .sr-grid td { background: ${theme.surface}; }

  /* ---- sheet tabs ---- */
  .sr-tabs {
    position: sticky; top: 0; z-index: 3;
    display: flex; gap: 6px; overflow-x: auto;
    padding: 8px 2px; margin-bottom: 4px;
    background: ${theme.bg};
    border-bottom: 1px solid ${theme.border};
  }
  .sr-tab {
    flex: 0 0 auto;
    padding: 6px 13px; border-radius: 7px;
    border: 1px solid ${theme.border};
    background: ${theme.surfaceAlt}; color: ${theme.fgDim};
    font-size: 13px; font-weight: 500;
  }
  .sr-tab.active { background: ${theme.accent}; border-color: ${theme.accent}; color: #fff; }
  .sr-sheet { display: none; }
  .sr-sheet.active { display: block; }

  /* ---- find-in-document highlights ----
     A background only: no padding or border, because a mark wraps a run of
     text mid-line and anything that changes its metrics would reflow the
     paragraph around it -- which moves every other match on screen. */
  mark.sr-hit {
    background: rgba(255, 214, 10, 0.42);
    color: inherit;
    border-radius: 2px;
  }
  mark.sr-hit-current {
    /* The one the reader was sent to. Distinct enough to find at a glance
       without repainting the page. */
    background: rgba(255, 159, 10, 0.85);
  }

  /* Plain text keeps its own whitespace but must still wrap on a phone. */
  #paper.plain { white-space: pre-wrap; font: 14px/1.6 ui-monospace, Menlo, Consolas, monospace; }

  /* EPUB chapters are concatenated; give each a visible break. */
  .sr-chapter + .sr-chapter { border-top: 1px solid ${theme.border}; margin-top: 2.4em; padding-top: 2.4em; }

  /* Comic pages are real pages: full-bleed, separated by the gutter. */
  .sr-comic img { display: block; width: 100%; margin: 0 auto 10px; background: #fff; }

  #err { padding: 24px; color: ${theme.fgDim}; text-align: center; font-size: 14px; }
</style>
</head>
<body>
<div id="paper"></div>
${
    initialPayload === undefined
      ? ''
      : /*
         * Every < becomes the JSON escape sequence for it.
         *
         * A JSON island is a raw-text element, so the only thing that can end
         * it early is a closing script tag -- and the content is an arbitrary
         * file, which may well contain one. Escaping is content-preserving:
         * JSON.parse decodes it straight back.
         *
         * **Note the doubled backslash below.** This is a template literal, so
         * a single one would be the character < itself and the replacement
         * would be a silent no-op -- which is exactly what the test for this
         * caught on the first attempt.
         */
        `<script id="sr-initial" type="application/json">${JSON.stringify(initialPayload).replace(
          /</g,
          '\\u003c',
        )}</script>`
  }
<script>
(function () {
  var post = function (msg) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    }
  };

  var el = document.getElementById('paper');
  var mode = 'paper';        // 'paper' | 'items' | 'flow'
  var pageHeight = 0;        // px between painted separators (cosmetic only)
  var itemTops = [];         // page offsets (items mode)

  /*
   * How many anchors and item images have already been measured.
   *
   * Content is only ever *appended* -- appendChunk uses
   * insertAdjacentHTML('beforeend') -- so an offsetTop read before a batch is
   * still correct after it. These let an append measure only what arrived,
   * instead of re-reading the whole document once per batch.
   *
   * Reset by any full measure, which is every call site except the append.
   */
  var measuredAnchors = 0;
  var measuredItems = 0;

  /**
   * Page count supplied by native, derived from the document's **content**.
   *
   * The previous build divided rendered height by a fixed box, which made the
   * total depend on screen size and font — a 145-page book reported 295 and the
   * number changed on rotation. Layout no longer decides how many pages exist;
   * it only decides where they fall on screen.
   */
  var contentPages = 0;
  /** Offsets of publisher page boundaries, when the book declares them. */
  var pbTops = [];
  var pbLabels = [];

  /**
   * Scrollable range in px, refreshed by every measure().
   *
   * Cached because reading document.body.scrollHeight forces the browser to
   * flush layout, and the scroll handler needs this value sixty times a second.
   * Anything that can change it already re-measures.
   *
   * No backticks in this comment, deliberately: this whole file is one
   * template literal, so a backtick here terminates it and the build fails
   * with errors pointing somewhere else entirely.
   */
  var scrollRange = 0;

  /**
   * A text-offset restore waiting for the content that contains it.
   *
   * The anchor twin of pendingScroll: with progressive delivery a saved
   * position can name text that has not been appended yet.
   */
  var pendingAnchor = 0;

  /*
   * Requests that arrived before the content they address.
   *
   * A book is delivered progressively, so a restored scroll position or a TOC
   * jump can name somewhere that has not been appended yet. Silently dropping
   * those is what the two-state boot/ready split already guards against for the
   * first paint; these cover the same hazard for the batches after it.
   *
   * Retried by appendChunk as content lands, and cleared once satisfied so a
   * later batch cannot yank a reader who has since scrolled somewhere else.
   */
  var pendingScroll = 0;
  var pendingHref = null;

  /** A4 proportion, used only to space the painted separators. */
  var PAGE_ASPECT = 1.414;
  /** Comfortable reading measure. */
  var MAX_PAPER_WIDTH = 704;   // 44rem

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * A small Markdown renderer.
   *
   * Deliberately hand-rolled rather than bundling marked/remark: this page must
   * stay offline and dependency-free, and the subset below covers ordinary
   * documents. Everything is escaped first, so no raw HTML from a file is ever
   * interpreted.
   */
  function renderMarkdown(src) {
    var lines = src.replace(/\\r\\n?/g, '\\n').split('\\n');
    var out = [];
    var inCode = false, codeBuf = [], listType = null;

    function closeList() {
      if (listType) { out.push('</' + listType + '>'); listType = null; }
    }

    /*
     * Markdown link and image targets.
     *
     * Escaping the text stops raw HTML being interpreted, but the rewriters
     * below build real href and src attributes out of what is left -- so a file
     * writing [x](javascript:...) would otherwise produce a working
     * javascript: link. Escaping cannot help: the scheme is ordinary text right
     * up until this function turns it into an attribute.
     */
    function safeUrl(u) {
      // Undo the escaping applied above before reading the scheme, or an
      // entity-encoded colon hides it.
      var probe = u
        .replace(/&amp;/g, '&')
        .replace(/&#(\\d+);?/g, function (_, d) { return String.fromCharCode(+d); })
        .replace(/[\\u0000-\\u0020]/g, '')
        .toLowerCase();
      return /^(javascript|vbscript|data:text\\/html)/.test(probe) ? '#' : u;
    }

    function inline(t) {
      t = escapeHtml(t);
      t = t.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      t = t.replace(/!\\[([^\\]]*)\\]\\(([^)\\s]+)[^)]*\\)/g, function (_, alt, url) {
        return '<img alt="' + alt + '" src="' + safeUrl(url) + '">';
      });
      t = t.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)[^)]*\\)/g, function (_, text, url) {
        return '<a href="' + safeUrl(url) + '">' + text + '</a>';
      });
      t = t.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      t = t.replace(/(^|[^*])\\*([^*]+)\\*/g, '$1<em>$2</em>');
      t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
      return t;
    }

    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];

      if (/^\`\`\`/.test(ln)) {
        if (inCode) { out.push('<pre><code>' + escapeHtml(codeBuf.join('\\n')) + '</code></pre>'); codeBuf = []; inCode = false; }
        else { closeList(); inCode = true; }
        continue;
      }
      if (inCode) { codeBuf.push(ln); continue; }

      if (/^\\s*$/.test(ln)) { closeList(); continue; }

      var h = ln.match(/^(#{1,6})\\s+(.*)$/);
      if (h) { closeList(); out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); continue; }

      if (/^\\s*([-*_])\\1{2,}\\s*$/.test(ln)) { closeList(); out.push('<hr>'); continue; }

      var q = ln.match(/^>\\s?(.*)$/);
      if (q) { closeList(); out.push('<blockquote>' + inline(q[1]) + '</blockquote>'); continue; }

      var ul = ln.match(/^\\s*[-*+]\\s+(.*)$/);
      if (ul) {
        if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
        out.push('<li>' + inline(ul[1]) + '</li>');
        continue;
      }

      var ol = ln.match(/^\\s*\\d+[.)]\\s+(.*)$/);
      if (ol) {
        if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
        out.push('<li>' + inline(ol[1]) + '</li>');
        continue;
      }

      closeList();
      out.push('<p>' + inline(ln) + '</p>');
    }

    if (inCode && codeBuf.length) out.push('<pre><code>' + escapeHtml(codeBuf.join('\\n')) + '</code></pre>');
    closeList();
    return out.join('\\n');
  }

  /**
   * Strip anything executable or remote-loading from file-supplied HTML.
   * The analogue of the desktop app's DOMPurify pass.
   */
  function sanitize(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');

    var kill = doc.querySelectorAll('script, iframe, object, embed, link, meta, base, form, style');
    for (var i = 0; i < kill.length; i++) kill[i].parentNode.removeChild(kill[i]);

    var all = doc.body ? doc.body.querySelectorAll('*') : [];
    for (var j = 0; j < all.length; j++) {
      var node = all[j];
      var attrs = Array.prototype.slice.call(node.attributes || []);
      for (var k = 0; k < attrs.length; k++) {
        var name = attrs[k].name.toLowerCase();
        /*
         * Namespaced handlers count too.
         *
         * \`indexOf('on') === 0\` misses \`ev:onload\` and \`xlink:onclick\`,
         * which the native pre-pass already strips. The two passes disagreeing
         * about what an event handler *is* is how the weaker one ends up
         * trusted.
         */
        var local = name.indexOf(':') >= 0 ? name.slice(name.indexOf(':') + 1) : name;

        if (local.indexOf('on') === 0) {
          node.removeAttribute(attrs[k].name);
        } else if (isUrlAttr(local) && isExecutableScheme(attrs[k].value || '')) {
          node.removeAttribute(attrs[k].name);
        }
      }
    }
    return doc.body ? doc.body.innerHTML : '';
  }

  /**
   * Attributes whose value the browser will fetch or execute.
   *
   * Matched on the *local* name, so \`xlink:href\` is covered — it was not
   * before, while the native pre-pass in \`sanitize.ts\` did cover it. Same list
   * as that pass, deliberately: two sanitisers that disagree about their own
   * scope are worse than one, because the gap is invisible in both.
   */
  function isUrlAttr(local) {
    return (
      local === 'href' ||
      local === 'src' ||
      local === 'action' ||
      local === 'formaction' ||
      local === 'data' ||
      local === 'poster'
    );
  }

  /**
   * Whether an attribute value resolves to an executable scheme.
   *
   * The previous test was \`/^(javascript|data:text\\/html|vbscript):/\` against a
   * value that had only been trimmed and lowercased — **no entity decoding and
   * no control-character stripping** — so \`java&#09;script:\` walked straight
   * past it. The browser's URL parser decodes those before deciding what to do,
   * so anything comparing against a raw string is checking a different value
   * from the one that will actually be used.
   *
   * This mirrors \`attrValue\` + \`EXECUTABLE_SCHEME\` in
   * [sanitize.ts](sanitize.ts). That module's header calls this DOM pass "the
   * stronger of the two" on the grounds that it works on a parsed tree rather
   * than on regexes — true of its *structural* half, and it was not true of the
   * scheme check until now.
   */
  function isExecutableScheme(raw) {
    var v = String(raw);

    // Numeric entities first: \`&#x6a;\` and \`&#106;\` are both 'j'.
    v = v.replace(/&#x([0-9a-f]+);?/gi, function (_, h) {
      return String.fromCharCode(parseInt(h, 16));
    });
    v = v.replace(/&#(\\d+);?/g, function (_, d) {
      return String.fromCharCode(parseInt(d, 10));
    });
    v = v.replace(/&(tab|newline);/gi, ' ');

    // Then every control character and space, which is the padding trick:
    // \`java\\tscript:\` and \`java script:\` both reach the parser as one word.
    v = v.replace(/[\\u0000-\\u0020]/g, '').toLowerCase();

    return (
      v.indexOf('javascript:') === 0 ||
      v.indexOf('vbscript:') === 0 ||
      v.indexOf('data:text/html') === 0
    );
  }

  // ---------------------------------------------------------------- layout --

  /**
   * Recomputes page geometry.
   *
   * Runs after render and on every resize, so rotating the phone produces a new
   * (correct) page count rather than freezing the old one.
   */
  /*
   * Timing threshold for a single measure(), in ms.
   *
   * One frame at 60Hz. Anything over it dropped a frame, which is the only
   * definition of "long task" that matters to a reader scrolling a book.
   */
  var SR_DEBUG = ${debug ? 'true' : 'false'};
  var SR_LONG_TASK_MS = 16;

  /**
   * measure(), wrapped so the host can see when it becomes expensive.
   *
   * The real work is in measureImpl below; this exists only to time it. It is
   * a branch on a constant rather than two different emitted scripts, so the
   * viewer the tests parse is byte-for-byte the viewer that ships apart from
   * one boolean.
   *
   * Worth timing specifically because appendChunk calls it once per delivered
   * batch and it walks every page anchor in the document -- so on a long book
   * the cost grows with each batch rather than staying flat. Watching this
   * number stop growing is how R3-1 is verified.
   */
  function measure(incremental) {
    if (!SR_DEBUG) { measureImpl(incremental); return; }
    var t0 = Date.now();
    measureImpl(incremental);
    var dt = Date.now() - t0;
    if (dt > SR_LONG_TASK_MS) post({ type: 'perf', ms: dt, anchors: pbTops.length });
  }

  function measureImpl(incremental) {
    if (mode === 'paper') {
      var width = Math.min(MAX_PAPER_WIDTH, window.innerWidth);
      el.style.maxWidth = width + 'px';
      pageHeight = Math.round(width * PAGE_ASPECT);

      // Paint a separator line at every page boundary.
      el.style.backgroundImage =
        'repeating-linear-gradient(to bottom,' +
        'transparent 0px,' +
        'transparent ' + (pageHeight - 2) + 'px,' +
        '${theme.border} ' + (pageHeight - 2) + 'px,' +
        '${theme.border} ' + pageHeight + 'px)';
      el.style.backgroundSize = '100% ' + pageHeight + 'px';
    } else if (mode === 'items') {
      // Real pages: record where each one starts.
      var imgs = el.querySelectorAll('.sr-comic img');
      if (!incremental) { itemTops = []; measuredItems = 0; }
      for (var i = measuredItems; i < imgs.length; i++) itemTops.push(imgs[i].offsetTop);
      measuredItems = imgs.length;
    }

    /*
     * Publisher page boundaries, if this book declared any.
     *
     * Only anchors added since the last measure are read. Each offsetTop on a
     * freshly mutated DOM forces a layout flush, and appendChunk calls this
     * once per delivered batch -- so re-reading every anchor made loading a
     * 600-page book O(batches x pages) forced layouts, over a document that
     * grew with each one. That is why a long book got progressively janky
     * *while* it loaded rather than being uniformly slow.
     *
     * Safe because content is only ever appended, so an anchor measured
     * before a batch has an unchanged offsetTop after it. Everything that can
     * move an existing anchor -- a resize, a font change, an image finishing
     * decode, a whole new document -- takes the full path instead.
     */
    var breaks = el.querySelectorAll('.sr-pb');
    if (!incremental) { pbTops = []; pbLabels = []; measuredAnchors = 0; }
    for (var b = measuredAnchors; b < breaks.length; b++) {
      pbTops.push(breaks[b].offsetTop);
      pbLabels.push(breaks[b].getAttribute('data-page') || String(b + 1));
    }
    measuredAnchors = breaks.length;

    /*
     * Scrollable range, cached here rather than read per frame.
     *
     * \`progress()\` runs on every scroll frame and read
     * \`document.body.scrollHeight\` each time, which forces a synchronous
     * layout — the browser must flush pending style and reflow work before it
     * can answer. That is the expensive half of the scroll handler, and it
     * survived the change that stopped *posting* unchanged frames: the read
     * happens before any comparison can skip it.
     *
     * Free to cache here because this function has already forced layout by
     * reading \`offsetTop\` above, and the value changes only when something
     * re-measures — a resize, an appended batch, an image finishing decode —
     * all of which call \`measure()\`.
     */
    scrollRange = document.body.scrollHeight - window.innerHeight;
  }

  function totalPages() {
    if (mode === 'flow') return 0;                 // a grid has no pages
    if (mode === 'items') return itemTops.length;
    if (pbTops.length) return pbTops.length;       // the publisher's own count
    return contentPages || 1;
  }

  /**
   * How far through the document we are, 0..1.
   *
   * Reads the cached range from \`measure()\`. See there for why this must not
   * touch \`scrollHeight\` itself: it runs on every scroll frame, and that
   * property forces a layout flush.
   */
  function progress() {
    if (scrollRange <= 0) return 0;
    return Math.min(1, Math.max(0, window.scrollY / scrollRange));
  }

  /**
   * The anchor array in play, or null when pages are estimated from characters.
   *
   * Extracted so \`currentPage\` and \`seekToPage\` cannot disagree about which
   * array they are addressing — they are inverse operations over the same
   * index, and a mismatch shows up as a seek landing one page off.
   */
  function activeAnchors() {
    if (mode === 'items') return itemTops;
    return pbTops.length ? pbTops : null;
  }

  /**
   * 1-based index of the last anchor at or above \`y\`, by binary search.
   *
   * Anchors are \`offsetTop\` values collected in document order, so the array is
   * sorted by construction — which is what makes a binary search valid here.
   * The previous linear scan ran on every scroll frame, so a 1200-page book
   * cost up to 1200 comparisons at 60fps; this is ~11.
   *
   * Returns at least 1: being above the first anchor still means page one.
   */
  function anchorIndexAt(anchors, y) {
    var lo = 0;
    var hi = anchors.length - 1;
    var found = 0;
    while (lo <= hi) {
      // (lo + hi) >>> 1 rather than Math.floor: same result, and it cannot
      // overflow into a float on a pathological array length.
      var mid = (lo + hi) >>> 1;
      if (anchors[mid] <= y) { found = mid + 1; lo = mid + 1; }
      else hi = mid - 1;
    }
    return Math.max(1, found);
  }

  function currentPage() {
    var total = totalPages();
    if (!total) return 0;

    // Anchored positions: the last boundary scrolled past. This is what gives a
    // reflowable book its true print page number.
    var anchors = activeAnchors();
    if (anchors) {
      // The 0.35 bias asks "what page is the reader looking at", not "what page
      // starts at the top edge" — a boundary just above the fold has already
      // been read past.
      return anchorIndexAt(anchors, window.scrollY + window.innerHeight * 0.35);
    }

    // Estimated pages: position is proportional, because the count comes from
    // character totals rather than anything measurable on screen.
    return Math.min(total, Math.max(1, Math.round(progress() * (total - 1)) + 1));
  }

  /** The label to show — a print page number can be roman numerals. */
  function currentLabel() {
    if (pbTops.length) {
      var p = currentPage();
      return pbLabels[p - 1] || String(p);
    }
    return String(currentPage());
  }

  /*
   * The last position actually posted, so an unchanged frame can be dropped.
   *
   * Every 'pos' message is a JSON string across the bridge, and the native
   * handler answers it with three MMKV reads, up to three writes and a Zustand
   * set. At 60fps that is the single busiest path in the app — and during a
   * long flick almost every frame reports the *same page*, because a page is
   * hundreds of pixels tall. Only \`scrollY\` and \`percent\` really move.
   *
   * Initialised to -1 rather than 0 so the very first report always sends: page
   * 0 is a real value for a document still measuring, and starting at 0 would
   * swallow it.
   */
  var lastCurrent = -1;
  var lastTotal = -1;
  var lastPercent = -1;
  var lastScrollY = -1;

  /**
   * Post the current position, unless nothing a consumer cares about moved.
   *
   * \`force\` bypasses the comparison, for the callers that must always deliver:
   * a seek has to confirm where it landed even if it landed where it started,
   * or the native side keeps waiting on a jump it thinks never completed.
   */
  function reportPosition(force) {
    var current = currentPage();
    var total = totalPages();
    var percent = Math.round(progress() * 100);
    var scrollY = Math.round(window.scrollY);

    /*
     * Scroll offset is compared to the *whole pixel*, not the raw float.
     *
     * A momentum scroll produces sub-pixel offsets, so the raw value differs on
     * every single frame and this check would never fire. Rounding costs
     * nothing — the value is only used to restore position, where a pixel is
     * far below what anyone notices.
     */
    if (
      !force &&
      current === lastCurrent &&
      total === lastTotal &&
      percent === lastPercent &&
      scrollY === lastScrollY
    ) {
      return;
    }

    lastCurrent = current;
    lastTotal = total;
    lastPercent = percent;
    lastScrollY = scrollY;

    post({
      type: 'pos',
      current: current,
      total: total,
      label: currentLabel(),
      percent: percent,
      scrollY: scrollY,
    });

    scheduleAnchorReport();
  }

  /*
   * The anchor is reported on settle, never per frame.
   *
   * Computing it walks the text index and measures a Range per probe -- ~11
   * measurements for a binary search, each forcing layout. That is nothing
   * once, and ruinous sixty times a second. A reading position only needs to be
   * durable, not live: the scroll offset already tracks the finger, and this
   * lands a moment after the finger stops.
   */
  var anchorTimer = null;
  function scheduleAnchorReport() {
    if (anchorTimer) clearTimeout(anchorTimer);
    anchorTimer = setTimeout(function () {
      anchorTimer = null;
      var offset = anchorAtTop();
      if (offset >= 0) post({ type: 'anchor', offset: offset });
    }, 250);
  }

  var ticking = false;
  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      reportPosition();
    });
  }, { passive: true });

  window.addEventListener('resize', function () {
    measure();
    reportPosition(true);
  });

  /** Scrolls to a page, serving seek requests from the native scrollbar. */
  function seekToPage(page) {
    var total = totalPages();
    if (!total) return;
    var target = Math.min(total, Math.max(1, page));

    var anchors = activeAnchors();
    var y;
    if (anchors) {
      y = anchors[target - 1] || 0;
    } else {
      // Estimated pages have no anchor, so seek proportionally through the
      // scrollable range — consistent with how the position is reported, which
      // is why both read the same cached value rather than measuring here.
      y = total > 1 ? ((target - 1) / (total - 1)) * scrollRange : 0;
    }

    window.scrollTo(0, y);
    reportPosition(true);
  }

  /** Scrolls to a TOC target, matched against the chapter it came from. */
  function seekToHref(href) {
    if (!href) return;
    var hash = href.indexOf('#');
    var path = hash >= 0 ? href.slice(0, hash) : href;
    var frag = hash >= 0 ? href.slice(hash + 1) : null;

    var node = null;
    if (frag) node = el.querySelector('[id="' + cssEscape(frag) + '"]');
    if (!node && path) {
      // Chapters carry their source path, so a fragment-less link still lands.
      var chapters = el.querySelectorAll('.sr-chapter');
      for (var i = 0; i < chapters.length; i++) {
        var src = chapters[i].getAttribute('data-src') || '';
        if (src === path || src.indexOf(path) >= 0 || path.indexOf(src) >= 0) {
          node = chapters[i];
          break;
        }
      }
    }
    /*
     * Not here yet.
     *
     * With progressive delivery a chapter link can name content still in
     * flight, so remember it and let appendChunk retry rather than dropping the
     * tap. Before streaming this branch was unreachable, which is why it simply
     * returned.
     */
    if (!node) {
      pendingHref = href;
      return;
    }

    // Satisfied: drop any competing restore so the two cannot fight over the
    // scroll position as later batches land.
    pendingHref = null;
    pendingScroll = 0;

    window.scrollTo(0, node.offsetTop);
    reportPosition(true);
  }

  /* ==================== find in document ====================
   *
   * Search over a flat index of the document's text nodes, not over the DOM.
   *
   * Why not window.find(): it cannot report how many matches exist, cannot be
   * styled, moves the selection (which fights text selection on Android), and
   * does not survive the DOM mutations that streaming appends cause. It answers
   * "go to the next one" and nothing else this needs.
   *
   * The index is a flat array of {node, start} plus one concatenated string, so
   * a match is found by indexOf over that string and then mapped back to the
   * node and offset that contain it. That mapping is the whole trick: it means
   * the search coordinate is a character offset into the document's text, which
   * is exactly the coordinate the native side speaks (see search/types.ts) and
   * the one that survives a font change or a rotation.
   */

  /** Flat text index: parallel arrays, built once per document version. */
  var textNodes = [];
  var textStarts = [];
  var textAll = '';
  var textIndexStale = true;

  /** Current match set and where we are in it. */
  var matches = [];
  var matchIndex = -1;
  var matchQuery = '';

  /**
   * Walks every text node under the paper element, in document order.
   *
   * Skips nothing structural on purpose: page-break anchors are zero-height
   * spans with no text, and script/style never reach the viewer because the
   * sanitiser strips them before content is posted.
   */
  function buildTextIndex() {
    textNodes = [];
    textStarts = [];
    var parts = [];
    var offset = 0;

    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while ((node = walker.nextNode())) {
      var value = node.nodeValue;
      if (!value) continue;
      textNodes.push(node);
      textStarts.push(offset);
      parts.push(value);
      offset += value.length;
    }

    textAll = parts.join('');
    textIndexStale = false;
  }

  /**
   * Node and offset containing a character position, by binary search.
   *
   * The same reasoning as the page anchors: textStarts is sorted by
   * construction, and a linear scan here would be O(nodes) per match on a book
   * with tens of thousands of text nodes.
   */
  function nodeAt(pos) {
    var lo = 0;
    var hi = textStarts.length - 1;
    var found = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >>> 1;
      if (textStarts[mid] <= pos) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (found < 0) return null;
    return { index: found, offset: pos - textStarts[found] };
  }

  /**
   * Builds a Range spanning [start, start+length) of the flat text.
   *
   * A match can straddle several text nodes -- "the cat" where a bold "cat"
   * starts a new node -- so start and end are resolved independently rather
   * than assuming one node holds both.
   */
  function rangeFor(start, length) {
    var from = nodeAt(start);
    var to = nodeAt(start + length - 1);
    if (!from || !to) return null;

    var range = document.createRange();
    range.setStart(textNodes[from.index], from.offset);
    range.setEnd(textNodes[to.index], to.offset + 1);
    return range;
  }

  function isSearchWordChar(ch) {
    if (!ch) return false;
    // Unicode-aware rather than \\w, which is ASCII-only and would make whole
    // word matching behave differently in Cyrillic or Greek text.
    return /[\\p{L}\\p{N}]/u.test(ch);
  }

  /**
   * Finds every match and paints them.
   *
   * Highlights are applied by wrapping each match in a mark element, from the
   * LAST match backwards. Wrapping mutates the DOM and invalidates every offset
   * after the point of mutation, so going forwards would corrupt the positions
   * of all subsequent matches. Backwards, each wrap only disturbs text after
   * itself, which has already been handled.
   */
  function runSearch(query, opts) {
    clearHighlights();
    matchQuery = query || '';
    matches = [];
    matchIndex = -1;

    if (!matchQuery) {
      post({ type: 'search', total: 0, current: 0, query: '' });
      return;
    }

    if (textIndexStale) buildTextIndex();

    var matchCase = !!(opts && opts.matchCase);
    var wholeWord = !!(opts && opts.wholeWord);
    var limit = (opts && opts.limit) || 500;

    var haystack = matchCase ? textAll : textAll.toLowerCase();
    var needle = matchCase ? matchQuery : matchQuery.toLowerCase();

    var from = 0;
    var truncated = false;
    var found = [];

    for (;;) {
      var at = haystack.indexOf(needle, from);
      if (at === -1) break;
      // Advanced before any skip, so a rejected candidate cannot loop forever.
      from = at + needle.length;

      if (wholeWord) {
        var before = at > 0 ? haystack[at - 1] : '';
        var after = at + needle.length < haystack.length ? haystack[at + needle.length] : '';
        if (isSearchWordChar(before) || isSearchWordChar(after)) continue;
      }

      if (found.length >= limit) { truncated = true; break; }
      found.push(at);
    }

    // Painted last-first: see the note above about offsets shifting.
    for (var i = found.length - 1; i >= 0; i--) {
      var range = rangeFor(found[i], needle.length);
      if (!range) continue;
      try {
        var mark = document.createElement('mark');
        mark.className = 'sr-hit';
        range.surroundContents(mark);
        matches.unshift(mark);
      } catch (e) {
        /*
         * surroundContents throws when the range partially selects a non-text
         * node -- a match spanning a tag boundary, like "the <em>cat</em>".
         * Skipping it loses one highlight rather than the whole search; the
         * count below reports what was actually painted, so navigation stays
         * consistent with what is on screen.
         */
      }
    }

    // The index describes a DOM that has just been rewritten by the wrapping.
    textIndexStale = true;

    post({
      type: 'search',
      total: matches.length,
      current: matches.length ? 1 : 0,
      truncated: truncated,
      query: matchQuery
    });

    if (matches.length) goToMatch(0);
  }

  /** Scrolls to one match and marks it current. */
  function goToMatch(index) {
    if (!matches.length) return;

    // Wraps in both directions: past the last match is the first.
    var next = ((index % matches.length) + matches.length) % matches.length;

    if (matchIndex >= 0 && matches[matchIndex]) {
      matches[matchIndex].className = 'sr-hit';
    }
    matchIndex = next;
    var mark = matches[next];
    mark.className = 'sr-hit sr-hit-current';

    // Centred rather than scrolled to the top edge: a match at the very top of
    // the viewport reads as cut off, and gives no context above it.
    var top = mark.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, top - window.innerHeight * 0.4));

    post({ type: 'search', total: matches.length, current: next + 1, query: matchQuery });
    reportPosition(true);
  }

  /* ==================== position anchors ====================
   *
   * A reading position that survives a font change, a margin change and a
   * rotation.
   *
   * scrollY does not: it is a pixel offset into a layout that every one of
   * those inputs rewrites. Page *counts* were fixed the same way long ago --
   * derived from content rather than from layout, because a count that changed
   * on rotation was a count of the screen, not of the book. This is the same
   * correction applied to position.
   *
   * The anchor is a character offset into the document's text, which is exactly
   * the coordinate the search index already speaks and the one the native side
   * models in search/types.ts. Reusing it is the point: one notion of "where in
   * the document", shared by find-in-document, position restore and anything
   * later that needs to name a spot.
   */

  /**
   * Character offset of the text currently at the top of the viewport.
   *
   * Found by walking the flat text index and asking each node where it sits.
   * That is O(nodes) and far too slow for a scroll frame -- so this is called
   * only when a position is *stored*, never on the reporting path.
   *
   * Returns -1 when there is no usable anchor: an empty document, or one whose
   * nodes are all inside collapsed elements. Callers fall back to scrollY.
   */
  function anchorAtTop() {
    if (textIndexStale) buildTextIndex();
    if (!textNodes.length) return -1;

    // A little below the top edge: the line straddling the boundary is the one
    // the reader is looking at, and anchoring to the line above it drifts the
    // restore upward a little more on every reopen.
    var targetY = window.scrollY + window.innerHeight * 0.15;

    /*
     * Binary search over nodes by vertical position.
     *
     * Text nodes are in document order, and document order is (for ordinary
     * flowing text) increasing vertical position -- so the array is sorted by
     * the key being searched. Floats and absolutely positioned elements can
     * violate that; the result is then a slightly wrong anchor rather than a
     * broken one, which is an acceptable trade for not walking every node.
     */
    var lo = 0;
    var hi = textNodes.length - 1;
    var best = 0;

    while (lo <= hi) {
      var mid = (lo + hi) >>> 1;
      var y = nodeTop(textNodes[mid]);
      if (y === null) { lo = mid + 1; continue; }
      if (y <= targetY) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }

    return textStarts[best];
  }

  /**
   * Top of a text node in document coordinates, or null if it has no box.
   *
   * A Range is the only way to measure a text node: it has no offsetTop of its
   * own, and using its parent element would collapse every line of a long
   * paragraph to the same position -- which is precisely the resolution this
   * needs to keep.
   */
  function nodeTop(node) {
    try {
      var range = document.createRange();
      range.selectNodeContents(node);
      var rect = range.getBoundingClientRect();
      // A zero box means the node is inside something collapsed or empty.
      if (!rect || (rect.top === 0 && rect.bottom === 0)) return null;
      return rect.top + window.scrollY;
    } catch (e) {
      return null;
    }
  }

  /**
   * Scrolls so the text at the given offset is at the top of the viewport.
   *
   * Returns true when it landed, false when the offset is past what has
   * arrived -- which is a real case with progressive delivery, and the caller
   * parks the request until more content lands.
   */
  function scrollToAnchor(offset) {
    if (typeof offset !== 'number' || offset < 0) return false;
    if (textIndexStale) buildTextIndex();
    if (!textNodes.length) return false;

    var pos = nodeAt(offset);
    if (!pos) return false;

    var node = textNodes[pos.index];
    var y = nodeTop(node);
    if (y === null) return false;

    // Same 15% bias as when the anchor was taken, so storing and restoring are
    // inverse operations rather than each drifting by a fraction of a screen.
    window.scrollTo(0, Math.max(0, y - window.innerHeight * 0.15));
    return true;
  }

  /** Removes every highlight and restores the text nodes it split. */
  function clearHighlights() {
    var marks = el.querySelectorAll('mark.sr-hit');
    for (var i = 0; i < marks.length; i++) {
      var mark = marks[i];
      var parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      // Rejoins the text nodes the wrap split, so a second search sees the
      // document as one node per run rather than three, and offsets stay
      // comparable between searches.
      parent.normalize();
    }
    matches = [];
    matchIndex = -1;
    textIndexStale = true;
  }

  function cssEscape(s) {
    return String(s).replace(/["\\\\]/g, '\\\\$&');
  }

  /** Applies reader typography without touching the document itself. */
  function applySettings(s) {
    if (!s) return;
    var root = document.documentElement.style;
    if (s.fontSize) root.setProperty('--sr-font-size', s.fontSize + 'px');
    if (s.lineHeight) root.setProperty('--sr-line-height', String(s.lineHeight));
    if (s.margin != null) root.setProperty('--sr-margin', s.margin + 'px');
    if (s.paper) root.setProperty('--sr-paper', s.paper);
    if (s.ink) root.setProperty('--sr-ink', s.ink);

    // Geometry depends on type size, so re-measure after the style lands.
    requestAnimationFrame(function () { measure(); reportPosition(true); });
  }

  // ------------------------------------------------- two-finger table pan --

  /**
   * Horizontal scrolling inside wide tables.
   *
   * Single-finger drags are left alone so the native pager still owns
   * swipe-to-change-file; moving within a wide table is a two-finger gesture.
   * Pinch-zoom is also two-fingered, so we only claim the gesture while the
   * distance between the fingers stays roughly constant.
   */
  (function () {
    var target = null, lastX = 0, startSpread = 0, panning = false;

    function spread(t) {
      var dx = t[0].clientX - t[1].clientX;
      var dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }
    function centroidX(t) { return (t[0].clientX + t[1].clientX) / 2; }

    document.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 2) { target = null; panning = false; return; }
      var node = e.target;
      while (node && node !== document.body) {
        if (node.classList && node.classList.contains('sr-scroll-x')) break;
        node = node.parentNode;
      }
      target = (node && node.classList && node.classList.contains('sr-scroll-x')) ? node : null;
      if (!target) return;
      lastX = centroidX(e.touches);
      startSpread = spread(e.touches);
      panning = false;
    }, { passive: true });

    document.addEventListener('touchmove', function (e) {
      if (!target || e.touches.length !== 2) return;

      var nowSpread = spread(e.touches);
      var x = centroidX(e.touches);

      // Fingers separating or closing by a meaningful amount is a pinch —
      // leave it to the browser rather than swallowing it as a pan.
      if (!panning && Math.abs(nowSpread - startSpread) > 24) { target = null; return; }

      panning = true;
      target.scrollLeft -= (x - lastX);
      lastX = x;
      e.preventDefault();
    }, { passive: false });

    document.addEventListener('touchend', function () {
      target = null; panning = false;
    }, { passive: true });
  })();

  // ---------------------------------------------------------------- render --

  /** Sheet tab switching, for multi-sheet workbooks. */
  document.addEventListener('click', function (e) {
    var tab = e.target;
    if (!tab.classList || !tab.classList.contains('sr-tab')) return;

    var tabs = el.querySelectorAll('.sr-tab');
    var sheets = el.querySelectorAll('.sr-sheet');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('active');
    for (var j = 0; j < sheets.length; j++) sheets[j].classList.remove('active');

    tab.classList.add('active');
    var wanted = el.querySelector('.sr-sheet[data-sheet="' + tab.getAttribute('data-sheet') + '"]');
    if (wanted) wanted.classList.add('active');

    window.scrollTo(0, 0);
    measure();
    reportPosition(true);
  });

  function render(payload) {
    try {
      mode = payload.mode || 'paper';
      contentPages = payload.totalPages || 0;
      if (payload.settings) applySettings(payload.settings);

      el.className =
        mode === 'paper' ? 'paper-mode' : mode === 'items' ? 'items-mode' : 'flow-mode';

      if (payload.format === 'markdown') {
        el.innerHTML = renderMarkdown(payload.content);
      } else if (payload.format === 'text') {
        el.classList.add('plain');
        el.textContent = payload.content;
      } else {
        el.innerHTML = sanitize(payload.content);
      }

      measure();

      // Images change layout when they finish decoding, so re-measure then.
      var imgs = el.querySelectorAll('img');
      var pending = imgs.length;
      for (var i = 0; i < imgs.length; i++) {
        if (imgs[i].complete) { pending--; continue; }
        imgs[i].addEventListener('load', function () {
          if (--pending <= 0) { measure(); reportPosition(true); }
        });
        imgs[i].addEventListener('error', function () {
          if (--pending <= 0) { measure(); reportPosition(true); }
        });
      }

      /*
       * Restore the remembered position once layout has settled.
       *
       * With progressive delivery the saved offset can be past the end of what
       * has arrived, so an unreachable target is parked in pendingScroll and
       * retried by appendChunk as the document grows. The rAF loop below still
       * handles the ordinary case, where the position is inside the first paint
       * and only needs layout to settle.
       */
      /*
       * An anchor is preferred over the pixel offset when the payload carries
       * one, because it is the only one of the two that still means the same
       * thing after a rotation or a font change. scrollY remains the fallback:
       * a document with no usable text nodes still has to restore somewhere.
       */
      pendingAnchor = 0;
      if (typeof payload.anchor === 'number' && payload.anchor > 0) {
        if (scrollToAnchor(payload.anchor)) {
          pendingScroll = 0;
          reportPosition(true);
          return;
        }
        // Past what has arrived so far: park it for appendChunk, exactly as an
        // unreachable scroll offset is parked.
        if (payload.streaming) pendingAnchor = payload.anchor;
      }

      var target = payload.scroll || 0;
      pendingScroll = 0;
      if (target > 0) {
        var tries = 0;
        (function settle() {
          window.scrollTo(0, target);
          if (Math.abs(window.scrollY - target) <= 2) {
            /*
             * Layout grew while this loop ran — that is what it was waiting
             * for — so the cached scroll range measured before it is short.
             * Refreshing it here keeps the first reported percentage honest;
             * without it a restored position reads as further through the
             * document than it is, until the next resize or append.
             */
            measure();
            reportPosition(true);
            return;
          }
          if (++tries < 12) {
            requestAnimationFrame(settle);
          } else if (payload.streaming) {
            // Out of tries and still short: the content is not here yet rather
            // than the layout being unsettled.
            pendingScroll = target;
          }
        })();
      }

      reportPosition(true);
      post({ type: 'ready' });
    } catch (e) {
      el.innerHTML = '<div id="err">Could not display this file.<br>' + escapeHtml(String(e)) + '</div>';
      post({ type: 'error', message: String(e) });
    }
  }

  // Content is pushed from native; both channels exist across RN versions.
  window.addEventListener('message', function (e) { handle(e.data); });
  document.addEventListener('message', function (e) { handle(e.data); });

  function handle(raw) {
    try {
      var msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!msg) return;
      if (msg.type === 'seek') seekToPage(msg.page);
      else if (msg.type === 'seekHref') seekToHref(msg.href);
      else if (msg.type === 'settings') applySettings(msg.settings);
      else if (msg.type === 'image') attachImage(msg.token, msg.mime, msg.data);
      else if (msg.type === 'search') runSearch(msg.query, msg);
      else if (msg.type === 'searchNext') goToMatch(matchIndex + 1);
      else if (msg.type === 'searchPrev') goToMatch(matchIndex - 1);
      else if (msg.type === 'searchClear') clearHighlights();
      else render(msg);
    } catch (e) {
      post({ type: 'error', message: String(e) });
    }
  }

  /**
   * Appends a batch of deferred content to the end of the document.
   *
   * The native side sends these after 'ready', so a long book paints its first
   * screens immediately and grows behind the reader instead of making them wait
   * for the whole assembly.
   *
   * Three things make this safe to do under a reader who is already scrolling:
   *
   *  - Content is appended, never re-rendered, so the existing DOM and the
   *    reader's scroll offset are untouched. Browsers keep scrollY fixed when
   *    content is added *below* the viewport, which is the only place this ever
   *    adds anything.
   *  - measure() re-runs so the new .sr-pb anchors and image offsets are
   *    picked up. Page *count* does not change: it came from the whole book's
   *    character total at parse time.
   *  - A pending seek is retried once the batch it needs has landed, since a
   *    restore or a TOC jump can target a chapter that had not arrived yet.
   */
  /**
   * Entry point for a streamed batch delivered by injectJavaScript.
   *
   * Exposed on window because the host calls it by name rather than posting a
   * message. Two things are avoided by that:
   *
   *  - postMessage on Android compiles to evaluateJavascript with the payload
   *    wrapped by JSONObject.toString(), so the batch is JSON-escaped a second
   *    time on the native side. injectJavaScript has no such wrapper.
   *  - the batch travels base64-encoded, whose alphabet contains nothing a JS
   *    string literal has to escape -- so V8 tokenises it as one opaque string
   *    instead of parsing several hundred kilobytes of escaped markup.
   *
   * The decode is a tight built-in loop rather than a parser, which is the
   * trade: 4/3 the bytes, a fraction of the work.
   */
  /**
   * Replace the content-derived page count with the exact one.
   *
   * The first paint of an EPUB can carry a *provisional* total: phase 2 has not
   * counted the book's text yet, so the number comes from the uncompressed byte
   * sizes in the archive's central directory. This lands the real figure once
   * the remainder has been assembled.
   *
   * It never touches a book that declares its own page-list -- those report
   * from pbTops, which totalPages() prefers over contentPages, so the publisher
   * still wins exactly as before.
   */
  window.__srPages = function (total) {
    if (typeof total !== 'number' || total <= 0) return;
    if (total === contentPages) return;
    contentPages = total;
    reportPosition(true);
  };

  window.__srAppend = function (b64, isLast) {
    try {
      var binary = atob(b64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      appendChunk(new TextDecoder('utf-8').decode(bytes), isLast);
    } catch (e) {
      post({ type: 'error', message: 'batch decode failed: ' + String(e) });
    }
  };

  function appendChunk(html, isLast) {
    if (!html) return;

    /*
     * Parsed into a fragment rather than concatenated onto innerHTML.
     *
     * Re-assigning innerHTML would re-parse and rebuild the entire document —
     * seconds of work on a long book, every batch, and it would destroy and
     * recreate every image already decoded. insertAdjacentHTML appends without
     * touching what is already there.
     */
    el.insertAdjacentHTML('beforeend', html);

    /*
     * New text means the flat search index no longer describes the document.
     *
     * Marked stale rather than rebuilt: rebuilding on every batch would walk
     * the whole document once per chunk, and nothing needs the index until a
     * search actually runs. An in-flight result set is left alone on purpose --
     * its marks are still in the DOM and still navigable; re-running the query
     * would move the reader out from under themselves mid-scroll.
     */
    textIndexStale = true;

    /*
     * The one incremental measure in the viewer.
     *
     * Every other call site takes the full path -- deliberately, and by
     * default: measure() with no argument re-reads everything, so a call site
     * added later is correct-but-slower rather than fast-but-wrong. Only this
     * one can prove nothing above it moved, because appending is all it does.
     */
    measure(true);

    // A parked anchor is tried first: it is the more accurate of the two, and
    // succeeding here means the pixel fallback is not needed at all.
    if (pendingAnchor > 0 && scrollToAnchor(pendingAnchor)) {
      pendingAnchor = 0;
      pendingScroll = 0;
    }

    // A seek requested before its target existed can now be satisfied.
    if (pendingHref) {
      var href = pendingHref;
      pendingHref = null;
      seekToHref(href);
    } else if (pendingScroll > 0) {
      // Restoring a position deep in the book: keep trying as content arrives,
      // and stop once we can actually reach it. measure() ran immediately
      // above, so the cached range already reflects the batch just appended.
      if (scrollRange >= pendingScroll) {
        window.scrollTo(0, pendingScroll);
        pendingScroll = 0;
      }
    }

    reportPosition(true);
    if (isLast) post({ type: 'complete' });
  }

  /**
   * Turns one delivered image into a blob: URL and attaches it to its element.
   *
   * Images arrive as base64 over postMessage — the bridge is a string channel,
   * so there is no way around encoding them for transit — but they are decoded
   * to bytes here and handed to the browser as a Blob. That matters: the giant
   * base64 string is transient and garbage-collected, while what the page holds
   * onto is binary, decoded lazily by the image pipeline rather than sitting in
   * the DOM as a data: URI the parser has to carry.
   *
   * The alternative was pointing the WebView at extracted files on disk, which
   * on Android has no scoped form — allowFileAccess is all-or-nothing across
   * the app sandbox. Blobs get the memory win with the viewer still unable to
   * reach the filesystem at all.
   */
  var blobUrls = [];

  function attachImage(token, mime, data) {
    if (!token || !data) return;
    try {
      var binary = atob(data);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      var url = URL.createObjectURL(new Blob([bytes], { type: mime || 'image/jpeg' }));
      // Tracked so they can be released; a blob: URL is a live reference and
      // the browser will not reclaim its bytes while one exists.
      blobUrls.push(url);

      // Every element referencing this token — a cover reused as a chapter
      // illustration is one entry delivered once.
      var targets = el.querySelectorAll('[data-sr-img="' + cssEscape(token) + '"]');
      for (var t = 0; t < targets.length; t++) {
        targets[t].src = url;
        // Re-measure once it decodes: an image changes layout, which moves
        // every page anchor below it.
        targets[t].addEventListener('load', onImageSettled);
        targets[t].addEventListener('error', onImageSettled);
      }
    } catch (e) {
      // A single unreadable image must not take the book down.
      post({ type: 'error', message: 'image: ' + String(e) });
    }
  }

  /*
   * Coalesced re-measure.
   *
   * Images land one after another and each one shifts the layout below it.
   * Measuring per image would be O(images) full passes over the document; one
   * pass after the flurry settles is enough, because nothing reads the geometry
   * in between.
   */
  var settleTimer = null;
  function onImageSettled() {
    if (settleTimer) return;
    settleTimer = setTimeout(function () {
      settleTimer = null;
      measure();
      reportPosition(true);
    }, 120);
  }

  // Release blob references when the page goes away, so their bytes can be
  // reclaimed rather than living as long as the WebView does.
  window.addEventListener('pagehide', function () {
    for (var i = 0; i < blobUrls.length; i++) URL.revokeObjectURL(blobUrls[i]);
    blobUrls = [];
  });

  /*
   * Report pinch-zoom to the native side.
   *
   * The pager disables horizontal paging while a renderer is zoomed in: a
   * horizontal drag on a zoomed page must pan that page, not flip to the next
   * file. The PDF renderer gets this from onScaleChanged; the WebView has no
   * such callback, so scale is read from visualViewport -- the only API that
   * reports the *pinch* scale rather than CSS zoom.
   *
   * Guarded because visualViewport is absent on old WebViews; there the pager
   * simply stays enabled, which is the behaviour before this existed.
   */
  if (window.visualViewport) {
    var lastScale = 1;
    var scaleTimer = null;
    window.visualViewport.addEventListener('resize', function () {
      var s = window.visualViewport.scale || 1;
      // Coalesce: a pinch fires this continuously and each post is a bridge
      // crossing that re-renders the pager's enabled state.
      if (Math.abs(s - lastScale) < 0.01) return;
      lastScale = s;
      if (scaleTimer) return;
      scaleTimer = setTimeout(function () {
        scaleTimer = null;
        post({ type: 'scale', scale: lastScale });
      }, 50);
    });
  }

  /*
   * Render the inlined first paint, if the host embedded one.
   *
   * Read from a JSON island rather than received as a message, so the document
   * arrived through Chromium's HTML parser instead of its JavaScript one. See
   * the initialPayload parameter for why that matters.
   *
   * boot is still posted, and posted first: the host uses it to know the script
   * is alive, and nothing about that changes. What the host skips when it has
   * inlined a payload is the content push, not the handshake -- so a build
   * where the two sides disagree renders once rather than not at all.
   */
  var initialIsland = document.getElementById('sr-initial');

  post({ type: 'boot', scroll: ${initialScroll} });

  if (initialIsland) {
    try {
      render(JSON.parse(initialIsland.textContent || 'null'));
    } catch (e) {
      // A malformed island must not leave a blank viewer with no way back: the
      // host still has the payload and pushes it on boot when no ready follows.
      post({ type: 'error', message: 'initial payload unreadable: ' + String(e) });
    }
  }
})();
</script>
</body>
</html>`
}
