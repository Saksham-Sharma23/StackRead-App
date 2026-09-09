/**
 * Makes a book's own stylesheet safe and phone-appropriate, without discarding it.
 *
 * Dropping publisher CSS entirely loses drop caps, poetry indentation, small
 * caps and heading hierarchy. Applying it untouched is worse: EPUBs are largely
 * authored for desktop, with fixed pixel type, absolute positioning and page
 * margins that leave a phone screen unreadable.
 *
 * So it is rewritten rather than chosen between:
 *
 *  1. Absolute type (`px`/`pt`) becomes relative (`em`), so the book's own size
 *     *relationships* survive while the reader's font-size control scales the
 *     whole document.
 *  2. Fixed layout — absolute/fixed positioning, hard widths and heights on
 *     containers — is dropped so text can reflow.
 *  3. Colour and background declarations are dropped when a dark theme is
 *     active, or a black-on-white book stays black-on-white.
 *  4. Anything executable or remote is removed outright.
 *  5. Every rule is scoped under the content root so nothing can restyle the
 *     viewer shell itself.
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

/** Properties dropped when the reader theme owns colour. */
const COLOUR_PROPS = ['color', 'background', 'background-color', 'background-image']

export interface NormalizeOptions {
  /** Drop author colours so the reader theme wins. */
  overrideColours?: boolean
  /** Selector every rule is scoped beneath. */
  scope?: string
}

export function normalizeBookCss(css: string, options: NormalizeOptions = {}): string {
  const { overrideColours = false, scope = '#paper' } = options

  let out = css

  // 1. Remove anything that loads or executes.
  out = out.replace(/@import[^;]+;/gi, '')
  out = out.replace(/@charset[^;]+;/gi, '')
  out = out.replace(/expression\s*\([^)]*\)/gi, '')
  out = out.replace(/javascript\s*:/gi, '')
  // Remote assets: keep only data: URIs, which are already inlined by the caller.
  out = out.replace(/url\(\s*['"]?(?!data:)[^)]*\)/gi, 'none')

  // 2. Strip comments so they cannot hide anything from the passes below.
  out = out.replace(/\/\*[\s\S]*?\*\//g, '')

  // 3. Page-box rules mean nothing on a scrolling phone.
  out = out.replace(/@page[^{]*\{[^}]*\}/gi, '')

  // 4. Rewrite declarations rule by rule.
  out = out.replace(/([^{}]+)\{([^}]*)\}/g, (_full, rawSelector: string, body: string) => {
    const selector = rawSelector.trim()
    if (!selector) return ''

    // Leave at-rules (media queries, font-face) structurally intact; their inner
    // blocks are handled by this same pass because the regex is global.
    if (selector.startsWith('@')) return `${selector}{${body}}`

    const kept = body
      .split(';')
      .map((decl) => rewriteDeclaration(decl, overrideColours))
      .filter(Boolean)
      .join(';')

    if (!kept) return ''
    return `${scopeSelector(selector, scope)}{${kept}}`
  })

  return out.trim()
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
 * Book stylesheets routinely target `body` and `html`; left alone those would
 * restyle the viewer shell, so they are rewritten to the content root itself.
 */
function scopeSelector(selectorList: string, scope: string): string {
  return selectorList
    .split(',')
    .map((sel) => {
      const s = sel.trim()
      if (!s) return ''
      if (/^(html|body)$/i.test(s)) return scope
      return `${scope} ${s.replace(/^(html|body)\s+/i, '')}`
    })
    .filter(Boolean)
    .join(',')
}
