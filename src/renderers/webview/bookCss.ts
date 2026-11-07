/**
 * Makes a book's own stylesheet safe and phone-appropriate, without discarding it.
 *
 * Dropping publisher CSS entirely loses drop caps, poetry indentation, small
 * caps, heading hierarchy and the book's own typefaces. Applying it untouched
 * is worse: EPUBs are largely authored for desktop, with fixed pixel type,
 * absolute positioning and page margins that leave a phone screen unreadable.
 *
 * So it is rewritten rather than chosen between:
 *
 *  1. Absolute type (`px`/`pt`) becomes relative (`em`), so the book's own size
 *     *relationships* survive while the reader's font-size control scales the
 *     whole document.
 *  2. Fixed layout — absolute/fixed positioning, hard widths and heights on
 *     containers — is dropped so text can reflow.
 *  3. What the reader's own controls own is dropped: colour and background
 *     (the page theme — a black-on-white book must not stay black on a dark
 *     page) and line height (the spacing control).
 *  4. Anything executable or remote is removed outright. `url()` survives only
 *     as a `data:` URI, which is how `epub.ts` inlines the book's fonts.
 *  5. Every rule is scoped under the content root so nothing can restyle the
 *     viewer shell itself — including rules nested in `@media` and
 *     `@supports`, which the previous single-regex pass let through unscoped.
 *  6. `@font-face` keeps only its descriptors, and only with a `data:` source;
 *     every other at-rule (`@page`, `@keyframes`, …) is dropped.
 *
 * ## It now actually applies
 *
 * The book's stylesheet used to be prepended to the content as a `<style>`
 * element — which the viewer's sanitiser removes, along with every other style
 * element. So none of this ever reached the page. It now travels separately
 * (`Prepared.css`) and the viewer installs it as its own stylesheet.
 */

/** Base size the book's absolute units are expressed relative to. */
const BASE_PX = 16

/** Properties that break reflow on a phone, whatever value they carry. */
const LAYOUT_BREAKING = [
  'position',
  'float',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-height',
  'left',
  'right',
  'top',
  'bottom',
  'page-break-before',
  'page-break-after',
  'column-count',
  'columns',
  'zoom',
]

/** Properties the reader's controls own: the page theme and line spacing. */
const READER_OWNED = ['line-height']

/** Properties dropped when the reader theme owns colour. */
const COLOUR_PROPS = ['color', 'background', 'background-color', 'background-image']

/** The descriptors a `@font-face` block may keep. */
const FONT_FACE_DESCRIPTORS = [
  'font-family',
  'src',
  'font-weight',
  'font-style',
  'font-stretch',
  'font-display',
  'unicode-range',
]

export interface NormalizeOptions {
  /**
   * Drop author colours so the reader theme wins. On by default: the page
   * theme can switch between light and dark while the book is open, without a
   * re-parse, so no author colour is safe to keep.
   */
  overrideColours?: boolean
  /** Selector every rule is scoped beneath. */
  scope?: string
}

