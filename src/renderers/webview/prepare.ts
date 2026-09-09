import { File } from 'expo-file-system'
import { strFromU8 } from 'fflate'

import type { FileEntry } from '../../types'
import { LIBRARY_DIR } from '../../storage/paths'
import { formatBytes, MAX_PREPARE_BYTES } from '../../storage/formats'
import { loadEpubAsHtml } from './epub'
import { mimeForImage } from './bytes'
// Base64 encoding is no longer done here: images are carried as raw bytes and
// encoded once, lazily, as they are delivered to the viewer.
import { unzipOffThread, type OffloadLane } from './offload'
import { beginPrepare, now, type PrepareTrace } from '../../ui/perf'
import { sanitizeHtml } from './sanitize'
import {
  CHARS_PER_PAGE,
  CHARS_PER_PAGE_DOCX,
  pagesFromChars,
  visibleTextLength,
  type TocEntry,
} from './pagination'

/**
 * Turns a file into something the WebView viewer can display.
 *
 * Every format the desktop app rendered as HTML converges here. Adding a new
 * one means writing a function in this file — no native module, no new renderer
 * component, no change to the pager. That is the whole point of the WebView
 * host.
 */

export interface Prepared {
  /** How the viewer should treat `content`. */
  format: 'markdown' | 'html' | 'epub' | 'text'
  content: string
  /**
   * How the viewer should measure and present it.
   *
   *  - `paper` — reflowable text laid out as A4-proportioned sheets.
   *  - `items` — genuinely discrete pages (comic images), counted exactly.
   *  - `flow`  — a grid or listing where a page count would be meaningless.
   */
  mode: 'paper' | 'items' | 'flow'
  /**
   * Page count derived from the **content**, never from how it renders.
   *
   * Zero means "no meaningful page count" (a spreadsheet grid); the viewer then
   * hides the page indicator.
   */
  totalPages: number
  /** Chapter list, for formats that carry one. */
  toc?: TocEntry[]
  /**
   * Content held back from the first paint, delivered afterwards.
   *
   * A long EPUB is seconds of string assembly and its HTML is megabytes, so
   * pushing all of it before anything renders means staring at a spinner for
   * the whole parse. `content` therefore carries only enough to fill the first
   * screens; these chunks are appended once the viewer reports `ready`.
   *
   * Undefined for every format that has nothing to defer — a text file or a
   * spreadsheet is already whole.
   *
   * **`totalPages` is unaffected by this split.** It is computed from the
   * entire book's extracted text during parsing, before any of it renders, so
   * it cannot become a function of how much has arrived yet. That property is
   * the whole point of deriving pages from content rather than layout, and a
   * streaming loader is exactly where it would be easy to break.
   */
  rest?: string[]
  /**
   * Content still to be assembled, deferred until the first paint is on screen.
   *
   * EPUB only. Calling it returns the remaining batches **and the exact page
   * count**, which replaces the provisional one carried in `totalPages`.
   *
   * Not serialisable, and `diskCache` declines any entry carrying one — a
   * persisted thunk would be a document that could never finish loading.
   */
  loadRest?: () => Promise<{ rest: string[]; totalPages: number }>
  /**
   * Decompresses the images `images` refers to, when the renderer wants them.
   *
   * Absent for a document whose images were produced eagerly rather than
   * referenced — the comic and archive paths still do that today.
   */
  loadImages?: () => Promise<PreparedImage[]>
  /**
   * Images the markup references by token, delivered separately.
   *
   * Kept out of the HTML on purpose. Embedded as `data:` URIs they cost ~4/3 of
   * their bytes as string, held in the prepared-document cache, concatenated
   * into one document and duplicated again across the bridge — roughly triple
   * the underlying size, which is what made a heavily illustrated EPUB exhaust
   * memory. Streamed as binary and turned into `blob:` URLs in the viewer, the
   * browser holds them once and decodes them lazily.
   *
   * Undefined for formats with no images to defer.
   */
  images?: PreparedImage[]
  /**
   * Images referenced but not yet fetched, paired with `loadImages`.
   *
   * Separate from `images` on purpose: the two are not interchangeable and a
   * single field holding either would let a consumer read `bytes` off something
   * that has none.
   */
  imageRefs?: PreparedImageRef[]
}

export interface PreparedImage {
  /** Matches a `data-sr-img` attribute in the markup. */
  token: string
  mime: string
  bytes: Uint8Array
}

/**
 * An image the markup refers to whose bytes have not been fetched yet.
 *
 * The EPUB path produces these instead of `PreparedImage`, so a book can be
 * parsed and cached without its illustrations being decompressed, crossing the
 * worklet boundary, or occupying the prepared-document cache. `loadImages`
 * turns them into the real thing at delivery time.
 */
