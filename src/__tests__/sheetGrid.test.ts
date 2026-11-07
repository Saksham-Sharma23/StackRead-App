import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

import { SHEET_LIMITS, buildWorkbookHtml, columnLetter, readSheet, type SheetInput } from '../renderers/webview/sheetGrid.ts'

/*
 * Large spreadsheets used to hang or kill the reader: every cell became a DOM
 * node, the only ceiling was the 40 MB file size, and a whole-row formatted
 * range produced 16,384 column headers. The grid is now bounded by rows,
 * columns and total cells, and the parser is told to stop at the row limit.
 */

const require = createRequire(import.meta.url)
const XLSX = require('xlsx') as typeof import('xlsx')

const rowCount = (html: string) => html.split('<th class="sr-rowhead">').length - 1
const colCount = (html: string) => html.split('<th class="sr-colhead">').length - 1

/** Parses bytes exactly the way `prepareSheet` does. */
function parse(bytes: Uint8Array): SheetInput[] {
  const wb = XLSX.read(bytes, { type: 'array', cellDates: true, sheetRows: SHEET_LIMITS.rows + 1 })
  return wb.SheetNames.map((name) => readSheet(XLSX.utils, name, wb.Sheets[name])).filter((s): s is SheetInput => s !== null)
}

function sheet(name: string, rows: number, cols: number, extra: Partial<SheetInput> = {}): SheetInput {
  return {
    name,
    rows: Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => `${r}:${c}`)),
    declaredColumns: cols,
    merges: [],
    ...extra,
  }
}

test('column letters follow the spreadsheet scheme', () => {
  assert.equal(columnLetter(0), 'A')
  assert.equal(columnLetter(25), 'Z')
  assert.equal(columnLetter(26), 'AA')
  assert.equal(columnLetter(199), 'GR')
  assert.equal(columnLetter(16383), 'XFD')
})

test('a small workbook is shown whole, with no note', () => {
  const out = buildWorkbookHtml([sheet('One', 12, 4)])
  assert.equal(out.truncated, false)
  assert.equal(rowCount(out.content), 12)
  assert.equal(colCount(out.content), 4)
  assert.doesNotMatch(out.content, /sr-sheet-note/)
  assert.doesNotMatch(out.content, /sr-tabs/, 'one sheet needs no tab strip')
})

test('a 20,000-row CSV is parsed and shown only up to the row limit', () => {
  const csv = Array.from({ length: 20_000 }, (_, i) => `${i},name ${i},${i * 2}`).join('\n')
  const sheets = parse(new Uint8Array(Buffer.from(csv)))

  assert.equal(sheets[0].rows.length, SHEET_LIMITS.rows + 1, 'the parser itself stops one row past the limit')
  const out = buildWorkbookHtml(sheets)
  assert.equal(rowCount(out.content), SHEET_LIMITS.rows)
  assert.equal(out.truncated, true)
  assert.match(out.content, /Showing the first 5,000 rows\./)
})

test('a 20,000-row XLSX is cut the same way, and a whole-row range adds no columns', () => {
  const ws = XLSX.utils.aoa_to_sheet(Array.from({ length: 20_000 }, (_, i) => [i, `row ${i}`]))
  const wide = XLSX.utils.aoa_to_sheet([['a', 'b', 'c']])
  wide['!ref'] = 'A1:XFD1' // formatting across the whole row
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Long')
  XLSX.utils.book_append_sheet(wb, wide, 'Formatted')
  const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)

  const sheets = parse(bytes)
  assert.equal(sheets[0].rows.length, SHEET_LIMITS.rows + 1)
  const [long, formatted] = buildWorkbookHtml(sheets).content.split('<div class="sr-sheet').slice(1)
  assert.equal(rowCount(long), SHEET_LIMITS.rows)
  assert.equal(colCount(formatted), 3)
})

test('exactly the row limit is not reported as cut', () => {
  const csv = Array.from({ length: SHEET_LIMITS.rows }, (_, i) => `${i},x`).join('\n')
  const out = buildWorkbookHtml(parse(new Uint8Array(Buffer.from(csv))))
  assert.equal(rowCount(out.content), SHEET_LIMITS.rows)
  assert.equal(out.truncated, false)
})

