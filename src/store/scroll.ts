import { storage, scrollKey, zoomKey, progressKey, locationKey } from '../storage/mmkv'

/**
 * Per-file reading position and zoom.
 *
 * Deliberately **not** a React store. These are written on every scroll settle
 * and read once when a renderer mounts; putting them in Zustand would re-render
 * the pager on every tick. MMKV is synchronous and JSI-backed, so a plain
 * module-level API is both simpler and faster here.
 *
 * This is the mobile shape of the desktop rule "keep hot, high-frequency state
 * out of the files array".
 */

/**
 * Last value written for each key, so an unchanged write costs nothing.
 *
 * The guard used to be `storage.getNumber(key) === value`, which is correct but
 * pays a JSI round trip to *avoid* a JSI round trip — on the scroll path that
 * is a read on every frame to skip a write on most of them. MMKV is fast, but
 * this is the busiest path in the app and the read is pure overhead: this
 * module is the only writer, so what it last wrote is what is stored.
 *
 * A plain object rather than a Map: the keys are strings, the working set is
 * one entry per open file, and `forgetFile` clears them explicitly.
 *
 * Warm on first read so a restore does not immediately rewrite the value it
 * just loaded.
 */
const mirror: Record<string, number> = {}

export function getScroll(fileId: string): number {
  const key = scrollKey(fileId)
  const value = storage.getNumber(key) ?? 0
  mirror[key] = value
  return value
}

export function setScroll(fileId: string, y: number): void {
  // No-op when unchanged: without this a settled scroll would rewrite forever.
  const key = scrollKey(fileId)
  if (mirror[key] === y) return
  mirror[key] = y
  storage.set(key, y)
}

export function getZoom(fileId: string): number {
  const key = zoomKey(fileId)
  const value = storage.getNumber(key) ?? 1
  mirror[key] = value
  return value
}

export function setZoom(fileId: string, scale: number): void {
  const key = zoomKey(fileId)
  if (mirror[key] === scale) return
  mirror[key] = scale
  storage.set(key, scale)
}

/** Reading progress 0..100, surfaced on the file's library card. */
export function getProgress(fileId: string): number {
  const key = progressKey(fileId)
  const value = storage.getNumber(key) ?? 0
  mirror[key] = value
  return value
}

/**
 * Reading progress, rounded to a whole percent before it is stored.
 *
 * The rounding is not cosmetic. Every card subscribes to this key through
 * `useMMKVNumber`, so a write is a React re-render of that card — and an
 * unrounded value changes on every scroll frame, which would re-render the
 * board continuously behind the reader. Rounded, a 300-page book can only
 * change this 100 times end to end.
 */
export function setProgress(fileId: string, percent: number): void {
  const key = progressKey(fileId)
  const rounded = Math.max(0, Math.min(100, Math.round(percent)))
  if (mirror[key] === rounded) return
  mirror[key] = rounded
  storage.set(key, rounded)
}

/**
 * Reading position as a character offset into the document's text.
 *
 * The durable twin of `getScroll`. A pixel offset is a position in a *layout*,
 * so it means something different after a rotation, a font change or a margin
 * change — the reader comes back to the wrong place. A character offset is a
 * position in the *document*, and survives all three.
 *
 * Zero means "no anchor recorded": a genuine position at offset 0 is the top of
 * the document, which is also where the fallback lands, so the two are
 * indistinguishable in effect and neither needs a sentinel.
 *
 * Stored under `locationKey`, which has existed since the first storage pass
 * described as "for formats that locate by something other than px (EPUB CFI)"
 * and had no callers until now.
 */
export function getAnchor(fileId: string): number {
  const key = locationKey(fileId)
  const value = storage.getNumber(key) ?? 0
  mirror[key] = value
  return value
}

export function setAnchor(fileId: string, offset: number): void {
  const key = locationKey(fileId)
  const rounded = Math.max(0, Math.round(offset))
  if (mirror[key] === rounded) return
  mirror[key] = rounded
  storage.set(key, rounded)
}

export function forgetFile(fileId: string): void {
  for (const key of [scrollKey(fileId), zoomKey(fileId), progressKey(fileId), locationKey(fileId)]) {
    storage.remove(key)
    // Or a later write of the same value would be skipped as "unchanged" and
    // the key would stay deleted while the app believed it had been rewritten.
    delete mirror[key]
  }
}

/**
 * Drops the write-mirror without touching what is stored.
 *
 * For a restore, which replaces the bytes under ids the archive preserved. The
 * stored values are still wanted — a restore writes the archive's positions
 * into MMKV — but the mirror describes what *this process* last wrote, and
 * after a wholesale replacement that belief is wrong. Left in place it would
 * skip the first write of any value that happens to match, as "unchanged".
 *
 * Deliberately does **not** remove the keys. Blanking them here would discard
 * the positions a restore has just written, which is the opposite of what a
 * restore is for. Per-file cleanup is `forgetFile`'s job.
 */
export function forgetAllScroll(): void {
  for (const key of Object.keys(mirror)) delete mirror[key]
}