export interface PreparedImageRef {
  token: string
  mime: string
}

/*
 * The whole-file ceiling now lives in `storage/formats` as `MAX_PREPARE_BYTES`,
 * per format, and is enforced at the top of `prepareFile` before any read.
 *
 * It was a single 6MB constant here, checked only in the plain-text branch, so
 * the four formats that actually needed it — DOCX, XLSX, CBZ, ZIP — had no
 * limit at all. Moving it next to the format table is what makes "every format
 * has a ceiling" checkable by looking at one place.
 */

const MAX_INLINE_IMAGE_BYTES = 2_000_000

/**
 * Total image budget for one document.
 *
 * Matches the EPUB budget in `epub.ts` and exists for the same reason: a
 * per-image cap alone lets forty individually-reasonable pages add up to
 * something that exhausts memory.
 *
 * Measured in raw bytes now that images are streamed as binary rather than
 * embedded as base64 — the old accounting had to charge ~4/3 per image to
 * reflect the string cost, and then that string was duplicated across the
 * bridge on top.
 */
const MAX_TOTAL_IMAGE_BYTES = 24_000_000

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i
const TEXT_RE = /\.(txt|md|markdown|log|json|xml|csv|tsv|html?|js|ts|css)$/i

/** Natural sort, so page2 precedes page10. */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
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
 * Spreadsheets -> a real grid: column letters across the top, row numbers down
 * the left, both pinned while scrolling either axis.
 *
 * Built by hand rather than with `XLSX.utils.sheet_to_html`, which emits no
 * `<thead>` for the sticky header to attach to and no row/column headers at all.
 *
 * Cells are read with `cellDates` and converted with `raw: false`, which is what
 * makes a date show as `15/01/2024` rather than the underlying Excel serial
 * number `45306`. Reading raw values was a real data-correctness bug.
 */
async function prepareSheet(bytes: Uint8Array): Promise<Prepared> {
  /*
   * Imported lazily, for exactly the reason `prepareDocx` imports mammoth
   * lazily — and this was a static import for far too long while that one sat
   * ten lines below it, correct and explained.
   *
   * SheetJS resolves to `xlsx.js`, which is ~975KB of JavaScript. Expo SDK 57's
   * Metro config sets `inlineRequires: false`
   * (`@expo/metro-config/build/ExpoMetroConfig.js`), so there is no lazy-require
   * rescue: a static import here is evaluated during app startup, before the
   * splash can hide, on every cold launch — for every user, whether or not they
   * own a single spreadsheet.
   */
  const XLSX = await import('xlsx')

  const wb = XLSX.read(bytes, { type: 'array', cellDates: true })

  const tabs: string[] = []
  const sheets: string[] = []

  wb.SheetNames.forEach((name, index) => {
    const sheet = wb.Sheets[name]
    if (!sheet) return

    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: true,
      defval: '',
      // Formatted values, so dates/currency/percentages read as authored.
      raw: false,
    })
    if (!rows.length) return

    // Width comes from the declared range where present, so trailing empty
    // columns still get their letter and the grid lines up with Excel.
    const declared = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null
    const widest = Math.max(
      declared ? declared.e.c + 1 : 0,
      rows.reduce((max, r) => Math.max(max, r.length), 0),
    )

    // Merged regions: the top-left cell spans, the covered cells are omitted.
    const merges = sheet['!merges'] ?? []
    const spanAt = new Map<string, { rs: number; cs: number }>()
    const covered = new Set<string>()
    for (const m of merges) {
      spanAt.set(`${m.s.r}:${m.s.c}`, { rs: m.e.r - m.s.r + 1, cs: m.e.c - m.s.c + 1 })
      for (let r = m.s.r; r <= m.e.r; r++) {
        for (let c = m.s.c; c <= m.e.c; c++) {
          if (r !== m.s.r || c !== m.s.c) covered.add(`${r}:${c}`)
        }
      }
    }

    const letters = Array.from(
      { length: widest },
      (_, c) => `<th class="sr-colhead">${columnLetter(c)}</th>`,
    ).join('')

    const body = rows
      .map((row, r) => {
        const cells: string[] = []
        for (let c = 0; c < widest; c++) {
          if (covered.has(`${r}:${c}`)) continue
          const span = spanAt.get(`${r}:${c}`)
          const attrs =
            (span?.rs && span.rs > 1 ? ` rowspan="${span.rs}"` : '') +
            (span?.cs && span.cs > 1 ? ` colspan="${span.cs}"` : '')
          const v = c < row.length ? row[c] : ''
          cells.push(`<td${attrs}>${escapeHtml(v == null ? '' : String(v))}</td>`)
        }
        // Row number pinned to the left, as in every spreadsheet.
        return `<tr><th class="sr-rowhead">${r + 1}</th>${cells.join('')}</tr>`
      })
      .join('')

    const active = index === 0 ? ' active' : ''
    tabs.push(
      `<button class="sr-tab${active}" data-sheet="${index}">${escapeHtml(name)}</button>`,
    )
    sheets.push(
      `<div class="sr-sheet${active}" data-sheet="${index}">` +
        `<div class="sr-scroll-x"><table class="sr-grid">` +
        `<thead><tr><th class="sr-corner"></th>${letters}</tr></thead>` +
        `<tbody>${body}</tbody>` +
        `</table></div></div>`,
    )
  })

  if (!sheets.length) throw new Error('This workbook has no readable sheets')

  const strip = sheets.length > 1 ? `<div class="sr-tabs">${tabs.join('')}</div>` : ''

  // `flow`: a grid has no pages, so the reader hides the page indicator and
  // navigation happens through the tabs instead.
  return {
    format: 'html',
    content: `${strip}${sheets.join('')}`,
    mode: 'flow',
    totalPages: 0,
  }
}

