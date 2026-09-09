import { useEffect, useRef } from 'react'

import type { FileEntry } from '../types'
import { ensureThumbnail } from '../storage/thumbs'
import { useLibrary } from '../store/library'

/**
 * Generates a card's preview the first time it renders without one.
 *
 * Kept out of `FileCard` itself so the card stays a pure presentational
 * component, and so the concurrency cap in `storage/thumbs` is the single place
 * that decides how much work runs at once.
 */
export function useThumbnail(file: FileEntry): void {
  const setThumb = useLibrary((s) => s.setThumb)

  /*
   * The entry is held in a ref so it can be read without being a dependency.
   *
   * `ensureThumbnail` needs the whole `FileEntry`, but depending on it would
   * re-run this effect whenever *any* field changed — and `setThumb` replaces
   * the entry object, so completing a thumbnail re-triggered the very effect
   * that produced it. The `thumb && thumbhash` guard below caught it before any
   * work happened, but React still tore down and re-registered the effect on
   * every card each time one finished, which is a burst of churn across the
   * whole board exactly while it is being scrolled.
   *
   * Assigned during render rather than in an effect: the effect below may run
   * before a separate ref-assigning effect would, and it must not read a stale
   * entry on the pass that actually does the work.
   */
  const latest = useRef(file)
  latest.current = file

  const needsThumb = !file.thumb || !file.thumbhash

  useEffect(() => {
    // A thumb with no hash still needs one pass: entries imported before
    // ThumbHash existed carry the image but no placeholder.
    if (!needsThumb) return

    let cancelled = false
    void (async () => {
      const entry = latest.current
      const result = await ensureThumbnail(entry)
      if (!cancelled && result) setThumb(entry.id, result.thumb, result.thumbhash)
    })()

    return () => {
      cancelled = true
    }
    // Keyed by id and by whether work is still needed — not by the entry — so
    // this fires once per card and once more only if its thumbnail is cleared.
  }, [file.id, needsThumb, setThumb])
}
