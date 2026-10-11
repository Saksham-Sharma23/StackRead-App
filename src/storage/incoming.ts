import { Paths } from 'expo-file-system'

import * as Incoming from '../../modules/incoming-files/src'
import { useLibrary } from '../store/library'
import type { FileEntry } from '../types'
import { extensionOf } from './formats'
import { canReceive, findExisting, incomingFileName } from './incomingName'
import { libraryEntry, newLibrarySlot } from './files'
import { INBOX_GROUP_KEY, storage } from './mmkv'

/**
 * Files handed to StackRead by other apps — "Open with" and the share sheet —
 * copied into the library and opened.
 *
 * ## Where they go
 *
 * Into one group, "Opened files", made on first use and remembered by id
 * (`INBOX_GROUP_KEY`). Asking which group on every "Open with" would put a
 * question between the user and the document they just tapped, and a group is
 * one 3-dot move away afterwards. A file already in the library — same name,
 * same size — is opened where it is instead of being added again.
 *
 * ## The copy
 *
 * On a native background thread (`modules/incoming-files`), straight into the
 * library path: one copy, not the picker's cache-then-library two, and never
 * on the JS thread, where a large PDF would freeze the UI.
 */

const INBOX_TITLE = 'Opened files'

/**
 * Space left free after a copy. A full disk breaks MMKV and SQLite writes,
 * which are the library itself — far worse than refusing one file.
 */
const DISK_HEADROOM_BYTES = 64 * 1024 * 1024

export interface ReceiveResult {
  /** The file to open: the first one received, whether new or already present. */
  open: FileEntry | null
  added: number
  /** Names that are not a format StackRead can open. */
  unsupported: string[]
  /** Names that could not be copied (unreadable, or no space). */
  failed: string[]
}

/** The inbox group's id, creating the group if it does not exist. */
function inboxGroupId(): string {
  const library = useLibrary.getState()
  const stored = storage.getString(INBOX_GROUP_KEY)
  if (stored && library.groups.some((g) => g.id === stored)) return stored
  const id = library.addGroup(INBOX_TITLE)
  storage.set(INBOX_GROUP_KEY, id)
  return id
}

/** Imports the given received files. Never throws; failures are reported. */
export async function receiveFiles(items: Incoming.IncomingItem[]): Promise<ReceiveResult> {
  const result: ReceiveResult = { open: null, added: 0, unsupported: [], failed: [] }
  const added: FileEntry[] = []

  for (const item of items) {
    let name = 'file'
    try {
      const meta = await Incoming.describe(item.uri)
      name = incomingFileName(meta.name, item.mime ?? meta.mime)
      if (!canReceive(name)) {
        result.unsupported.push(name)
        continue
      }

      const library = useLibrary.getState()
      const existing =
        findExisting(Object.values(library.filesById), name, meta.size) ?? findExisting(added, name, meta.size)
      if (existing) {
        result.open ??= existing
        continue
      }

      if (meta.size && Paths.availableDiskSpace < meta.size + DISK_HEADROOM_BYTES) {
        result.failed.push(name)
        continue
      }

      const groupId = inboxGroupId()
      const order = (useLibrary.getState().groupOrder[groupId]?.length ?? 0) + added.length
      const slot = newLibrarySlot(name)
      try {
        await Incoming.copyTo(item.uri, slot.target.uri)
      } catch (err) {
        // The module deletes a partial copy; this covers a failure before it ran.
        try {
          if (slot.target.exists) slot.target.delete()
        } catch {
          // An orphan here is collected by the next prune.
        }
        throw err
      }
      const entry = libraryEntry(slot, name, groupId, order)
      added.push(entry)
      result.open ??= entry
    } catch (err) {
      // The extension, never the name (AUDIT4 D6): titles are personal.
      console.warn(`[stackread] could not receive a .${extensionOf(name) || '?'} file`, __DEV__ ? err : undefined)
      result.failed.push(name)
    }
  }

  if (added.length) useLibrary.getState().addFiles(added)
  result.added = added.length
  return result
}

/** Takes everything received since the last call, and imports it. */
export async function receivePending(): Promise<ReceiveResult | null> {
  const items = Incoming.takePending()
  return items.length ? receiveFiles(items) : null
}