/**
 * DOCX -> HTML, via mammoth's browser build.
 *
 * ## Why `Buffer` is installed here
 *
 * `mammoth.browser.js` is a pre-built browserify bundle that calls
 * `Buffer.from` in a dozen places **without guarding for its existence** — it
 * assumes the browserify shim normally linked in at build time. Hermes has no
 * `Buffer` global and React Native does not polyfill one, so any code path
 * reaching those calls would throw `Property 'Buffer' doesn't exist`.
 *
 * **Precautionary, not a confirmed fix.** Attempting to reproduce it under Node
 * with the global deleted still converted successfully — JSZip, which does the
 * unzipping, has its own typed-array fallbacks and may avoid the `Buffer` paths
 * for the documents tried. So this guards a hazard that is real in the source
 * but was not observed end to end; a DOCX with an embedded image or an unusual
 * encoding is the likely trigger if it ever does fire.
 *
 * It costs nothing when unnecessary: the check is one `typeof`, and the
 * polyfill is a pure-JS package loaded only inside this lazily-imported
 * function, so a session that never opens a DOCX never loads it. Assigned to
 * `globalThis` because mammoth reads the global directly and offers no
 * injection point, and only when genuinely absent so a future runtime that
 * provides one wins.
 */
async function prepareDocx(bytes: Uint8Array): Promise<Prepared> {
  if (typeof (globalThis as { Buffer?: unknown }).Buffer === 'undefined') {
    const { Buffer } = await import('buffer')
    ;(globalThis as { Buffer?: unknown }).Buffer = Buffer
  }

  // Imported lazily: mammoth is heavy and most sessions never open a DOCX.
  // Must come *after* the polyfill above — the bundle touches `Buffer` while
  // it initialises, not only when converting.
  const mammoth = await import('mammoth/mammoth.browser')

  // Copy into a plain ArrayBuffer — mammoth rejects a Uint8Array view.
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer

  const result = await mammoth.convertToHtml({ arrayBuffer: buf })
  if (!result.value.trim()) throw new Error('This document appears to be empty')

  // mammoth's output is derived from an untrusted document, so it is treated as
  // untrusted itself. See sanitize.ts for why this happens here and not only in
  // the viewer.
  const html = sanitizeHtml(result.value)

  // A Word page holds roughly 300 words at standard formatting — noticeably
  // more text than a paperback page, hence its own divisor.
  return {
    format: 'html',
    content: html,
    mode: 'paper',
    totalPages: pagesFromChars(visibleTextLength(html), CHARS_PER_PAGE_DOCX),
  }
}

