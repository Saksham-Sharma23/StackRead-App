import { Directory, File, Paths } from 'expo-file-system'

import type { Prepared } from './prepare'

/**
 * Prepared documents persisted to disk, so a cold open is a file read rather
 * than a reparse.
 *
 * ## Why this exists
 *
 * `prepareCache` is memory-only, and it is deliberately cleared wholesale when
 * the app backgrounds — holding tens of megabytes is what makes Android pick
 * this process when it reclaims memory. Correct, and it means **every cold open
 * reparses from scratch**: unzip the archive, assemble every chapter, re-derive
 * the page list. For a large EPUB that is seconds, paid again every time the
 * app is reopened.
 *
 * The parse is deterministic — the same bytes always produce the same string —
 * so it only ever needs doing once. This keeps the result next to the file.
 *
 * ## What is deliberately *not* cached
 *
 * **Images.** They live on `Prepared.images` as raw `Uint8Array`s and are
 * streamed to the viewer as blobs, which is the entire point of that design:
 * the HTML stays proportional to the text, and a book closed after two pages
 * never pays for illustrations nobody reached. Writing them back out here would
 * store a second copy of bytes that are already in the original file, inflate
 * every cache entry to the size of the book, and undo that work.
 *
 * So an entry is cached only when it has no images, and a cache hit is a
 * document that needs none. That covers exactly the formats where the parse is
 * expensive and the output is text: EPUBs without illustrations, DOCX,
 * spreadsheets, large Markdown and HTML. An illustrated book still reparses,
 * which is the honest trade — the alternative stores its images twice.
 *
 * ## Why the key includes size and mtime
 *
 * The library owns its copy of a file, so its bytes normally never change. But
 * ids are reused: a restore preserves them by design, and re-importing writes
 * new bytes under an id that may already have an entry here. Keying on
 * `id + size + mtime` means a replaced file cannot read a stale parse — the
 * name simply will not match, and the old entry ages out.
 *
 * ## Why failures are silent
 *
 * Every operation here is an optimisation. A cache that cannot be written, read
 * or pruned must degrade to "parse it again", never to an error the user sees:
 * the document is still perfectly openable without it.
 */

/** Where entries live. Under cache/, so the OS may reclaim it under pressure. */
const CACHE_DIR = new Directory(Paths.cache, 'stackread-prepared')

/**
 * Disk budget for the whole directory.
 *
 * Far larger than the 24MB memory tail, because this is disk and the entries
 * are plain text — but still bounded, since it lives in the cache directory
 * that counts against the app's storage footprint.
 */
const MAX_TOTAL_BYTES = 120_000_000

/**
 * Largest single entry worth storing.
 *
 * Past this the write itself costs more than the reparse it saves, and one
 * enormous document would evict everything else.
 */
const MAX_ENTRY_BYTES = 12_000_000

/** Bumped when the serialised shape changes, so old entries are ignored. */
const FORMAT_VERSION = 1

interface Envelope {
  v: number
  prepared: Prepared
}

function ensureDir(): void {
  if (!CACHE_DIR.exists) CACHE_DIR.create({ intermediates: true })
}

/**
 * Cache filename for a file's *current* bytes.
 *
 * `size` and `mtime` are what make this safe against id reuse. A file whose
 * bytes changed produces a different name, so it cannot read the previous
 * parse — no explicit invalidation needed for that case.
 */
function entryName(fileId: string, size: number, mtime: number): string {
  return `${fileId}-${size}-${mtime}.json`
}

/** The stat a key needs, or null when the file cannot be read. */
function stampOf(source: File): { size: number; mtime: number } | null {
  try {
    const size = source.size ?? 0
    // `modificationTime` is seconds on some platforms and ms on others; either
    // is fine, since this is only ever compared against itself.
    const mtime = Math.round(source.modificationTime ?? 0)
    if (!size) return null
    return { size, mtime }
  } catch {
    return null
  }
}

/**
 * Entries up to this size are read synchronously; larger ones only through
 * `readPreparedAsync` ([AUDIT4 E3](../../../AUDIT4.md)).
 *
 * The synchronous read sits inside the renderer's first render, so its cost is
 * the first frame's: a 12MB entry is a `textSync` plus a `JSON.parse` of 12MB on
 * the JS thread before anything paints, which is a dropped frame at best. A
 * typical document is far under this and keeps the instant, spinner-free open
 * the synchronous path exists for.
 */
export const SYNC_READ_MAX_BYTES = 1_000_000

/** The cache file for this document's exact bytes, if one exists. */
function entryFile(fileId: string, source: File): File | null {
  const stamp = stampOf(source)
  if (!stamp) return null
  const file = new File(CACHE_DIR, entryName(fileId, stamp.size, stamp.mtime))
  return file.exists ? file : null
}

/**
 * Validates a parsed envelope: null for anything that is not a current entry.
 *
 * Image-carrying documents are refused even though `writePrepared` never
 * writes them — an entry left by an older build must not be trusted to have
 * followed today's rules.
 */
function fromEnvelope(parsed: unknown): Prepared | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const envelope = parsed as Partial<Envelope>
  if (envelope.v !== FORMAT_VERSION || !envelope.prepared) return null
  const prepared = envelope.prepared
  if (prepared.images && prepared.images.length) return null
  if (typeof prepared.content !== 'string') return null
  return prepared
}

