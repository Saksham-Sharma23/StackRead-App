import type { FileFormat } from '../types'

/**
 * Single source of truth for extension -> format, extension -> MIME, and the
 * picker's filter list.
 *
 * On desktop this mapping was duplicated in three places (`FORMAT_BY_EXT`,
 * `MIME_BY_EXT`, and the native dialog's filter list), and the project's own
 * notes flag that as a maintenance trap: adding a format meant remembering all
 * three. Here everything derives from `FORMATS` below.
 */

interface FormatSpec {
  format: FileFormat
  mime: string
  /** Short label shown on a card when no thumbnail could be generated. */
  badge: string
  /** Badge tint. */
  color: string
  /** False until the renderer for this format ships (see the phase plan). */
  supported: boolean
}

const FORMATS: Record<string, FormatSpec> = {
  // --- v1 ---
  pdf: { format: 'pdf', mime: 'application/pdf', badge: 'PDF', color: '#ff453a', supported: true },
  epub: { format: 'epub', mime: 'application/epub+zip', badge: 'EPUB', color: '#bf5af2', supported: true },

  png: { format: 'image', mime: 'image/png', badge: 'PNG', color: '#30d158', supported: true },
  jpg: { format: 'image', mime: 'image/jpeg', badge: 'JPG', color: '#30d158', supported: true },
  jpeg: { format: 'image', mime: 'image/jpeg', badge: 'JPG', color: '#30d158', supported: true },
  gif: { format: 'image', mime: 'image/gif', badge: 'GIF', color: '#30d158', supported: true },
  webp: { format: 'image', mime: 'image/webp', badge: 'WEBP', color: '#30d158', supported: true },
  bmp: { format: 'image', mime: 'image/bmp', badge: 'BMP', color: '#30d158', supported: true },
  avif: { format: 'image', mime: 'image/avif', badge: 'AVIF', color: '#30d158', supported: true },
  heic: { format: 'image', mime: 'image/heic', badge: 'HEIC', color: '#30d158', supported: true },
  heif: { format: 'image', mime: 'image/heif', badge: 'HEIF', color: '#30d158', supported: true },

  txt: { format: 'text', mime: 'text/plain', badge: 'TXT', color: '#8e8e93', supported: true },
  log: { format: 'text', mime: 'text/plain', badge: 'LOG', color: '#8e8e93', supported: true },
  md: { format: 'markdown', mime: 'text/markdown', badge: 'MD', color: '#0a84ff', supported: true },
  markdown: { format: 'markdown', mime: 'text/markdown', badge: 'MD', color: '#0a84ff', supported: true },

  html: { format: 'html', mime: 'text/html', badge: 'HTML', color: '#ff9f0a', supported: true },
  htm: { format: 'html', mime: 'text/html', badge: 'HTML', color: '#ff9f0a', supported: true },

  // --- office, comic and archive formats, all via the WebView host ---
  docx: {
    format: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    badge: 'DOCX',
    color: '#0a84ff',
    supported: true,
  },
  xlsx: {
    format: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    badge: 'XLSX',
    color: '#30d158',
    supported: true,
  },
  xls: { format: 'xlsx', mime: 'application/vnd.ms-excel', badge: 'XLS', color: '#30d158', supported: true },
  csv: { format: 'csv', mime: 'text/csv', badge: 'CSV', color: '#30d158', supported: true },
  tsv: { format: 'csv', mime: 'text/tab-separated-values', badge: 'TSV', color: '#30d158', supported: true },
  tiff: { format: 'image', mime: 'image/tiff', badge: 'TIFF', color: '#30d158', supported: false },
  tif: { format: 'image', mime: 'image/tiff', badge: 'TIFF', color: '#30d158', supported: false },
  cbz: { format: 'comic', mime: 'application/vnd.comicbook+zip', badge: 'CBZ', color: '#ffd60a', supported: true },
  zip: { format: 'archive', mime: 'application/zip', badge: 'ZIP', color: '#ffd60a', supported: true },
}

const FALLBACK: FormatSpec = {
  format: 'text',
  mime: 'application/octet-stream',
  badge: '?',
  color: '#8e8e93',
  supported: false,
}

