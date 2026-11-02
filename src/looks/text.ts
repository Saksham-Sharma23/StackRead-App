/**
 * Text helpers for the optional looks. Pure, so the tests run them directly.
 *
 * Classic shows the raw file name, and keeps doing so.
 */

/**
 * A readable title from a file name: "01-install-jdk-and-tools.md" →
 * "Install jdk and tools".
 *
 * - the extension goes;
 * - a leading number of up to three digits and its separator go ("01-",
 *   "01 - ", "1. ", "02_"), because the looks show the file's position
 *   separately. Four digits are left alone: "2024 report" is a year, not a
 *   position;
 * - in a slug (a name with no spaces) dashes and underscores become spaces —
 *   but a name that already has spaces keeps its dashes ("Results — draft 3");
 * - an all-lower-case result gets a capital first letter.
 *
 * Falls back to the name without its extension if cleaning would leave nothing
 * (a file called "01.md" is better shown as "01" than as "").
 */
export function cleanTitle(name: string): string {
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, '')
  let s = base.replace(/^\s*\d{1,3}\s*(?:[-_.)]\s*|\s+)/, '')
  s = /\s/.test(s) ? s.replace(/_+/g, ' ') : s.replace(/[-_]+/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  if (!s) return base
  if (s === s.toLowerCase()) s = s[0].toUpperCase() + s.slice(1)
  return s
}

/** A card's position in its group, as the looks print it: 1 → "01", 120 → "120". */
export function positionLabel(index: number): string {
  return String(index + 1).padStart(2, '0')
}

/**
 * A text progress bar for the Terminal look: 35, 8 → "███·····".
 *
 * Rounds to the nearest cell but never shows a started file as empty or an
 * unfinished one as full — a reader who has opened a file should see a mark,
 * and one who has not finished should not see a solid bar.
 */
export function textBar(percent: number, cells = 8): string {
  const p = Math.max(0, Math.min(100, percent))
  let k = Math.round((p / 100) * cells)
  if (p > 0 && k === 0) k = 1
  if (p < 100 && k === cells) k = cells - 1
  return '█'.repeat(k) + '·'.repeat(cells - k)
}
