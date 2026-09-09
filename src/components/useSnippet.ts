import { useEffect, useState } from 'react'
import { File } from 'expo-file-system'

import type { FileEntry } from '../types'
import { LIBRARY_DIR } from '../storage/paths'
import { canSnippet, snippetFrom, SNIPPET_READ_BYTES } from '../storage/snippet'

/**
 * Reads the opening words of a document, for a card with no cover.
 *
 * ## Why the result is cached in a module map
 *
 * A card is mounted and unmounted every time its row scrolls in and out of the
 * virtualized board, and the snippet is a pure function of bytes that never
 * change — the library owns its copy. Without a cache, scrolling up and down a
 * board of text files would re-read the same file prefixes indefinitely.
 *
 * Keyed by file id and bounded, because a library can be far larger than the
 * number of previews worth remembering. Eviction is oldest-first insertion
 * order, which is the right policy here for the same reason it usually is not:
 * the value is cheap to recompute, so the cache exists to absorb scrolling
 * rather than to guarantee a hit.
 *
 * ## Why failures are cached too
 *
 * A file that yields no snippet — too short, all markup, unreadable — must not
 * be retried on every remount. `null` is a real answer and is stored as one.
 */

/** Previews already computed. `null` means "asked, and there is nothing". */
const cache = new Map<string, string | null>()

/**
 * Bound on remembered previews.
 *
 * Each is at most ~220 characters, so this is a few tens of kilobytes at worst
 * — small enough that the cap is about discipline rather than about memory.
 */
const MAX_CACHED = 200

function remember(fileId: string, value: string | null): void {
  if (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(fileId, value)
}

/** Drops one file's preview. Called from `lifecycle` when an id stops being valid. */
export function forgetSnippet(fileId: string): void {
  cache.delete(fileId)
}

/** Drops every preview, for a restore. */
export function clearSnippets(): void {
  cache.clear()
}

/**
 * The opening words of `file`, or null while unknown or unavailable.
 *
 * Returns synchronously on a cache hit, so a card scrolling back into view
 * paints its preview on the first frame rather than flashing a badge and then
 * replacing it — the same reasoning `WebViewRenderer` uses for seeding its
 * payload from the cache during render rather than in an effect.
 */
export function useSnippet(file: FileEntry): string | null {
  const eligible = !file.thumb && !file.thumbhash && canSnippet(file.format)

  const [snippet, setSnippet] = useState<string | null>(() =>
    eligible ? (cache.get(file.id) ?? null) : null,
  )

  useEffect(() => {
    if (!eligible) return
    // Already known, including a known failure. `has` rather than a truthiness
    // check, so a cached `null` is not retried forever.
    if (cache.has(file.id)) return

    let cancelled = false

    void (async () => {
      let text: string | null = null
      try {
        const source = new File(LIBRARY_DIR, file.storedName)
        if (source.exists) {
          /*
           * The whole file is read, then sliced.
           *
           * `expo-file-system` has no ranged text read, and adding a byte-range
           * path here would mean decoding a partial UTF-8 sequence at the
           * boundary. Every format this runs for is capped by
           * `MAX_PREPARE_BYTES` well below anything that matters, and the read
           * happens once per file for the life of the process.
           */
          text = (await source.text()).slice(0, SNIPPET_READ_BYTES)
        }
      } catch {
        // A preview is decoration. An unreadable file keeps its badge, and the
        // real error surfaces when the user opens it.
        text = null
      }

      const result =
        text && canSnippet(file.format) ? snippetFrom(text, file.format) : null

      // Cached before the cancellation check: the read already happened, and
      // throwing the result away would make a card that scrolls past mid-read
      // the one case that never benefits from the cache.
      remember(file.id, result)
      if (!cancelled) setSnippet(result)
    })()

    return () => {
      cancelled = true
    }
  }, [eligible, file.id, file.storedName, file.format])

  return snippet
}
