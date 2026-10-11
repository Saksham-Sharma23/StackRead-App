import { Directory, File, Paths } from 'expo-file-system'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'

import type { FileEntry } from '../types'
import { LIBRARY_DIR, fileUri, thumbFile } from './paths'
import { storage, thumbBusyKey, thumbFailKey } from './mmkv'
import { extractCover } from './covers'
import { thumbHashFor } from './thumbhash'

/**
 * Lazy card previews, stored as `<fileId>.thumb.jpg` beside the file.
 *
 * Mirrors the desktop app: generated the first time a card renders without one,
 * capped at two at a time so importing a batch cannot stall the board, and
 * recorded in the index as a **basename** rather than a data URL.
 */

const THUMB_WIDTH = 320
const MAX_CONCURRENT = 2

let running = 0
const queue: (() => void)[] = []
/**
 * Files already attempted, so a generator is never retried in a loop.
 *
 * Two tiers, and the second is what R2-6 added.
 *
 * The in-memory set covers **this session** — every attempt, successful or not
 * — and is the fast path.
 *
 * MMKV covers **across launches**, and holds only the negative results. A
 * success needs no record here because `FileEntry.thumb` in the index already
 * is one; a failure had no record at all, so a file that legitimately yields no
 * cover — an EPUB with no declared cover image, a comic whose first entry is
 * not an image — was retried on every single cold launch, two at a time, each
 * retry a full archive decompression producing nothing
 * ([AUDIT2 §3.4](../../AUDIT2.md)).
 *
 * Both tiers are cleared through `storage/lifecycle`, which is the one place
 * that decides when a file id stops being valid.
 */
const attempted = new Set<string>()

/** True when a previous launch established that this file has no cover. */
function failedBefore(fileId: string): boolean {
  // An attempt the previous process died in counts as a failure; sweep first.
  sweepInterruptedAttempts()
  return storage.getBoolean(thumbFailKey(fileId)) === true
}

/**
 * Records that generation produced nothing, durably.
 *
 * Called only on a genuinely negative outcome — never on a throw from
 * `ImageManipulator`, which can fail transiently and would otherwise mark a
 * perfectly good file as coverless forever.
 */
function rememberFailure(fileId: string): void {
  storage.set(thumbFailKey(fileId), true)
}

/**
 * Records a definite failure from outside this module — `PdfCoverFactory`'s
 * pdfium could not open the file. Durable, like `rememberFailure`.
 */
export function markThumbnailFailed(fileId: string): void {
  attempted.add(fileId)
  rememberFailure(fileId)
}

/*
 * ---- crash-safe attempts ---------------------------------------------------
 *
 * A cover attempt that *kills the process* — an out-of-memory unzip, a pdfium
 * crash on a malformed PDF — never reaches `rememberFailure`, and `attempted`
 * dies with the process. So the next launch tried the same file again, and
 * crashed again, every launch ([AUDIT4 A12](../../AUDIT4.md)).
 *
 * The fix is a marker written *before* the work and removed after it, whatever
 * the outcome. One still present at the next launch can only mean the process
 * died during that attempt, and that file is marked failed instead of retried.
 */

/** Marks the start of a cover attempt that could take the process down. */
export function beginThumbnailAttempt(fileId: string): void {
  sweepInterruptedAttempts()
  storage.set(thumbBusyKey(fileId), true)
}

/** Marks its end, whatever the outcome. */
export function endThumbnailAttempt(fileId: string): void {
  storage.remove(thumbBusyKey(fileId))
}

let swept = false

/**
 * Converts the previous process's unfinished attempts into failures, once.
 *
 * Run lazily, on the first thumbnail question asked this launch, rather than at
 * module load: this module is in the startup import graph, and scanning MMKV's
 * keys before the board paints would be a cost paid by every launch.
 */
function sweepInterruptedAttempts(): void {
  if (swept) return
  swept = true
  try {
    for (const key of storage.getAllKeys()) {
      if (!key.startsWith('thumbbusy:')) continue
      const fileId = key.slice('thumbbusy:'.length)
      storage.remove(key)
      rememberFailure(fileId)
      console.warn(`[stackread] a cover attempt for ${fileId} did not finish last session; not retrying it`)
    }
  } catch {
    // Unreadable keys mean no sweep this launch, not a crash.
  }
}

function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    queue.push(() => {
      running += 1
      resolve()
    })
  })
}

function release(): void {
  running -= 1
  queue.shift()?.()
}

/**
 * Formats we can currently produce a preview for.
 *
 * The single place that decides this — widening it is how a format gains a real
 * cover, and nothing else needs to change.
 *
 *  - `image`  — the file itself, downscaled.
 *  - `epub`   — the publisher's declared cover image (see `storage/covers.ts`).
 *  - `comic`  — page one.
 *
 * **PDF is absent here on purpose, and is still covered.** A PDF page is
 * *rendered*, not stored, so there is no image to extract — it has to be
 * rasterised by the native view. `PdfRenderer` captures page one the first time
 * a document is opened and calls `captureFirstPage` below, so a PDF cover
 * arrives on first open rather than at import. Returning true here would mean
 * this generator trying, and failing, on every PDF card.
 *
 * DOCX, spreadsheets and archives have no cover worth the parse: reaching one
 * means unzipping and converting the whole document, which is the work the card
 * exists to avoid.
 */