test('a range declared across every column does not build 16,384 headers', () => {
  // Formatting a whole row declares A:XFD while the data is three columns wide.
  const out = buildWorkbookHtml([sheet('Formatted', 10, 3, { declaredColumns: 16_384 })])
  assert.equal(colCount(out.content), 3)
  assert.equal(out.truncated, false)
})

test('a declared range within the limit still lines up with Excel', () => {
  const out = buildWorkbookHtml([sheet('Trailing', 5, 2, { declaredColumns: 6 })])
  assert.equal(colCount(out.content), 6, 'trailing empty columns keep their letters')
})

test('real data wider than the column limit is cut and says so', () => {
  const out = buildWorkbookHtml([sheet('Wide', 10, 300)])
  assert.equal(colCount(out.content), SHEET_LIMITS.columns)
  assert.match(out.content, /Showing columns A–GR\./)
})

test('the cell budget is shared across sheets, first sheet first', () => {
  const limits = { rows: 5_000, columns: 200, cells: 100_000 }
  const out = buildWorkbookHtml([sheet('First', 1_000, 100), sheet('Second', 1_000, 100)], limits)
  const [first, second] = out.content.split('<div class="sr-sheet').slice(1)
  assert.equal(rowCount(first), 1_000, 'the sheet that opens is never the one that goes short')
  assert.equal(rowCount(second), 0)
  assert.match(second, /This sheet is too large to show here\./)
  assert.match(out.content, /data-sheet="1">Second</, 'an empty-budget sheet keeps its tab')
})

test('no workbook builds more cells than the budget', () => {
  const sheets = [sheet('A', 4_000, 40), sheet('B', 4_000, 40), sheet('C', 4_000, 40)]
  const out = buildWorkbookHtml(sheets)
  const cells = out.content.split('<td').length - 1
  assert.ok(cells <= SHEET_LIMITS.cells, `${cells} cells is over the budget`)
})

test('a merge across a whole column is clipped to the shown rows', () => {
  const s = sheet('Merged', 20, 2, { merges: [{ s: { r: 0, c: 0 }, e: { r: 1_048_575, c: 0 } }] })
  const out = buildWorkbookHtml([s])
  assert.match(out.content, /rowspan="20"/)
  assert.equal(out.content.split('<td').length - 1, 1 + 20, 'one spanning cell plus column B')
})

test('cell text and sheet names are escaped', () => {
  const s: SheetInput = { name: '<b>tab</b>', rows: [['<script>x</script>', 'a & "b"']], declaredColumns: 2, merges: [] }
  const out = buildWorkbookHtml([s, sheet('Two', 1, 1)]).content
  assert.doesNotMatch(out, /<script>|<b>/)
  assert.match(out, /&lt;script&gt;x&lt;\/script&gt;/)
  assert.match(out, /a &amp; &quot;b&quot;/)
})

test('prepareSheet tells the parser to stop at the row limit', () => {
  const prepare = readFileSync(new URL('../renderers/webview/prepare.ts', import.meta.url), 'utf8')
  const fn = prepare.slice(prepare.indexOf('async function prepareSheet'), prepare.indexOf('async function prepareDocx'))
  assert.match(fn, /sheetRows: SHEET_LIMITS\.rows \+ 1/)
  assert.match(fn, /readSheet\(XLSX\.utils, name, sheet\)/, 'the same reader these tests exercise')
  assert.match(fn, /buildWorkbookHtml\(sheets\)/)
})

test('a real 300-column sheet is read one column past the limit, and cut', () => {
  const row = Array.from({ length: 300 }, (_, c) => `c${c}`)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([row, row]), 'Wide')
  const sheets = parse(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer))
  assert.equal(sheets[0].rows[0].length, SHEET_LIMITS.columns + 1, 'never more than one column past the limit')
  const out = buildWorkbookHtml(sheets)
  assert.equal(colCount(out.content), SHEET_LIMITS.columns)
  assert.match(out.content, /Showing columns A–GR\./)
})

test('missing cells render empty, so dropping defval loses nothing', () => {
  const ws = XLSX.utils.aoa_to_sheet([['a', null, 'c'], [], ['x']])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Gaps')
  const out = buildWorkbookHtml(parse(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)))
  assert.equal(rowCount(out.content), 3, 'a blank row is still a row')
  assert.equal(out.content.split('<td').length - 1, 9, 'every row is the full three columns wide')
})