/** CBZ -> a vertical stack of page images, naturally sorted. */
async function prepareComic(
  bytes: Uint8Array,
  lane: OffloadLane,
  trace?: PrepareTrace,
): Promise<Prepared> {
  // A comic is the heaviest of these: dozens of full-page images, each unzipped
  // and then base64-encoded. Both halves run off the JS thread.
  const zip = await unzipOffThread(bytes, lane, trace)
  const pages = Object.keys(zip)
    .filter((p) => IMAGE_RE.test(p) && !p.startsWith('__MACOSX'))
    .sort(naturalCompare)

  if (!pages.length) throw new Error('No pages found in this comic')

  /*
   * Pages are referenced by token and streamed as bytes, not embedded.
   *
   * A comic is the most image-heavy format the app opens — it is *only*
   * images — so it benefits most from keeping them out of the HTML. Embedded as
   * base64 a 40-page comic became a ~50MB string held in the prepared-document
   * cache and duplicated across the bridge; now the markup is a few kilobytes
   * and the pages arrive as binary the browser decodes lazily.
   *
   * No encoding happens here at all any more, so this loop is cheap and the
   * per-page worklet hop moved to delivery time.
   */
  const imgs: string[] = []
  const images: PreparedImage[] = []
  let budget = 0

  for (const p of pages) {
    const entry = zip[p]
    if (!entry || entry.length > MAX_INLINE_IMAGE_BYTES) continue
    // Same total budget as a book: past it, pages are dropped rather than the
    // comic failing to open.
    if (budget + entry.length > MAX_TOTAL_IMAGE_BYTES) break
    budget += entry.length

    const token = `sr-img-${images.length}`
    images.push({ token, mime: mimeForImage(p), bytes: entry })
    imgs.push(`<img data-sr-img="${token}" alt="">`)
  }

  if (!imgs.length) throw new Error('Comic pages were too large to display')

  // `items`: a comic's pages are genuinely discrete, so they are counted
  // exactly rather than estimated.
  return {
    format: 'html',
    content: `<div class="sr-comic">${imgs.join('\n')}</div>`,
    mode: 'items',
    totalPages: imgs.length,
    images,
  }
}

/**
 * ZIP -> a browsable listing with inline previews of small text and images.
 *
 * The desktop app showed a two-pane entry list; on a phone a single scrolling
 * list with previews reads better than a split view.
 */
async function prepareArchive(
  bytes: Uint8Array,
  lane: OffloadLane,
  trace?: PrepareTrace,
): Promise<Prepared> {
  const zip = await unzipOffThread(bytes, lane, trace)
  const names = Object.keys(zip)
    .filter((p) => !p.endsWith('/') && !p.startsWith('__MACOSX'))
    .sort(naturalCompare)

  if (!names.length) throw new Error('This archive is empty')

  const rows: string[] = []
  const images: PreparedImage[] = []
  let budget = 0

  for (const p of names) {
    const entry = zip[p]
    const size = entry?.length ?? 0
    const head = `<h3>${escapeHtml(p)}</h3><p><code>${formatBytes(size)}</code></p>`

    if (
      entry &&
      IMAGE_RE.test(p) &&
      size <= MAX_INLINE_IMAGE_BYTES &&
      budget + size <= MAX_TOTAL_IMAGE_BYTES
    ) {
      // Streamed as bytes like every other image path; past the budget an entry
      // still gets its row, just without a preview.
      budget += size
      const token = `sr-img-${images.length}`
      images.push({ token, mime: mimeForImage(p), bytes: entry })
      rows.push(`<div class="sr-chapter">${head}<img data-sr-img="${token}" alt=""></div>`)
      continue
    }
    /*
     * `escapeHtml` is load-bearing here, not cosmetic. Do not replace it with a
     * sanitiser.
     *
     * `TEXT_RE` matches `.html`, `.js`, `.ts` and `.css`, and this branch
     * inlines the entry's *bytes* into the document. A ZIP containing an
     * `index.html` with a `<script>` in it is an ordinary archive, not an
     * attack — and the viewer would run that script if the markup reached it as
     * markup.
     *
     * Escaping is correct precisely because the intent here is a *listing*: the
     * user is being shown what the archive contains, so every byte must render
     * as the literal text it is. A sanitiser has the opposite goal — it keeps
     * markup working and removes what it believes is dangerous — which would
     * both execute the safe-looking parts and silently misreport the file's
     * contents. `IMAGE_RE`'s exclusion of SVG in `bytes.ts` is the same
     * decision made for the same reason.
     *
     * Pinned by `archiveText.test.ts`.
     */
    if (entry && TEXT_RE.test(p) && size <= 120_000) {
      rows.push(
        `<div class="sr-chapter">${head}<pre><code>${escapeHtml(strFromU8(entry))}</code></pre></div>`,
      )
      continue
    }
    rows.push(`<div class="sr-chapter">${head}</div>`)
  }

  const content = `<h1>${names.length} item${names.length === 1 ? '' : 's'}</h1>${rows.join('\n')}`
  return {
    format: 'html',
    content,
    mode: 'paper',
    totalPages: pagesFromChars(visibleTextLength(content)),
    images: images.length ? images : undefined,
  }
}

