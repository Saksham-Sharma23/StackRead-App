import { extensionForMime, isRenderable, isKnownExtension } from './formats.ts'

/**
 * Pure rules for files received from other apps — import-free apart from the
 * formats table, so they are testable without a device. The orchestration is
 * `storage/incoming.ts`.
 */

/** Shown when a sender gives no name at all. */
export const UNNAMED = 'Shared file'

/**
 * Long enough for any real title. A sender controls this string, and it is
 * shown on a card and in the reader's header.
 */
const MAX_NAME = 160

/**
 * The display name for a received file: the sender's name, made safe to show,
 * with an extension added from the declared type when the name has none.
 *
 * The name is display metadata only — the stored file is `<id>.<ext>`, and
 * `copyIntoLibrary`'s checks still apply — but it is attacker-controlled, so
 * path separators and control characters go, and the length is capped with the
 * extension kept.
 */
export function incomingFileName(displayName: string | null, mime: string | null): string {
  let name = (displayName ?? '').split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()
  if (!name || name === '.' || name === '..') name = UNNAMED

  if (!isKnownExtension(name)) {
    const ext = extensionForMime(mime)
    if (ext) name = `${name}.${ext}`
  }

  if (name.length > MAX_NAME) {
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : ''
    name = name.slice(0, MAX_NAME - ext.length).trimEnd() + ext
  }
  return name
}

/** Whether a received file can be imported: a format StackRead can render. */
export function canReceive(name: string): boolean {
  return isKnownExtension(name) && isRenderable(name)
}

/**
 * The library entry a received file already is, if any: same name, same size.
 *
 * Opening a file from WhatsApp twice should open it twice, not add it twice.
 * Name and size together, never name alone — two different `invoice.pdf` files
 * are common. No size from the sender means no match: a guess here would open
 * the wrong document.
 */
export function findExisting<T extends { name: string; size?: number }>(
  files: Iterable<T>,
  name: string,
  size: number | null,
): T | undefined {
  if (!size || size <= 0) return undefined
  for (const file of files) {
    if (file.name === name && file.size === size) return file
  }
  return undefined
}