/** Lowercased extension without the dot, or '' when there isn't one. */
/**
 * Largest file each format will attempt to open, in bytes.
 *
 * ## Why this is a table and not one constant
 *
 * `prepare.ts` had a single `MAX_BYTES` of 6MB, and it guarded only the plain
 * text branch — markdown, text and HTML. Every heavy format fell through it:
 * DOCX, XLSX, CBZ and ZIP each called `await target.bytes()` with no check at
 * all, so the whole file was materialised, then unzipped, then copied across
 * the worklet boundary. The image budgets inside those functions cap what
 * reaches the *viewer*, which is a different question and happens far too late.
 *
 * The limits differ because the formats do. A ZIP or CBZ expands to more than
 * it occupies and is mostly already-compressed images, so its ceiling is the
 * highest. A spreadsheet becomes a DOM node per cell, which is the real
 * constraint rather than the bytes on disk. Plain text keeps the original 6MB.
 *
 * ## Why these are generous rather than tight
 *
 * A refusal is a real cost to someone who wanted to read the file, so this is a
 * backstop against being killed by the OOM reaper — not a policy about what is
 * reasonable to read. Anything that fits should open.
 *
 * EPUB used to be absent here, on the grounds that `loadEpubAsHtml` streams
 * chapter by chapter and budgets its own images. That bounded what reaches the
 * *viewer*, not what reaches memory: the whole archive is still read into JS
 * before a single chapter is chosen, and a 300MB textbook went straight onto
 * the heap ([AUDIT4 A1](../../AUDIT4.md)). It has a ceiling now like every other
 * format that loads its bytes. Formats rendered by native views from disk (PDF,
 * image) never load their bytes into JS at all.
 */
export const MAX_PREPARE_BYTES: Partial<Record<FileFormat, number>> = {
  text: 6_000_000,
  markdown: 6_000_000,
  html: 6_000_000,
  docx: 80_000_000,
  xlsx: 40_000_000,
  csv: 40_000_000,
  /*
   * 40MB, not 300MB — a ceiling that can actually be reached.
   *
   * 300MB was not a ceiling, it was a comment. An archive is read whole into
   * JS, handed across the worklet boundary (which copies it twice), expanded by
   * the unzip, and copied twice more on the way back
   * ([AUDIT2 §1.2](../../AUDIT2.md)) — so a 300MB comic needs well over a
   * gigabyte of transient heap and the process is killed long before this check
   * would ever fire. A refusal the user can read is strictly better than an OOM
   * kill they cannot.
   *
   * **Raise these once R4-1 and R4-2 land**, when a larger number means
   * something, and verify the new figure on a device rather than assuming it.
   */
  comic: 40_000_000,
  archive: 40_000_000,
  /*
   * 100MB, above comics because an EPUB is no longer unzipped whole.
   *
   * The archive is read once and parked on the worker; only first-paint
   * chapters, then the rest of the text, then budgeted images
   * (`MAX_TOTAL_INLINE_BYTES` in `epub.ts`) are ever decompressed. So the
   * transient cost is roughly two copies of the file plus what is extracted,
   * not the multiple of the file that a comic's full unzip costs. Most
   * illustrated novels are well under 50MB; textbooks are what this stops.
   *
   * **Measured on no device yet.** Raise it after a release-build test of a
   * large book shows headroom, not before.
   */
  epub: 100_000_000,
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot < 1 || dot === filename.length - 1) return ''
  return filename.slice(dot + 1).toLowerCase()
}

export function specOf(filename: string): FormatSpec {
  return FORMATS[extensionOf(filename)] ?? FALLBACK
}

export function formatOf(filename: string): FileFormat {
  return specOf(filename).format
}

export function isKnownExtension(filename: string): boolean {
  return extensionOf(filename) in FORMATS
}

/** Whether a renderer exists for this file yet. */
export function isRenderable(filename: string): boolean {
  return specOf(filename).supported
}

export function badgeOf(filename: string): { label: string; color: string } {
  const spec = specOf(filename)
  return { label: spec.badge, color: spec.color }
}

/** MIME list for the document picker, deduplicated. */
export const PICKER_MIME_TYPES: string[] = Array.from(
  new Set(Object.values(FORMATS).map((s) => s.mime)),
)

export const SUPPORTED_EXTENSIONS: string[] = Object.keys(FORMATS)

/**
 * Human-readable byte size.
 *
 * Binary units (1024), because that is what a file manager on Android reports —
 * showing 1.05 MB where the system says 1.00 MB looks like a bug in the app
 * rather than a units disagreement.
 *
 * One decimal place below 10, none above: "1.4 MB" carries useful precision,
 * "147.3 MB" carries false precision and is wider on a cramped row.
 */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }

  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
