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
 * Attributes whose value is a URL, matched on the *local* name so `xlink:href`
 * is covered as well as `href`. Same list as `isUrlAttr` in the viewer.
 */
const URL_ATTRS: ReadonlySet<string> = new Set(['href', 'src', 'action', 'formaction', 'data', 'poster'])

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

/** Strips the HTML entities and padding an attribute value may hide a scheme behind. */
function decodeAttrValue(raw: string): string {
  // Decode numeric and named entities well enough to see the scheme through
  // `java&#09;script:` and friends. Not a general entity decoder — it only has
  // to defeat padding inside a scheme prefix.
  return raw
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

  // Attributes last, on what is left: handlers, inline styles, executable URLs.
  return rewriteStartTags(out)
}

/**
 * Whether an attribute may stay on an element.
 *
 * Judged on the local name (after any `ns:` prefix), so `ev:onload` is a handler
 * and `xlink:href` a URL attribute.
 */
function keepAttribute(name: string, value: string | null): boolean {
  const lower = name.toLowerCase()
  const colon = lower.lastIndexOf(':')
  const local = colon >= 0 ? lower.slice(colon + 1) : lower
  if (local.startsWith('on')) return false
  if (local === 'style') return false
  if (value !== null && URL_ATTRS.has(local) && EXECUTABLE_SCHEME.test(decodeAttrValue(value))) {
    return false
  }
  return true
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f'
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

/**
 * Rewrites every start tag, attribute by attribute, the way the HTML tokenizer
 * reads it ([AUDIT4 D1](../../../AUDIT4.md)).
 *
 * ## Why not attribute regexes
 *
 * They were regexes — `\s on…= …` — and HTML does not need whitespace between
 * attributes. A `/` separates them too: after a tag name (`<svg/onload=…>`),
 * after a quoted value (`<img src="x"/onerror=…>`) and after a bare attribute
 * name (`<details open/ontoggle=…>`). All three walked past the `\s` and are
 * live handlers to a browser. Requiring `[\s/]` instead would have caught them
 * and broken ordinary markup: a `/on…=` inside a quoted URL
 * (`href="https://x/onboarding=1"`) would have been cut out along with the
 * quote that closes the value. Telling those apart is the tokenizer's job, so
 * this does what the tokenizer does.
 *
 * ## What it does
 *
 * For each `<name …>`: reads attributes per the HTML tokenizer's rules (any
 * run of whitespace and `/` separates them; values are double-quoted,
 * single-quoted or bare; `>` inside a quoted value does not end the tag), drops
 * the ones `keepAttribute` rejects, and writes the tag back with every value
 * double-quoted. A tag left unterminated at the end of the input is dropped —
 * the browser would discard it too. End tags, comments and stray `<` pass
 * through untouched.
 *
 * Re-quoting normalises markup the browser would parse identically: `"` inside
 * a value becomes `&quot;`, which decodes back to the same character.
 */
function rewriteStartTags(html: string): string {
  const n = html.length
  let out = ''
  let i = 0

  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt < 0) {
      out += html.slice(i)
      break
    }
    out += html.slice(i, lt)
    if (!isAsciiLetter(html.charCodeAt(lt + 1))) {
      out += '<'
      i = lt + 1
      continue
    }

    let j = lt + 1
    while (j < n && !isSpace(html[j]) && html[j] !== '/' && html[j] !== '>') j++
    const tagName = html.slice(lt + 1, j)

    const kept: string[] = []
    let selfClosing = false
    let closed = false

    while (j < n) {
      const ch = html[j]
      if (isSpace(ch)) {
        j++
        continue
      }
      if (ch === '/') {
        if (html[j + 1] === '>') {
          selfClosing = true
          closed = true
          j += 2
          break
        }
        // A `/` not followed by `>` is just a separator.
        j++
        continue
      }
      if (ch === '>') {
        closed = true
        j++
        break
      }

      // The name runs to whitespace, `/`, `>` or `=`. A leading `=` belongs
      // to the name, as it does for the tokenizer.
      let k = j + 1
      while (k < n && !isSpace(html[k]) && html[k] !== '/' && html[k] !== '>' && html[k] !== '=') k++
      const attrName = html.slice(j, k)
      j = k
      while (j < n && isSpace(html[j])) j++

      let value: string | null = null
      if (html[j] === '=') {
        j++
        while (j < n && isSpace(html[j])) j++
        const quote = html[j]
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, j + 1)
          value = html.slice(j + 1, end < 0 ? n : end)
          j = end < 0 ? n : end + 1
        } else {
          let k2 = j
          while (k2 < n && !isSpace(html[k2]) && html[k2] !== '>') k2++
          value = html.slice(j, k2)
          j = k2
        }
      }

      if (keepAttribute(attrName, value)) {
        kept.push(value === null ? attrName : `${attrName}="${value.replace(/"/g, '&quot;')}"`)
      }
    }

    // Unterminated at the end of the input: the browser drops it, and so do we.
    if (!closed) break

    out += `<${tagName}${kept.length ? ` ${kept.join(' ')}` : ''}${selfClosing ? ' /' : ''}>`
    i = j
  }

  return out
}
