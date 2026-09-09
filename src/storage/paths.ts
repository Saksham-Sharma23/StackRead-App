import { Directory, File, Paths } from 'expo-file-system'

/**
 * Mirrors the desktop app's `userData/library/` layout:
 *
 *   library/
 *     library.json          the index
 *     <fileId>.<ext>        the copied file
 *     <fileId>.thumb.jpg    the generated preview
 *
 * Thumbnails live flat beside their files rather than in a `thumbs/`
 * subdirectory, exactly as on desktop, so one read path serves both.
 */
export const LIBRARY_DIR = new Directory(Paths.document, 'library')

/**
 * The pre-SQLite index. **Read once, on upgrade; never written any more.**
 *
 * The live index is now a SQLite database (`storage/db.ts`), so these two files
 * exist only so an install that predates it can be migrated. They are left on
 * disk rather than deleted after the migration: they are the sole copy of a
 * pre-upgrade library, they are small, and keeping them costs a few hundred
 * kilobytes against the chance the migration ever turns out to be wrong.
 *
 * `pruneOrphans` skips both by name, so nothing collects them as orphans.
 */
export const INDEX_FILE = new File(LIBRARY_DIR, 'library.json')

/**
 * The legacy second copy of the index.
 *
 * It existed because Android could not do temp-then-rename — `moveSync` throws
 * `NoSuchFileException` naming the *destination* whenever it does not already
 * exist, even after creating it — so writing the index twice was the only crash
 * protection available. WAL replaced both the copy and the constraint that
 * forced it, and nothing has written this file since. It is still read as a
 * fallback during migration, because a library recoverable only from the backup
 * is exactly the case it was created for.
 */
export const INDEX_BACKUP = new File(LIBRARY_DIR, 'library.json.bak')

/** Creates the library directory if it does not exist yet. Safe to call repeatedly. */
export function ensureLibraryDir(): void {
  if (!LIBRARY_DIR.exists) {
    LIBRARY_DIR.create({ intermediates: true })
  }
}

export function storedFile(fileId: string, ext: string): File {
  return new File(LIBRARY_DIR, `${fileId}.${ext}`)
}

export function thumbFile(fileId: string): File {
  return new File(LIBRARY_DIR, `${fileId}.thumb.jpg`)
}

/*
 * There is deliberately no `isInsideLibrary()` containment check here.
 *
 * One existed, describing itself as guarding the `file://` read access granted
 * to the WebView host. No such access is granted: the viewer runs with
 * `allowFileAccess={false}` and receives content only via `postMessage`, so
 * there is no path for a URI to reach it and nothing for the guard to check. It
 * was never called from anywhere.
 *
 * It is recorded as absent rather than silently deleted because the comment
 * asserted a security posture the code did not have, which is worse than no
 * comment: it invites relaxing the WebView flags on the belief that a guard is
 * already covering it. If the deferred scoped-`allowingReadAccessToURL` work
 * for EPUB extraction ever lands, this check comes back *with* that change and
 * is reviewed alongside it.
 */

/** Resolves a `FileEntry.storedName` to an absolute `file://` URI. */
export function fileUri(storedName: string): string {
  return new File(LIBRARY_DIR, storedName).uri
}

/** Resolves a `FileEntry.thumb` basename to an absolute `file://` URI. */
export function thumbUri(thumbName: string): string {
  return new File(LIBRARY_DIR, thumbName).uri
}
