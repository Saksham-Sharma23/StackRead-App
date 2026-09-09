import { useEffect, useRef } from 'react'

import type { FileEntry } from '../types'
import { fileUri } from '../storage/paths'
import { useSearch } from '../store/search'
import { usePageNav } from '../store/pageNav'
import { isAvailable, search } from '../../modules/pdf-text/src'
import type { SearchHit } from '../search/types'

/**
 * Drives find-in-document for the PDF renderer.
 *
 * ## Why this is a hook rather than viewer code
 *
 * The WebView owns a DOM, so its search lives inside the viewer: it finds the
 * matches, paints them, and navigates between them without the native side ever
 * holding a list. A PDF has no DOM. The matches come back from pdfium as data,
 * so *something on the JS side* has to hold them and decide which one is
 * current — which is this.
 *
 * The two halves therefore look different, and deliberately converge on the
 * same two things: the shared hit shape from `search/types.ts`, and the same
 * `useSearch` store the viewer reports into. From the search bar's point of
 * view there is one feature.
 *
 * ## Why navigation is "jump to the page"
 *
 * pdfium gives per-match rectangles in page coordinates, and drawing them would
 * mean an overlay tracking the PDF view's own scroll, zoom and page geometry —
 * a second coordinate system to keep in sync with a native view that owns its
 * layout. The rects are carried on the hits regardless, so that overlay can be
 * built later without changing anything here; for now stepping through matches
 * moves the reader to the right page, which is the part that makes search
 * useful at all.
 */
export function usePdfSearch(file: FileEntry, active: boolean): void {
  const request = useSearch((s) => s.request[file.id])
  const step = useSearch((s) => s.step[file.id])

  /** Hits for the query currently displayed, held here rather than in the store. */
  const hits = useRef<SearchHit[]>([])
  const index = useRef(0)
  /**
   * The query those hits are for.
   *
   * Kept beside them because a status report has to name its query — the store
   * uses it to tell a fresh result from a stale one — and reading it back out
   * of the store at report time would be circular.
   */
  const activeQuery = useRef('')

  /*
   * Guards against a slow search landing after the query moved on.
   *
   * A search runs over the whole document, so on a long PDF it can easily
   * outlive the query that started it — the reader types another character, or
   * closes the bar. Without this the stale result would overwrite the current
   * one and the count would flicker backwards.
   */
  const generation = useRef(0)

  useEffect(() => {
    if (!active || !request) return

    const mine = ++generation.current
    const query = request.query

    if (!query) {
      hits.current = []
      index.current = 0
      activeQuery.current = ''
      useSearch.getState().report(file.id, { query: '', total: 0, current: 0 })
      return
    }

    if (!isAvailable()) {
      // The dev client predates the native module, or this is iOS. Reported as
      // a real (empty) result rather than left silent, so the bar can say so
      // instead of appearing to still be working.
      useSearch.getState().report(file.id, { query, total: 0, current: 0 })
      return
    }

    let cancelled = false

    void (async () => {
      try {
        const result = await search(fileUri(file.storedName), file.id, { text: query })
        if (cancelled || mine !== generation.current) return

        hits.current = result.hits
        index.current = 0
        activeQuery.current = query

        useSearch.getState().report(file.id, {
          query,
          total: result.hits.length,
          current: result.hits.length ? 1 : 0,
          truncated: result.truncated,
        })

        // Land on the first hit, matching what the viewer does on a new search.
        const first = result.hits[0]
        if (first?.page) usePageNav.getState().requestJump(file.id, first.page)
      } catch {
        // A PDF whose text cannot be read is a real case — a scan with no text
        // layer. Reported as no matches rather than as an error, because that
        // is what it means to the reader.
        if (!cancelled && mine === generation.current) {
          useSearch.getState().report(file.id, { query, total: 0, current: 0 })
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [active, request, file.id, file.storedName])

  // Next/previous. Wraps in both directions, as the viewer's does.
  useEffect(() => {
    if (!active || !step || !hits.current.length) return

    const count = hits.current.length
    const next = ((index.current + step.delta) % count + count) % count
    index.current = next

    const hit = hits.current[next]
    if (hit?.page) usePageNav.getState().requestJump(file.id, hit.page)

    useSearch.getState().report(file.id, {
      query: activeQuery.current,
      total: count,
      current: next + 1,
    })
  }, [active, step, file.id])
}
