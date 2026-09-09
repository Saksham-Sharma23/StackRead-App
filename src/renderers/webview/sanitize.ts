/**
 * Native-side pre-sanitiser for file-supplied HTML.
 *
 * The viewer already sanitises what it is given (`sanitize()` in
 * `viewerHtml.ts`), and that pass is **structurally** the stronger of the two:
 * it works on a parsed DOM, so it cannot be fooled by the malformed markup that
 * defeats regexes. This exists in front of it, not instead of it.
 *
 * That qualifier is deliberate and was earned. The header used to call the DOM
 * pass "the stronger of the two" without one, which was true of its tree
 * handling and false of its *scheme check*: that tested a raw, merely-trimmed
 * value, so `java&#09;script:` walked past it while the regex below caught it.
 * A comment claiming the inner layer is uniformly stronger is how a later
 * refactor deletes the outer one — "the DOM pass handles schemes, this is
 * belt-and-braces". The viewer's check now decodes entities and strips control
 * characters exactly as this module does, so the two finally agree; the wording
 * stays precise so it cannot drift back into a claim nobody verifies.
 *
 * The reason for a second pass is where the first one runs. The viewer's
 * sanitiser executes *inside* the WebView, which means the untrusted markup has
 * already crossed the bridge and been through `DOMParser` before anything
 * inspects it. A book is a file that arrives from anywhere — a download, a
 * mailing list, a torrent — so the parser that first sees it should not be the
 * one sitting next to the JavaScript context.
 *
 * What this catches that the viewer's pass does not:
 *
 *  - `style` attributes. The viewer strips `<style>` *elements* but leaves
 *    inline `style` alone, which permits CSS that loads remote URLs. With no
 *    network access reaching the WebView that is largely defanged, but "largely"
 *    is doing real work in that sentence and the attribute buys the document
 *    nothing here — typography is controlled by reader settings.
 * Namespaced event handlers on SVG (`xlink:href="javascript:…"`, `ev:onload`)
 * used to belong on that list too. They no longer do: the viewer's pass now
 * matches on an attribute's *local* name and covers the same URL attributes
 * this module does, so both catch them. Recorded rather than deleted, because
 * "the outer pass is the only thing catching X" is exactly the kind of claim
 * that goes stale silently — and here it did.
 *
 * Deliberately conservative about what it removes: this runs on every EPUB
 * chapter, and stripping something a book legitimately uses is a visible
 * regression, whereas leaving it for the DOM pass is not.
 */

/** Elements that can execute, navigate, or fetch. Removed with their content. */
const VOID_OF_MEANING = /<(script|iframe|object|embed|applet|frame|frameset|noscript)\b[\s\S]*?<\/\1\s*>/gi

/** The same tags when self-closed or unterminated, plus the empty ones. */
const DANGLING = /<\/?(script|iframe|object|embed|applet|frame|frameset|noscript|base|meta|link)\b[^>]*>/gi

/**
 * Event-handler attributes, including namespaced ones (`ev:onload`).
 *
 * The value is matched as quoted, single-quoted, or bare, because an unquoted
 * handler is legal HTML and a naive `on\w+="[^"]*"` walks straight past it.
 */
const EVENT_ATTR = /\s(?:[a-z0-9_-]+:)?on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi

/** Inline styles — see the note above on why these go. */
const STYLE_ATTR = /\s(?:[a-z0-9_-]+:)?style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi

/**
 * URL attributes carrying an executable scheme.
 *
 * Covers `xlink:href` as well as `href`/`src`, and tolerates the whitespace and
 * entity padding (`java\tscript:`, `java&#09;script:`) used to slip past a
 * literal prefix match.
 */
const SCRIPT_URL =
  /\s(?:[a-z0-9_-]+:)?(?:href|src|action|formaction|data|poster)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi

/*
 * The `\s*` between every letter defeats the padding trick: `java script:` and
 * `java&#09;script:` both reach the browser's URL parser as `javascript:`.
 *
 * Each alternative carries its own terminator rather than sharing a trailing
 * `:` — `data:text/html` is followed by `;base64,...`, not by another colon, so
 * a shared terminator silently failed to match the one scheme most worth
 * catching.
 */
const EXECUTABLE_SCHEME =
  /^(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:|v\s*b\s*s\s*c\s*r\s*i\s*p\s*t\s*:|d\s*a\s*t\s*a\s*:\s*t\s*e\s*x\s*t\s*\/\s*h\s*t\s*m\s*l)/i

/** Strips the quoting and HTML entities an attribute value may hide behind. */
function attrValue(pair: string): string {
  const eq = pair.indexOf('=')
  if (eq < 0) return ''
  let v = pair.slice(eq + 1).trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1)
  }
  // Decode numeric and named entities well enough to see the scheme through
  // `java&#09;script:` and friends. Not a general entity decoder — it only has
  // to defeat padding inside a scheme prefix.
  return v
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d: string) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&(tab|newline);/gi, ' ')
    // Strip the control characters and whitespace used as padding. The scheme
    // regex already tolerates spaces between letters; this removes the NULs and
    // tabs that a literal prefix match would trip over.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0020]/g, '')
}

/**
 * Removes executable and remote-loading constructs from untrusted HTML.
 *
 * Returns HTML, not text: the document's structure and formatting are the point
 * of rendering it at all.
 */
export function sanitizeHtml(html: string): string {
  let out = html

  // Comments first: a handler hidden in a conditional comment is invisible to
  // the attribute passes but not to a browser's parser.
  out = out.replace(/<!--[\s\S]*?-->/g, '')

  out = out.replace(VOID_OF_MEANING, '')
  out = out.replace(DANGLING, '')

  // <style> elements: the viewer removes these too, but doing it here keeps the
  // two passes agreeing about what a document is allowed to contain.
  out = out.replace(/<style\b[\s\S]*?<\/style\s*>/gi, '')

  out = out.replace(EVENT_ATTR, '')
  out = out.replace(STYLE_ATTR, '')

  out = out.replace(SCRIPT_URL, (match) =>
    EXECUTABLE_SCHEME.test(attrValue(match)) ? '' : match,
  )

  return out
}