export async function prepareFile(
  entry: FileEntry,
  /**
   * Which worklet runtime does the byte-level work.
   *
   * Defaults to the user's lane, so an ordinary open is never queued behind a
   * speculative parse. `prefetch.ts` passes 'prefetch' explicitly — that
   * separation is the whole point of having two runtimes.
   */
  lane: OffloadLane = 'user',
): Promise<Prepared> {
  const target = new File(LIBRARY_DIR, entry.storedName)
  if (!target.exists) throw new Error('This file is missing from the library')

  /*
   * Refuse oversized files *before* reading them.
   *
   * This check used to live inside the `default` branch only, so DOCX, XLSX,
   * CBZ and ZIP reached `await target.bytes()` unguarded — the whole file
   * materialised in JS, then expanded by the unzip, then copied across the
   * worklet boundary. The per-image budgets further down cap what reaches the
   * viewer, which is a different question and answered far too late to prevent
   * an OOM kill.
   *
   * `entry.size` is recorded at import and never changes (the library owns its
   * copy); `target.size` covers entries written before that field existed.
   */
  const limit = MAX_PREPARE_BYTES[entry.format]
  if (limit !== undefined) {
    const size = entry.size ?? target.size ?? 0
    if (size > limit) {
      throw new Error(
        `This file is too large to display (${formatBytes(size)}, limit ${formatBytes(limit)})`,
      )
    }
  }

  /*
   * Timed from here, after the guards.
   *
   * A refusal is not a preparation: emitting a line for a file rejected on its
   * size would put a 0ms entry in the log for work that never started, and the
   * user already sees the refusal as an error.
   */
  const trace = beginPrepare(entry.format, entry.size ?? target.size ?? 0, lane)
  const prepared = await prepareByFormat(entry, target, lane, trace)
  trace.done()
  return prepared
}

/**
 * The format switch, split out so `prepareFile` above can own the guards and
 * the timing without indenting seven branches into a wrapper.
 *
 * Behaviour is unchanged: this is the same switch, moved.
 */
async function prepareByFormat(
  entry: FileEntry,
  target: File,
  lane: OffloadLane,
  trace: PrepareTrace,
): Promise<Prepared> {
  /**
   * The file's bytes, with the read attributed to the trace.
   *
   * Every branch below except EPUB is handed its bytes rather than reading
   * them, so this is where the `read` segment is recorded for six of the seven.
   * EPUB reads its own inside `loadEpubAsHtml` and reports there.
   */
  const readBytes = async (): Promise<Uint8Array> => {
    const started = now()
    const bytes = await target.bytes()
    trace.read(now() - started)
    return bytes
  }

  switch (entry.format) {
    case 'epub': {
      // The book's own page-list wins over any estimate, which is what makes a
      // 145-page book report 145 rather than a layout artefact.
      const book = await loadEpubAsHtml(entry.storedName, lane, trace)
      return {
        format: 'epub',
        content: book.html,
        mode: 'paper',
        totalPages: book.totalPages,
        toc: book.toc,
        // Only EPUB defers content today: it is the format where assembly is
        // measured in seconds and megabytes.
        rest: book.rest.length ? book.rest : undefined,
        loadRest: book.loadRest,
        // References, not bytes — see `PreparedImageRef`.
        imageRefs: book.images.length ? book.images : undefined,
        loadImages: book.loadImages,
      }
    }

    case 'docx':
      return prepareDocx(await readBytes())

    case 'xlsx':
      return prepareSheet(await readBytes())

    case 'comic':
      return await prepareComic(await readBytes(), lane, trace)

    case 'archive':
      return await prepareArchive(await readBytes(), lane, trace)

    case 'csv': {
      // CSV/TSV are text, but a table is far more readable than raw commas.
      const bytes = await readBytes()
      return prepareSheet(bytes)
    }

    default: {
      // Size is already enforced above, for every format rather than just this
      // branch — which is the bug that check had while it lived only here.
      const readStart = now()
      const text = await target.text()
      trace.read(now() - readStart)

      // A standalone .html file is as untrusted as an EPUB chapter — more so,
      // since it was very likely saved straight from a web page. Markdown and
      // plain text are escaped by the viewer's own renderer rather than parsed
      // as markup, so they do not go through this.
      const content = entry.format === 'html' ? sanitizeHtml(text) : text

      // Markdown and plain text are counted on their source characters; HTML on
      // its visible text only, so markup does not inflate the count.
      const chars = entry.format === 'html' ? visibleTextLength(content) : content.length
      return {
        format: entry.format === 'markdown' ? 'markdown' : entry.format === 'html' ? 'html' : 'text',
        content,
        mode: 'paper',
        totalPages: pagesFromChars(chars, CHARS_PER_PAGE),
      }
    }
  }
}
