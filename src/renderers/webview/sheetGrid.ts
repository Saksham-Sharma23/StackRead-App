/**
 * Spreadsheet → HTML grid, with hard limits on how much of it is built.
 *
 * ## Why there are limits
 *
 * Every cell becomes a DOM node in the viewer. The only ceiling used to be the
 * file size (40 MB), and a 40 MB CSV is millions of cells: the grid string took
 * seconds to build on the JS thread, and the WebView then had to lay out a
 * million-node table, which is how its renderer process gets killed. A sheet
 * declared as `A1:XFD1048576` — common, because formatting a whole column
 * extends the range — produced 16,384 header cells for a sheet with ten values.
 *
 * So the grid shows a bounded window — the first rows and columns — and says
 * so above the table when it is cut. A phone is for reading a sheet, not for
 * scrolling a million rows of it, and a readable partial grid beats a hang.
 *
 * ## Why this is its own module
 *
 * `prepare.ts` reads files through `expo-file-system`, which cannot load under
 * Node. This imports nothing, so the limits are tested against real SheetJS
 * output in `sheetGrid.test.ts`.
 */

export interface SheetLimits {
  /** Rows shown per sheet. Also what the parser is told to read (plus one). */
  rows: number
  /** Columns shown per sheet. */
  columns: number
  /** Cells across the whole workbook — the number the WebView actually pays for. */
  cells: number
}

/*
 * 5,000 rows, 200 columns, 100,000 cells.
 *
 * `cells` is the real constraint: about the most a mid-range phone's WebView
 * lays out without stalling. `rows` and `columns` stop one dimension spending
 * the whole budget on its own — a 200-column sheet still gets 500 rows, and a
 * single-column list gets 5,000. 200 columns is far wider than anything
 * readable on a phone, and wide enough for real-world exports.
 */
export const SHEET_LIMITS: SheetLimits = { rows: 5_000, columns: 200, cells: 100_000 }

/** One sheet, in the shape `XLSX.utils.sheet_to_json(…, { header: 1 })` returns. */
export interface SheetInput {
  name: string
  /** Rows as parsed — at most `limits.rows + 1` when the parser was capped. */
  rows: unknown[][]
  /** Columns in the sheet's declared range (`!ref`), 0 if none. */
  declaredColumns: number
  merges: { s: { r: number; c: number }; e: { r: number; c: number } }[]
}

/** The two SheetJS helpers `readSheet` needs, typed structurally so this module imports nothing. */
export interface SheetUtils {
  decode_range(ref: string): { s: { r: number; c: number }; e: { r: number; c: number } }
  sheet_to_json<T>(sheet: unknown, opts: Record<string, unknown>): T[]
}

/** The slice of a SheetJS worksheet `readSheet` reads. */
export interface SheetLike {
  '!ref'?: string
  '!merges'?: SheetInput['merges']
}

/**
 * Reads one parsed worksheet into a `SheetInput`, within the column limit.
 *
 * Two SheetJS behaviours make the obvious call expensive, both on a range
 * declared across every column (`A1:XFD…`, from formatting a whole row):
 *
 *  - `sheet_to_json` walks every column of the range for every row — 16,384
 *    per row — before anything is shown;
 *  - `defval` pads every row out to that width, so a three-column sheet
 *    arrives as 16,384-wide rows and looks like real wide data.
 *
 * So the range handed to it stops one column past the limit (the extra column
 * is how a cut is detected), and there is no `defval`: a row's length is then
 * its last real value, which is what `buildWorkbookHtml` measures. Missing
 * cells render empty either way. Rows were already bounded by `sheetRows` at
 * parse time, which truncates `!ref` to match.
 *
 * Null for a sheet with no rows.
 */
export function readSheet(
  utils: SheetUtils,
  name: string,
  sheet: SheetLike,
  limits: SheetLimits = SHEET_LIMITS,
): SheetInput | null {
  const declared = sheet['!ref'] ? utils.decode_range(sheet['!ref']) : null
  const range = declared
    ? { s: declared.s, e: { r: declared.e.r, c: Math.min(declared.e.c, declared.s.c + limits.columns) } }
    : undefined

  const rows = utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: true,
    // Formatted values, so dates/currency/percentages read as authored.
    raw: false,
    ...(range ? { range } : {}),
  })
  if (!rows.length) return null

  return {
    name,
    rows,
    declaredColumns: declared ? declared.e.c - declared.s.c + 1 : 0,
    merges: sheet['!merges'] ?? [],
  }
}

export interface WorkbookHtml {
  content: string
  /** True when any sheet was cut short. */
  truncated: boolean
}

