import { Directory, File, FileMode, Paths, type FileHandle } from 'expo-file-system'

import * as Incoming from '../../modules/incoming-files/src'
import { useLibrary } from '../store/library'
import { extensionOf } from './formats'
import { libraryEntry, newLibrarySlot, type LibrarySlot } from './files'
import { incomingFileName } from './incomingName'
import {
  DISK_HEADROOM_BYTES,
  ImportCancelled,
  ImportLimitError,
  MAX_FOLDER_DEPTH,
  MAX_FOLDER_ENTRIES,
  MAX_IMPORT_FILES,
  NO_SPACE,
  baseName,
  groupTitleFor,
  naturalCompare,
  verdictFor,
  type BulkImportSummary,
} from './bulkImportRules'
import { unpackZipEntries, type ZipTarget } from './zipUnpack'

export { ImportCancelled, ImportLimitError }

/**
 * Importing a whole folder, or a ZIP, as one new group.
 *
 * ## Shape
 *
 * Every file is copied into its library slot first; the group and its entries
 * are added to the library only at the end, in one `addGroup` + `addFiles`. So
 * a cancel or a fatal error deletes what was copied and leaves the library
 * exactly as it was — no half-filled group. A process kill mid-import leaves
 * slot files that no index row references, which the orphan prune collects
 * (its age guard keeps it off files still being written).
 *
 * Subfolders are flattened into the one group, in natural order of their full
 * path, so `Vol 2/01.png` still comes before `Vol 10/01.png`.
 *
 * ## ZIPs
 *
 * Streamed, never held whole — read in 1MB chunks, inflated, and each entry
 * written chunk by chunk through a `FileHandle`, the pattern backup restore
 * established ([AUDIT4 D4](../../AUDIT4.md)). The streaming and its limits are
 * `storage/zipUnpack.ts`, kept free of device APIs so the Node tests run it on
 * real archives; this file only supplies the files.
 */

/** Shared between the import and the UI: cancel, and hear about progress. */
export interface ImportControl {
  cancelled: boolean
  /** `total` is null while unknown — a ZIP is counted as it streams. */
  onProgress?: (done: number, total: number | null) => void
}

const CHUNK_BYTES = 1024 * 1024

interface Written {
  /** Full path inside the folder or ZIP, for ordering. */
  path: string
  name: string
  slot: LibrarySlot
}

function diskBudget(): number {
  return Paths.availableDiskSpace - DISK_HEADROOM_BYTES
}

function deleteSlot(slot: LibrarySlot): void {
  try {
    if (slot.target.exists) slot.target.delete()
  } catch {
    // An orphan the next prune collects.
  }
}

