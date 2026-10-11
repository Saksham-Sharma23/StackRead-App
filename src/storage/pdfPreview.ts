import { Directory, File, Paths } from 'expo-file-system'

/**
 * A full-screen snapshot of how a PDF first appears, shown the instant it is
 * opened.
 *
 * ## Why
 *
 * Drive feels instant because something real is on screen the moment you tap:
 * the page, not a spinner. pdfium cannot give us that — `react-native-pdf`
 * shows nothing until the whole document is opened and every page measured,
 * which for a large file is seconds. So the first frame the reader showed last
 * time is kept as an image, laid over the view on the next open, and faded out
 * once the live document has rendered underneath it.
 *
 * It is only ever a *picture of the same frame*: the reader lays a PDF out
 * full-window, fit-to-width, page 1 at the top, and the snapshot is taken from
 * exactly that. So it is used only when the open will land on page 1, and only
 * at the window size it was captured at — a rotation or a different window is
 * simply a miss, never a misaligned picture.
 *
 * ## Where
 *
 * The cache directory: these are regenerable, the OS may reclaim them, and
 * they must never enter a backup or the library directory the orphan prune
 * walks. Cleared per file through `storage/lifecycle` like every other cache
 * keyed by file id.
 */

const DIR = new Directory(Paths.cache, 'stackread-pdf-previews')

function name(fileId: string, width: number, height: number): string {
  return `${fileId}.w${Math.round(width)}h${Math.round(height)}.jpg`
}

/** The snapshot for this file at this window size, as a URI, or null. */
export function existingPreview(fileId: string, width: number, height: number): string | null {
  try {
    const file = new File(DIR, name(fileId, width, height))
    return file.exists ? file.uri : null
  } catch {
    return null
  }
}

/**
 * Stores a captured frame as this file's snapshot, taking ownership of the
 * temporary file. Never throws: a missing preview costs one slower open.
 */
export function savePreview(fileId: string, width: number, height: number, capturedUri: string): void {
  try {
    if (!DIR.exists) DIR.create({ intermediates: true })
    const target = new File(DIR, name(fileId, width, height))
    if (target.exists) target.delete()
    const captured = new File(capturedUri)
    // Copy rather than move: `moveSync` cannot be trusted with a destination
    // that does not exist yet on Android (DETAIL.md §6.3).
    captured.copySync(target)
    captured.delete()
  } catch {
    // Nothing to recover.
  }
}

/** Drops every snapshot of one file — its bytes changed or it was removed. */
export function forgetPreviews(fileId: string): void {
  try {
    if (!DIR.exists) return
    for (const item of DIR.list()) {
      if (item.name.startsWith(`${fileId}.`)) {
        try {
          item.delete()
        } catch {
          // Left for the OS to reclaim; it is in the cache directory.
        }
      }
    }
  } catch {
    // Nothing to recover.
  }
}

/** Drops every snapshot. For a restore, which replaces every file. */
export function clearPreviews(): void {
  try {
    if (DIR.exists) DIR.delete()
  } catch {
    // Nothing to recover.
  }
}