/** 0 → A, 25 → Z, 26 → AA … the spreadsheet column naming scheme. */
export function columnLetter(index: number): string {
  let n = index
  let out = ''
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/**
 * Cell text, escaped for HTML.
 *
 * A private copy rather than an import of `prepare.ts`'s `escapeHtml`: this
 * module must import nothing to run under Node, and that one is pinned in place
 * by `archiveText.test.ts`. Same five characters, ampersand first.
 */
function escapeCell(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

/**
 * Builds the tab strip and one grid per sheet, within `limits`.
 *
 * Column letters across the top and row numbers down the left, both pinned by
 * the viewer's CSS while scrolling either axis. Merged regions span from their
 * top-left cell, clipped to what is shown. Sheets are given the remaining cell
 * budget in order, so the first sheet — the one that opens — is never the one
 * that goes short; a sheet that gets no budget at all still has its tab and a
 * note rather than vanishing.
 */
export function buildWorkbookHtml(sheets: SheetInput[], limits: SheetLimits = SHEET_LIMITS): WorkbookHtml {
  const tabs: string[] = []
  const grids: string[] = []
  let budget = limits.cells
  let truncated = false

  sheets.forEach((sheet, index) => {
    const { rows } = sheet

    // Width from the declared range where present, so trailing empty columns
    // still get their letter and the grid lines up with Excel — but never past
    // the column limit, which is what a whole-column range would blow through.
    let dataWidest = 0
    const scan = Math.min(rows.length, limits.rows)
    for (let r = 0; r < scan; r++) dataWidest = Math.max(dataWidest, rows[r].length)
    // A declared range past the column limit is formatting applied to whole
    // rows, not data — honouring it would spend the cell budget on empty
    // columns. Within the limit it is kept, for the Excel alignment above.
    const declared = sheet.declaredColumns <= limits.columns ? sheet.declaredColumns : 0
    const width = Math.min(Math.max(declared, dataWidest), limits.columns)

    // A sheet with no columns costs no cells, so it is not budget-limited.
    const rowsFit = width > 0 ? Math.floor(budget / width) : Infinity
    const shownRows = Math.max(0, Math.min(rows.length, limits.rows, rowsFit))
    budget -= shownRows * width

    /*
     * Cut is judged from parsed *data*, never from the declared range.
     *
     * A declared range is routinely the whole sheet because of formatting, so
     * "of 1,048,576 rows" would be true of the range and false of the data. The
     * parser is asked for one row more than `limits.rows`, so having more rows
     * than are shown is exactly "there is more" — for CSV too, which has no
     * declared range at all. No total is claimed for the same reason.
     */
    const rowsCut = rows.length > shownRows
    const colsCut = dataWidest > width
    if (rowsCut || colsCut) truncated = true

    // Merged regions: the top-left cell spans, covered cells are omitted. Only
    // merges that start inside the window count, and each is clipped to it — a
    // merge across a whole column would otherwise fill this set with millions.
    const spanAt = new Map<string, { rs: number; cs: number }>()
    const covered = new Set<string>()
    for (const m of sheet.merges) {
      if (m.s.r >= shownRows || m.s.c >= width) continue
      const endR = Math.min(m.e.r, shownRows - 1)
      const endC = Math.min(m.e.c, width - 1)
      spanAt.set(`${m.s.r}:${m.s.c}`, { rs: endR - m.s.r + 1, cs: endC - m.s.c + 1 })
      for (let r = m.s.r; r <= endR; r++) {
        for (let c = m.s.c; c <= endC; c++) {
          if (r !== m.s.r || c !== m.s.c) covered.add(`${r}:${c}`)
        }
      }
    }

    const letters: string[] = []
    for (let c = 0; c < width; c++) letters.push(`<th class="sr-colhead">${columnLetter(c)}</th>`)

    const body: string[] = []
    for (let r = 0; r < shownRows; r++) {
      const row = rows[r]
      const cells: string[] = []
      for (let c = 0; c < width; c++) {
        if (covered.has(`${r}:${c}`)) continue
        const span = spanAt.get(`${r}:${c}`)
        const attrs =
          (span && span.rs > 1 ? ` rowspan="${span.rs}"` : '') +
          (span && span.cs > 1 ? ` colspan="${span.cs}"` : '')
        const v = c < row.length ? row[c] : ''
        cells.push(`<td${attrs}>${escapeCell(v == null ? '' : String(v))}</td>`)
      }
      // Row number pinned to the left, as in every spreadsheet.
      body.push(`<tr><th class="sr-rowhead">${r + 1}</th>${cells.join('')}</tr>`)
    }

    const note = rowsCut || colsCut ? truncationNote(shownRows, rowsCut, width, colsCut) : ''

    const active = index === 0 ? ' active' : ''
    tabs.push(`<button class="sr-tab${active}" data-sheet="${index}">${escapeCell(sheet.name)}</button>`)
    grids.push(
      `<div class="sr-sheet${active}" data-sheet="${index}">` +
        note +
        `<div class="sr-scroll-x"><table class="sr-grid">` +
        `<thead><tr><th class="sr-corner"></th>${letters.join('')}</tr></thead>` +
        `<tbody>${body.join('')}</tbody>` +
        `</table></div></div>`,
    )
  })

  const strip = grids.length > 1 ? `<div class="sr-tabs">${tabs.join('')}</div>` : ''
  return { content: `${strip}${grids.join('')}`, truncated }
}

/** "Showing the first 5,000 rows and columns A–GR. Open the file in …" */
function truncationNote(shownRows: number, rowsCut: boolean, shownCols: number, colsCut: boolean): string {
  const tail = 'Open the file in a spreadsheet app to see all of it.'
  if (shownRows === 0) {
    return `<p class="sr-sheet-note">This sheet is too large to show here. ${tail}</p>`
  }
  const parts: string[] = []
  if (rowsCut) parts.push(`the first ${shownRows.toLocaleString('en-US')} rows`)
  if (colsCut) parts.push(`columns A–${columnLetter(shownCols - 1)}`)
  return `<p class="sr-sheet-note">Showing ${parts.join(' and ')}. ${tail}</p>`
}