export function normalizeBookCss(css: string, options: NormalizeOptions = {}): string {
  const { overrideColours = true, scope = '#paper' } = options

  // Comments first, so they cannot hide anything from the passes below.
  let out = css.replace(/\/\*[\s\S]*?\*\//g, '')

  // Remove anything that loads or executes.
  out = out.replace(/@import[^;]*;/gi, '')
  out = out.replace(/@charset[^;]*;/gi, '')
  out = out.replace(/@namespace[^;]*;/gi, '')
  out = out.replace(/expression\s*\([^)]*\)/gi, '')
  out = out.replace(/javascript\s*:/gi, '')
  /*
   * Remote assets: keep only data: URIs, which are already inlined by the
   * caller. The quote sits inside the lookahead: written as `['"]?(?!data:)`,
   * the engine could skip the optional quote, find `"data` (not `data:`) and
   * replace every *quoted* data: URI — which is how books write their fonts.
   */
  out = out.replace(/url\(\s*(?!['"]?data:)[^)]*\)/gi, 'none')

  return rewriteBlock(out, scope, overrideColours).trim()
}

/** One `prelude { body }` at the current nesting level. */
interface CssBlock {
  prelude: string
  body: string
}

/**
 * Splits a stylesheet into its top-level blocks, matching braces.
 *
 * Statements outside any block (a stray declaration, an unterminated rule)
 * are dropped. Quoted strings are skipped over, so a brace inside one does not
 * end a block.
 */
function topLevelBlocks(css: string): CssBlock[] {
  const blocks: CssBlock[] = []
  let i = 0
  let start = 0
  while (i < css.length) {
    const ch = css[i]
    if (ch === '"' || ch === "'") {
      i = skipString(css, i)
      continue
    }
    if (ch === ';') {
      // A statement at this level with no block — nothing to keep.
      start = i + 1
      i++
      continue
    }
    if (ch === '{') {
      const end = matchingBrace(css, i)
      if (end < 0) break // unterminated: the browser would discard it too
      blocks.push({ prelude: css.slice(start, i).trim(), body: css.slice(i + 1, end) })
      i = end + 1
      start = i
      continue
    }
    i++
  }
  return blocks
}

function skipString(css: string, at: number): number {
  const quote = css[at]
  let i = at + 1
  while (i < css.length && css[i] !== quote) i += css[i] === '\\' ? 2 : 1
  return i + 1
}

function matchingBrace(css: string, open: number): number {
  let depth = 0
  let i = open
  while (i < css.length) {
    const ch = css[i]
    if (ch === '"' || ch === "'") {
      i = skipString(css, i)
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

function rewriteBlock(css: string, scope: string, overrideColours: boolean): string {
  const out: string[] = []
  for (const { prelude, body } of topLevelBlocks(css)) {
    if (!prelude) continue

    if (prelude.startsWith('@')) {
      const name = prelude.slice(1).split(/[\s({]/)[0].toLowerCase()
      if (name === 'media' || name === 'supports') {
        const inner = rewriteBlock(body, scope, overrideColours)
        if (inner) out.push(`${prelude}{${inner}}`)
      } else if (name === 'font-face') {
        const face = rewriteFontFace(body)
        if (face) out.push(`@font-face{${face}}`)
      }
      // Every other at-rule — @page, @keyframes, @layer, … — is dropped.
      continue
    }

    const kept = splitDeclarations(body)
      .map((decl) => rewriteDeclaration(decl, overrideColours))
      .filter(Boolean)
      .join(';')
    if (kept) out.push(`${scopeSelector(prelude, scope)}{${kept}}`)
  }
  return out.join('\n')
}

/**
 * Splits a declaration block on `;`, but not inside parentheses or quotes —
 * a `data:` font is `url("data:font/ttf;base64,…")`, and a plain split cut it
 * in half.
 */
function splitDeclarations(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < body.length) {
    const ch = body[i]
    if (ch === '"' || ch === "'") {
      i = skipString(body, i)
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ';' && depth === 0) {
      out.push(body.slice(start, i))
      start = i + 1
    }
    i++
  }
  out.push(body.slice(start))
  return out
}

/** A `@font-face` body with only its descriptors, or null if it has no usable source. */
function rewriteFontFace(body: string): string | null {
  const kept: string[] = []
  let hasSource = false
  for (const decl of splitDeclarations(body)) {
    const at = decl.indexOf(':')
    if (at < 0) continue
    const prop = decl.slice(0, at).trim().toLowerCase()
    const value = decl.slice(at + 1).trim()
    if (!value || !FONT_FACE_DESCRIPTORS.includes(prop)) continue
    // A face whose file was not inlined has had its url() replaced with
    // `none` above, and is no use to anyone.
    if (prop === 'src') {
      if (!/url\(\s*['"]?data:/i.test(value)) continue
      hasSource = true
    }
    kept.push(`${prop}:${value}`)
  }
  return hasSource ? kept.join(';') : null
}

function rewriteDeclaration(decl: string, overrideColours: boolean): string | null {
  const at = decl.indexOf(':')
  if (at < 0) return null

  const prop = decl.slice(0, at).trim().toLowerCase()
  let value = decl.slice(at + 1).trim()
  if (!prop || !value) return null

  // `!important` in book CSS would beat the reader's own controls.
  value = value.replace(/!\s*important/gi, '').trim()
  if (!value) return null

  if (LAYOUT_BREAKING.includes(prop)) return null
  if (READER_OWNED.includes(prop)) return null
  if (overrideColours && COLOUR_PROPS.includes(prop)) return null

  // Absolute type becomes relative, so the reader's size control scales it.
  if (prop === 'font-size') {
    const rel = toRelativeSize(value)
    return rel ? `font-size:${rel}` : null
  }

  // Margins and padding in absolute units are usually desktop-sized.
  if (/^(margin|padding)(-(top|right|bottom|left))?$/.test(prop)) {
    const rel = value.replace(/(-?[\d.]+)(px|pt)/gi, (_m, n: string, unit: string) => {
      const px = unit.toLowerCase() === 'pt' ? parseFloat(n) * (96 / 72) : parseFloat(n)
      return `${(px / BASE_PX).toFixed(3)}em`
    })
    return `${prop}:${rel}`
  }

  // Images and tables must never exceed the screen.
  if (prop === 'max-width') return 'max-width:100%'

  return `${prop}:${value}`
}

/** `14px` / `11pt` / `120%` → an `em` value relative to the reader's base size. */
function toRelativeSize(value: string): string | null {
  const px = value.match(/^(-?[\d.]+)px$/i)
  if (px) return `${(parseFloat(px[1]) / BASE_PX).toFixed(3)}em`

  const pt = value.match(/^(-?[\d.]+)pt$/i)
  if (pt) return `${((parseFloat(pt[1]) * (96 / 72)) / BASE_PX).toFixed(3)}em`

  const pct = value.match(/^([\d.]+)%$/)
  if (pct) return `${(parseFloat(pct[1]) / 100).toFixed(3)}em`

  // em/rem and keywords are already relative.
  if (/^[\d.]+r?em$/i.test(value)) return value
  if (/^(smaller|larger|x{0,2}-(small|large)|small|medium|large|inherit)$/i.test(value)) {
    return value
  }
  return null
}

/**
 * Scopes a selector list under the content root.
 *
 * Book stylesheets routinely target `body`, `html` and `:root`; left alone
 * those would restyle the viewer shell, so they are rewritten to the content
 * root itself.
 */
function scopeSelector(selectorList: string, scope: string): string {
  return selectorList
    .split(',')
    .map((sel) => {
      const s = sel.trim()
      if (!s) return ''
      if (/^(html|body|:root)$/i.test(s)) return scope
      return `${scope} ${s.replace(/^(html|body|:root)\s+/i, '')}`
    })
    .filter(Boolean)
    .join(',')
}