/**
 * Reads a previously prepared document, if one matches these exact bytes and
 * is small enough to read without stalling a frame.
 *
 * Synchronous, because it sits on the path that decides whether to show a
 * loading state at all — the memory cache is read synchronously for the same
 * reason, and going async here would reintroduce the one-frame spinner flash
 * that the pinned window exists to remove. An entry above
 * `SYNC_READ_MAX_BYTES` reads as a miss here; `readPreparedAsync` serves it.
 *
 * Any failure — a corrupt or truncated entry, a stale format — is a miss, not
 * an error: the caller re-parses, which is the correct fallback.
 */
export function readPrepared(fileId: string, source: File): Prepared | null {
  try {
    const file = entryFile(fileId, source)
    if (!file) return null
    if ((file.size ?? 0) > SYNC_READ_MAX_BYTES) return null
    return fromEnvelope(JSON.parse(file.textSync()))
  } catch {
    return null
  }
}

/**
 * Reads a prepared document of any size without blocking on the file read.
 *
 * For the entries `readPrepared` declines: a large document still opens from
 * the disk cache rather than being re-parsed — it shows the loading cover for
 * the read instead of freezing the first frame. The `JSON.parse` itself is
 * still synchronous (there is no streaming parser), but it now runs after the
 * cover has painted.
 */
export async function readPreparedAsync(fileId: string, source: File): Promise<Prepared | null> {
  try {
    const file = entryFile(fileId, source)
    if (!file) return null
    return fromEnvelope(JSON.parse(await file.text()))
  } catch {
    return null
  }
}

/**
 * Persists a prepared document, if it is worth persisting.
 *
 * Returns quietly in every declining case — an entry with images, an oversized
 * one, an unreadable source — because none of them is an error. The caller has
 * a working document either way.
 */
export function writePrepared(fileId: string, source: File, prepared: Prepared): void {
  // Images are streamed as binary and never serialised. See the docstring.
  if (prepared.images && prepared.images.length) return

  /*
   * A document whose remainder has not been assembled yet is not cacheable.
   *
   * `loadRest` is a closure over the archive bytes, so `JSON.stringify` drops
   * it silently — and a cached entry missing it would be a book that renders
   * its first chapters and then simply stops, permanently, with no way to
   * notice. Declining is correct: the entry is written after the caller has
   * resolved the remainder, at which point the thunk is gone.
   */
  if (prepared.loadRest) return

  /*
   * Same for images that have only been referenced.
   *
   * `loadImages` is a closure over the archive bytes; serialised, the entry
   * would come back with a list of tokens the markup expects and no way to ever
   * fetch them, so every illustration would be permanently blank.
   */
  if (prepared.loadImages) return

  const stamp = stampOf(source)
  if (!stamp) return

  try {
    const json = JSON.stringify({ v: FORMAT_VERSION, prepared } satisfies Envelope)
    if (json.length > MAX_ENTRY_BYTES) return

    ensureDir()
    const file = new File(CACHE_DIR, entryName(fileId, stamp.size, stamp.mtime))
    if (!file.exists) file.create({ overwrite: true })
    file.write(json)

    prune()
  } catch {
    // A cache that cannot be written is a cache that is not used.
  }
}

/**
 * Drops every entry for one file id, whatever its stamp.
 *
 * The stamped name already protects against reading a stale parse, so this is
 * about reclaiming space when a file is deleted — and about the id-lifetime
 * rule in `storage/lifecycle`, which is the one place that gets to decide when
 * an id stops being valid.
 */
export function forgetPreparedOnDisk(fileId: string): void {
  try {
    if (!CACHE_DIR.exists) return
    for (const item of CACHE_DIR.list()) {
      if (item.name.startsWith(`${fileId}-`)) {
        try {
          item.delete()
        } catch {
          // Leave what will not delete; the budget reclaims it later.
        }
      }
    }
  } catch {
    // Housekeeping never throws into a caller.
  }
}

/** Drops everything. For a restore, which replaces every file in the library. */
export function clearPreparedOnDisk(): void {
  try {
    if (CACHE_DIR.exists) CACHE_DIR.delete()
  } catch {
    // Same as above: best effort.
  }
}

/**
 * Trims the directory to its budget, oldest first.
 *
 * Oldest by modification time rather than by a recency list, because that
 * information is already on disk and a separate index would be one more thing
 * to keep in sync with the files it describes — and to get wrong after a crash.
 */
function prune(): void {
  try {
    if (!CACHE_DIR.exists) return

    const entries: { file: File; size: number; mtime: number }[] = []
    let total = 0

    for (const item of CACHE_DIR.list()) {
      if (!(item instanceof File)) continue
      const size = item.size ?? 0
      const mtime = item.modificationTime ?? 0
      total += size
      entries.push({ file: item, size, mtime })
    }

    if (total <= MAX_TOTAL_BYTES) return

    entries.sort((a, b) => a.mtime - b.mtime)
    for (const entry of entries) {
      if (total <= MAX_TOTAL_BYTES) break
      try {
        entry.file.delete()
        total -= entry.size
      } catch {
        // Skip it; the next prune tries again.
      }
    }
  } catch {
    // Never let housekeeping break a write that already succeeded.
  }
}
