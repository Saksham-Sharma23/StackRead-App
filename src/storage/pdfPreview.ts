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
 * It is only ever a *picture of the same frame*, and there are two kinds:
 *
 *  - **page 1** — the reader lays a PDF out full-window, fit-to-width, page 1
 *    at the top, and this is a snapshot of exactly that. Used when the open
 *    lands on page 1.
 *  - **resume** — the frame the reader was looking at when it last stopped
 *    scrolling, named by its exact position (`getPositionOffset()`, 0..1
 *    through the document). The reader restores that exact position
 *    (`initialPositionOffset`, patched into react-native-pdf), so a reopen
 *    mid-document lands on the same pixels the picture shows. One per file
 *    and window size; a newer one replaces it.
 *
 * Both are used only at the window size they were captured at, and a resume
 * frame only at the position in its name — a rotation, a different window or a
 * position that moved since is simply a miss, never a misaligned picture.
 *
 * ## Where
 *
 * The cache directory: these are regenerable, the OS may reclaim them, and
 * they must never enter a backup or the library directory the orphan prune
 * walks. Cleared per file through `storage/lifecycle` like every other cache
 * keyed by file id.
 */

const DIR = new Directory(Paths.cache, 'stackread-pdf-previews')

/** Every snapshot's name starts with this: the file, and the window it was taken in. */
function sizeTag(fileId: string, width: number, height: number): string {
  return `${fileId}.w${Math.round(width)}h${Math.round(height)}`
}

function name(fileId: string, width: number, height: number): string {
  return `${sizeTag(fileId, width, height)}.jpg`
}

/**
 * The position as it appears in a resume frame's name. Fine enough that two
 * positions a pixel apart in any real document differ; the reader only ever
 * compares a stored position with itself, so no rounding can split a match.
 */
function positionTag(offset: number): string {
  return String(Math.round(offset * 1e9))
}

function resumeName(fileId: string, width: number, height: number, offset: number): string {
  return `${sizeTag(fileId, width, height)}.at${positionTag(offset)}.jpg`
}

/** The page-1 snapshot for this file at this window size, as a URI, or null. */
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

/** The resume frame taken at exactly this position and window size, as a URI, or null. */
export function existingResumePreview(
  fileId: string,
  width: number,
  height: number,
  offset: number,
): string | null {
  try {
    const file = new File(DIR, resumeName(fileId, width, height, offset))
    return file.exists ? file.uri : null
  } catch {
    return null
  }
}

/**
 * Stores a captured frame as this file's resume frame at this window size,
 * replacing the previous one, and takes ownership of the temporary file.
 * Never throws: a missing frame costs one slower reopen.
 */
export function saveResumePreview(
  fileId: string,
  width: number,
  height: number,
  offset: number,
  capturedUri: string,
): void {
  const captured = new File(capturedUri)
  try {
    if (!DIR.exists) DIR.create({ intermediates: true })
    // Only the latest position can ever match, so the older frame is dead weight.
    const prefix = `${sizeTag(fileId, width, height)}.at`
    for (const item of DIR.list()) {
      if (item.name.startsWith(prefix)) {
        try {
          item.delete()
        } catch {
          // Left for the OS to reclaim; it is in the cache directory.
        }
      }
    }
    // Copy rather than move, as `savePreview` does (DETAIL.md §6.3).
    captured.copySync(new File(DIR, resumeName(fileId, width, height, offset)))
  } catch {
    // Nothing to recover.
  } finally {
    try {
      captured.delete()
    } catch {
      // The OS reclaims temporary captures.
    }
  }
}

/** Deletes a capture that will not be kept. */
export function discardCapture(capturedUri: string): void {
  try {
    new File(capturedUri).delete()
  } catch {
    // The OS reclaims temporary captures.
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