export function canThumbnail(entry: FileEntry): boolean {
  return entry.format === 'image' || entry.format === 'epub' || entry.format === 'comic'
}

/**
 * Where extracted cover bytes are staged before downscaling.
 *
 * `ImageManipulator` takes a URI, not a byte array, so a cover pulled out of a
 * zip has to touch the disk first. The cache directory rather than the library
 * one, because these are disposable and must never be mistaken for a stored
 * file by `pruneOrphans`.
 */
const COVER_TMP = new Directory(Paths.cache, 'stackread-covers')

/**
 * Writes cover bytes to a temp file and returns its URI.
 *
 * Named by file id rather than randomly so a retry overwrites its own staging
 * file instead of accumulating one per attempt.
 */
function stageCover(fileId: string, bytes: Uint8Array, ext: string): File {
  if (!COVER_TMP.exists) COVER_TMP.create({ intermediates: true })
  const staged = new File(COVER_TMP, `${fileId}.cover.${ext || 'jpg'}`)
  if (staged.exists) staged.delete()
  staged.create({ overwrite: true })
  staged.write(bytes)
  return staged
}

export interface ThumbResult {
  /** Basename of the stored preview. */
  thumb: string
  /** Base64 ThumbHash, when one could be computed. */
  thumbhash?: string
}

/**
 * Generates a preview if one does not exist yet.
 *
 * Returns the thumbnail's basename and its ThumbHash, or null when none could
 * be made — callers fall back to the format badge, which is a perfectly good
 * card.
 */
export async function ensureThumbnail(entry: FileEntry): Promise<ThumbResult | null> {
  if (entry.thumb) return { thumb: entry.thumb, thumbhash: entry.thumbhash }
  if (!canThumbnail(entry)) return null
  if (attempted.has(entry.id)) return null
  // A previous launch already established there is nothing to extract.
  if (failedBefore(entry.id)) return null
  attempted.add(entry.id)

  const target = thumbFile(entry.id)
  const basename = `${entry.id}.thumb.jpg`

  // A previous run may have written it without the index recording it. Still
  // hash it: an entry can carry a thumb from an older version with no hash.
  if (target.exists) {
    return { thumb: basename, thumbhash: (await thumbHashFor(target.uri)) ?? undefined }
  }

  await acquire()
  /** Staged cover bytes, deleted in `finally` whether or not we succeeded. */
  let staged: File | null = null
  // Unzipping a book and decoding an image are both things that can take the
  // process down; mark the attempt so a crash here is not repeated next launch.
  beginThumbnailAttempt(entry.id)
  try {
    const source = new File(LIBRARY_DIR, entry.storedName)
    if (!source.exists) return null

    /*
     * An image is its own thumbnail source; a container has to give one up
     * first. `extractCover` returns bytes, which `ImageManipulator` cannot
     * take, so a container's cover is staged to the cache directory and read
     * back from there.
     */
    let sourceUri: string
    if (entry.format === 'image') {
      sourceUri = fileUri(entry.storedName)
    } else {
      const cover = await extractCover(entry.storedName, entry.format as 'epub' | 'comic')
      /*
       * No declared cover is a normal outcome, not a failure — the card falls
       * back to its format badge.
       *
       * Recorded durably, and this is the case that matters: it is a *stable*
       * property of the file, so retrying it on the next launch re-unzips the
       * whole archive to reach the same answer. The throw path below is
       * deliberately not recorded, because that one can be transient.
       */
      if (!cover) {
        rememberFailure(entry.id)
        return null
      }
      staged = stageCover(entry.id, cover.bytes, cover.ext)
      sourceUri = staged.uri
    }

    const ctx = ImageManipulator.manipulate(sourceUri)
    ctx.resize({ width: THUMB_WIDTH })
    const rendered = await ctx.renderAsync()
    const saved = await rendered.saveAsync({
      compress: 0.7,
      format: SaveFormat.JPEG,
    })

    // saveAsync writes to the cache; move it beside the file it belongs to.
    const produced = new File(saved.uri)
    if (target.exists) target.delete()
    produced.moveSync(target)

    // Hashed from the stored thumbnail rather than the source: it is already
    // small, so the extra downscale inside `thumbHashFor` is cheap, and the
    // placeholder then matches the image it stands in for exactly.
    const thumbhash = await thumbHashFor(target.uri)

    return { thumb: basename, thumbhash: thumbhash ?? undefined }
  } catch {
    // A preview is a nicety. Never let a failure surface to the user.
    return null
  } finally {
    if (staged?.exists) {
      try {
        staged.delete()
      } catch {
        // Cache dir; the OS reclaims it.
      }
    }
    endThumbnailAttempt(entry.id)
    release()
  }
}

