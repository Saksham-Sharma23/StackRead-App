import { File } from 'expo-file-system'

import { LIBRARY_DIR } from './paths'
import { MAX_PREPARE_BYTES } from './formats'
import { openArchive, type ArchiveHandle } from '../renderers/webview/offload'
import { findComicCover, findEpubCover, type CoverBytes } from './coverSelect'

export type { CoverBytes } from './coverSelect'
export { extensionOfPath } from './coverSelect'

/**
 * Extracts a *cover image* from a container format, as raw bytes.
 *
 * Deliberately separate from `renderers/webview/prepare.ts`. That module builds
 * a whole document for display — it unzips everything, sanitises every chapter
 * and base64-encodes every image. A thumbnail needs exactly one image and none
 * of that work, and routing covers through the render pipeline would mean
 * parsing an entire book to draw a 320px card.
 *
 * Everything here returns bytes rather than a URI, so the caller decides where
 * the file lands. `storage/thumbs.ts` writes it beside the file it belongs to,
 * the same as an image thumbnail.
 *
 * Formats that carry no cover return null and the card falls back to its format
 * badge, which is a perfectly good card.
 */

/**
 * Extracts cover bytes for a stored file, or null when it carries none.
 *
 * Only handles zip-based containers. PDF covers are rendered natively by the
 * PDF renderer rather than extracted, because a PDF page is drawn, not stored.
 */
export async function extractCover(
  storedName: string,
  format: 'epub' | 'comic',
): Promise<CoverBytes | null> {
  const file = new File(LIBRARY_DIR, storedName)
  if (!file.exists) return null

  /*
   * The same ceiling opening the file uses ([AUDIT4 A1](../../AUDIT4.md)).
   *
   * This path runs for every uncovered card on the board, with nothing the user
   * asked for at stake — a book too large to open is too large to read whole
   * into JS for a thumbnail. Returning null records the attempt as failed, so
   * it is not retried on every launch.
   */
  const limit = MAX_PREPARE_BYTES[format]
  if (limit !== undefined && (file.size ?? 0) > limit) return null

  /*
   * Opened as a handle, not unzipped whole ([AUDIT4 A6](../../AUDIT4.md)).
   *
   * `findEpubCover` / `findComicCover` request entries by name — container,
   * OPF, the cover image — with sizes checked against the central directory
   * first. This used to decompress every chapter and illustration in the book
   * to keep one image.
   *
   * On the **prefetch** lane: covers are speculative work for cards the user
   * may never open, and on the user lane they queued a book the user did open
   * behind them.
   */
  let archive: ArchiveHandle
  try {
    archive = await openArchive(() => file.bytes(), 'prefetch')
  } catch {
    // A corrupt or non-zip file is not an error here — the card shows a badge.
    return null
  }

  try {
    const read = (names: string[]) => archive.unzip(names)
    return format === 'epub'
      ? await findEpubCover(archive.entries, read)
      : await findComicCover(archive.entries, read)
  } catch {
    return null
  } finally {
    // One image was all this needed; the worker should not keep the book.
    archive.release()
  }
}