function discard(written: Written[]): void {
  for (const w of written) deleteSlot(w.slot)
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Adds the group and its files, in natural order. Nothing is added when nothing was imported. */
function commit(sourceName: string, written: Written[], counts: Omit<BulkImportSummary, 'groupTitle' | 'added'>) {
  const library = useLibrary.getState()
  const groupTitle = groupTitleFor(
    sourceName,
    library.groups.map((g) => g.title),
  )
  if (written.length) {
    written.sort((a, b) => naturalCompare(a.path, b.path))
    const groupId = library.addGroup(groupTitle)
    library.addFiles(written.map((w, i) => libraryEntry(w.slot, w.name, groupId, i)))
  }
  return { groupTitle, added: written.length, ...counts }
}

function logFailure(name: string, err: unknown): void {
  // The extension, never the name (AUDIT4 D6).
  console.warn(`[stackread] could not import a .${extensionOf(name) || '?'} file`, __DEV__ ? err : undefined)
}

/* ------------------------------------------------------------------ folder */

/** Opens Android's folder picker. Null when the user backs out. */
export async function pickFolder(): Promise<Directory | null> {
  try {
    return await Directory.pickDirectoryAsync()
  } catch (err) {
    if (/cancel/i.test(String(err))) return null
    throw err
  }
}

interface Found {
  path: string
  file: File
}

/** Every file under `root`, depth- and count-bounded. */
async function walk(root: Directory): Promise<Found[]> {
  const found: Found[] = []
  let visited = 0
  const visit = async (dir: Directory, prefix: string, depth: number) => {
    for (const item of dir.list()) {
      if (++visited > MAX_FOLDER_ENTRIES) {
        throw new ImportLimitError('This folder has too many files to import. Choose a smaller folder.')
      }
      if (item instanceof Directory) {
        if (depth < MAX_FOLDER_DEPTH) await visit(item, `${prefix}${item.name}/`, depth + 1)
      } else {
        found.push({ path: `${prefix}${item.name}`, file: item })
      }
      if (visited % 200 === 0) await yieldToUi()
    }
  }
  await visit(root, '', 0)
  return found
}

/** Imports every supported file under a picked folder into a new group named after it. */
export async function importFolder(root: Directory, control: ImportControl): Promise<BulkImportSummary> {
  const found = await walk(root)
  let unsupported = 0
  const importable: Found[] = []
  for (const f of found) {
    const verdict = verdictFor(f.path)
    if (verdict === 'import') importable.push(f)
    else if (verdict === 'unsupported') unsupported += 1
  }
  importable.sort((a, b) => naturalCompare(a.path, b.path))
  const overLimit = Math.max(0, importable.length - MAX_IMPORT_FILES)
  const chosen = importable.slice(0, MAX_IMPORT_FILES)

  const needed = chosen.reduce((sum, f) => sum + (f.file.size ?? 0), 0)
  if (needed > diskBudget()) throw new ImportLimitError(NO_SPACE)

  const written: Written[] = []
  let failed = 0
  for (const [i, { path, file }] of chosen.entries()) {
    if (control.cancelled) {
      discard(written)
      throw new ImportCancelled()
    }
    const name = incomingFileName(baseName(path), null)
    let slot: LibrarySlot | null = null
    try {
      slot = newLibrarySlot(name)
      // Off the JS thread when the native copier is in this build; a large
      // file copied synchronously would freeze the progress overlay.
      if (file.uri.startsWith('content://') && Incoming.isAvailable()) {
        await Incoming.copyTo(file.uri, slot.target.uri)
      } else {
        // Async in expo-file-system 57 (a native coroutine) — awaited, or the
        // import would commit an entry whose bytes are still being written.
        await file.copy(slot.target)
      }
      written.push({ path, name, slot })
    } catch (err) {
      if (slot) deleteSlot(slot)
      logFailure(name, err)
      failed += 1
    }
    control.onProgress?.(i + 1, chosen.length)
    await yieldToUi()
  }

  if (control.cancelled) {
    discard(written)
    throw new ImportCancelled()
  }
  return commit(root.name, written, { unsupported, failed, overLimit })
}

/* --------------------------------------------------------------------- zip */

/** Opens the file picker for a ZIP. Null when the user backs out. */
export async function pickZip(): Promise<{ uri: string; name: string } | null> {
  const DocumentPicker = await import('expo-document-picker')
  // Wildcard, then checked by extension — vendor pickers filter MIME types
  // unevenly (see `importFiles`), and a ZIP typed `octet-stream` would vanish.
  const picked = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true })
  if (picked.canceled || !picked.assets[0]) return null
  const asset = picked.assets[0]
  if (extensionOf(asset.name) !== 'zip') {
    throw new ImportLimitError('Choose a .zip file to import it as a group.')
  }
  return { uri: asset.uri, name: asset.name }
}

/** Unpacks every supported file in a ZIP into a new group named after it. */
export async function importZip(uri: string, zipName: string, control: ImportControl): Promise<BulkImportSummary> {
  const archive = new File(uri)
  try {
    return await unpackZip(archive, zipName, control)
  } finally {
    // The picker's cached copy is ours to remove; the user's original is untouched.
    try {
      if (archive.uri.startsWith(Paths.cache.uri) && archive.exists) archive.delete()
    } catch {
      // The OS reclaims the cache.
    }
  }
}

async function unpackZip(archive: File, zipName: string, control: ImportControl): Promise<BulkImportSummary> {
  const budget = diskBudget()
  // Unpacked is at least the compressed size for anything worth importing.
  if ((archive.size ?? 0) > budget) throw new ImportLimitError(NO_SPACE)

  /** A library slot written through a handle opened on the first chunk. */
  class SlotTarget implements ZipTarget {
    readonly slot: LibrarySlot
    private handle: FileHandle | null = null
    constructor(name: string) {
      this.slot = newLibrarySlot(name)
    }
    write(chunk: Uint8Array) {
      if (!this.handle) {
        this.slot.target.create({ overwrite: true })
        this.handle = this.slot.target.open(FileMode.WriteOnly)
      }
      this.handle.writeBytes(chunk)
    }
    close() {
      this.handle?.close()
      this.handle = null
    }
    remove() {
      try {
        this.close()
      } catch {
        // Already closed.
      }
      deleteSlot(this.slot)
    }
  }

  const reader = archive.open(FileMode.ReadOnly)
  let result
  try {
    result = await unpackZipEntries<SlotTarget>({
      read: () => reader.readBytes(CHUNK_BYTES),
      create: (name) => new SlotTarget(name),
      budget,
      cancelled: () => control.cancelled,
      onEntry: (n) => control.onProgress?.(n, null),
      pause: yieldToUi,
    })
  } finally {
    reader.close()
  }

  const { written, unsupported, failed, overLimit } = result
  return commit(
    zipName,
    written.map((w) => ({ path: w.path, name: w.name, slot: w.target.slot })),
    { unsupported, failed, overLimit },
  )
}