/**
 * Records an already-rendered page image as a file's card thumbnail.
 *
 * Called by `PdfRenderer` with a `react-native-view-shot` capture of page one.
 * PDF is the one format `extractCover` cannot serve: a page is *drawn*, not
 * stored, so producing a cover means rasterising it, and `react-native-pdf`
 * exposes no page-to-image API of its own — `onLoadComplete` hands back the
 * path of the PDF itself, which `ImageManipulator` cannot decode.
 *
 * Everything after the capture is shared with every other thumbnail — the same
 * downscale, the same ThumbHash, the same destination — so cards stay uniform
 * however their image was obtained.
 *
 * The constraint any caller inherits: three live pdfium documents crashed
 * inside `FPDF_LoadPage` (DETAIL.md 8), so a cover must never come from an
 * off-screen PDF view mounted per file. It has to ride the one document the
 * reader already has open, which is why PDF covers appear on first open rather
 * than at import.
 */
export async function captureFirstPage(
  entry: FileEntry,
  renderedUri: string,
  /**
   * The share of the capture's height that is page 1, from the top.
   *
   * The reader and the cover factory now capture a full-window frame — the
   * same frame the instant-open preview shows (`storage/pdfPreview`) — in
   * which page 1 is fit to width at the top and the gutter, or page 2, fills
   * the rest. The card wants the page alone, so it is cropped to this before
   * the downscale. 1 means "use the whole image".
   */
  pageFraction = 1,
): Promise<ThumbResult | null> {
  if (entry.thumb) return { thumb: entry.thumb, thumbhash: entry.thumbhash }
  if (attempted.has(entry.id)) return null
  if (failedBefore(entry.id)) return null
  attempted.add(entry.id)

  const target = thumbFile(entry.id)
  const basename = `${entry.id}.thumb.jpg`
  if (target.exists) {
    return { thumb: basename, thumbhash: (await thumbHashFor(target.uri)) ?? undefined }
  }

  await acquire()
  try {
    const ctx = ImageManipulator.manipulate(renderedUri)
    if (pageFraction > 0 && pageFraction < 0.999) {
      // The crop is in pixels, and the capture's pixel size depends on the
      // device's density — so it is measured rather than computed.
      const probe = await ImageManipulator.manipulate(renderedUri).renderAsync()
      const height = Math.max(1, Math.round(probe.height * pageFraction))
      ctx.crop({ originX: 0, originY: 0, width: probe.width, height })
    }
    ctx.resize({ width: THUMB_WIDTH })
    const rendered = await ctx.renderAsync()
    const saved = await rendered.saveAsync({ compress: 0.7, format: SaveFormat.JPEG })

    const produced = new File(saved.uri)
    if (target.exists) target.delete()
    produced.moveSync(target)

    const thumbhash = await thumbHashFor(target.uri)
    return { thumb: basename, thumbhash: thumbhash ?? undefined }
  } catch {
    return null
  } finally {
    release()
  }
}

/**
 * Whether generation has already been tried for this file this session.
 *
 * For callers that pick work *before* calling a generator — the PDF cover
 * factory mounts a native view per candidate, which is far too expensive to
 * spend on a file the generator would decline on its first line.
 */
export function hasAttemptedThumbnail(fileId: string): boolean {
  return attempted.has(fileId) || failedBefore(fileId)
}

/** Lets a file be retried after its bytes change. */
export function resetThumbnailAttempt(fileId: string): void {
  attempted.delete(fileId)
  storage.remove(thumbFailKey(fileId))
  // A re-imported file is new bytes; an old interrupted attempt says nothing about it.
  storage.remove(thumbBusyKey(fileId))
}

/**
 * Lets every file be retried. For a restore, which replaces all of them.
 *
 * Without this a restored library shows the *previous* library's covers for any
 * id the archive happens to share, and never regenerates them: the id is
 * already in `attempted`, so the generator declines to look.
 */
export function resetAllThumbnailAttempts(): void {
  attempted.clear()

  /*
   * The durable flags go too, and for a restore that is the point.
   *
   * An export preserves file ids by design, so after a restore a `thumbfail:`
   * key describes the *previous* library's bytes under an id the new one also
   * uses — the same wrong-belief-under-a-reused-id problem
   * `storage/lifecycle` exists to prevent, reached through a key rather than a
   * Map. Without this, a restored book that does have a cover would never get
   * one.
   *
   * Enumerating and filtering rather than `clearAll()`: this instance also
   * holds reading positions, progress and the pending-removal record, and a
   * restore has just written positions into it.
   */
  try {
    for (const key of storage.getAllKeys()) {
      if (key.startsWith('thumbfail:')) storage.remove(key)
    }
  } catch {
    // Worst case a restored file keeps its badge. Never worth failing a restore.
  }
}
