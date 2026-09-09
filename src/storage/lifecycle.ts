import { forgetFile, forgetAllScroll } from '../store/scroll'
import { usePageNav } from '../store/pageNav'
import { useSearch } from '../store/search'
import { forgetPrepared, clearPrepared } from '../renderers/webview/prepareCache'
import { forgetPreparedOnDisk, clearPreparedOnDisk } from '../renderers/webview/diskCache'
import { forgetPrefetchFailure, resetPrefetchFailures } from '../renderers/webview/prefetch'
import { forgetSize, clearSizeCache } from './files'
import { resetThumbnailAttempt, resetAllThumbnailAttempts } from './thumbs'
import { forgetSnippet, clearSnippets } from '../components/useSnippet'

/**
 * The one place that knows when a `file.id` stops being valid.
 *
 * ## Why this module exists
 *
 * The app accumulated **five** caches and side tables keyed by file id, each
 * added with a perfectly good local justification:
 *
 *  - `prepareCache` — the parsed document, tens of megabytes for a big book
 *  - `thumbs.attempted` — "already tried to make a cover for this id"
 *  - `prefetch.failed` — "this id could not be prepared"
 *  - `files.sizeCache` — id to byte size
 *  - the `store/scroll` mirror plus its three MMKV keys
 *
 * A sixth has since been added — `useSnippet`'s preview cache — and it was
 * registered here in the same change that introduced it, which is the whole
 * point of this module existing.
 *
 * Two more are **Zustand stores** rather than module-level maps, which is
 * exactly why they were missed for four audits:
 *
 *  - `store/pageNav` — `byFile`, `jump`, `hrefJump`, `toc` per file id
 *  - `store/search`  — `byFile`, `request`, `step` per file id
 *
 * Being a store is not an exemption. Both are keyed by `fileId`, so both hold
 * the same wrong belief after a restore as any other cache here. They looked
 * safe because every renderer calls `forget()` on unmount, which covers the
 * common path and hides the one that matters: a restore performed *while a
 * reader is open*, or while a prefetched neighbour still holds a position,
 * leaves a live entry describing a document that no longer exists at that id.
 * The reader would then show the previous book's TOC, page count and match
 * count under the new one.
 *
 * Nothing owned the question they all depend on. Two of the five had an
 * invalidation function that **no code path called** — `forgetFile` was the only
 * thing that removed a file's `scroll:`/`zoom:`/`progress:` keys from MMKV, so
 * every file ever deleted leaked three keys permanently, in a memory-mapped
 * store that is loaded in full at startup. And the single operation that
 * invalidates every one of them at once — restore from backup — called none.
 *
 * The restore case is the sharp one, and it is worth being precise about why it
 * is reachable rather than theoretical: **an export deliberately preserves file
 * ids**, because `library.json` inside the archive is the real index. That is
 * correct for a backup. It also means restoring onto a device that still holds
 * those ids leaves five caches pointing at bytes that have been replaced
 * underneath them — and a `prepareCache` hit is returned synchronously and
 * unconditionally, so the reader can serve the *previous* document.
 *
 * ## Why a separate module rather than a function in one of them
 *
 * It has to reach into `store/`, `storage/` and `renderers/`. Putting it in any
 * one of those creates an import cycle — `scroll` would import `prepareCache`,
 * which imports `prepare`, which imports back into `storage`. Here it depends
 * on all three and nothing depends on it, so the graph stays acyclic.
 *
 * It is also somewhere to put the rule itself:
 *
 * > **Every cache keyed by file id must be invalidated here.** Adding a sixth
 * > without adding a line below is how this class of bug comes back, and it is
 * > invisible in review because each cache looks correct on its own.
 */

/**
 * Forgets everything the app remembers about one file id.
 *
 * Call this wherever a file stops existing or its bytes change: removal,
 * group deletion, a re-import that reuses the id.
 *
 * Ordered cheapest-first, and every step is independent — none of these can
 * fail in a way that should stop the others, so there is no error handling to
 * get wrong. Each underlying call is idempotent, so committing a removal twice
 * is harmless.
 */
export function forgetFileEverywhere(fileId: string): void {
  // The big one: a parsed EPUB or comic can be tens of megabytes.
  forgetPrepared(fileId)
  // And its persisted twin. The stamped filename already stops a *stale* parse
  // being read, so this is about reclaiming the space once the file is gone.
  forgetPreparedOnDisk(fileId)
  // Reading position, zoom and progress, in MMKV and in the module mirror that
  // shadows it. Skipping the mirror would leave a later write of the same value
  // silently discarded as "unchanged" against a key that no longer exists.
  forgetFile(fileId)
  forgetSize(fileId)
  // Clears both tiers: the session set and the durable `thumbfail:` key that
  // records "this file has no cover to extract" across launches.
  resetThumbnailAttempt(fileId)
  forgetPrefetchFailure(fileId)
  // The card's text preview. Same rule as the rest: an id-keyed cache that is
  // not invalidated here serves the previous file's content after a restore,
  // because an export deliberately preserves ids.
  forgetSnippet(fileId)
  /*
   * Reading position, chapters and search results for this id.
   *
   * Belt-and-braces on this path, and deliberately kept rather than left out:
   * every renderer already calls `forget()` on unmount, so by the time a file
   * is removed its entries are normally gone. "Normally" is the problem — that
   * is a guarantee spread across three renderers, and this module exists
   * precisely so the guarantee lives in one place instead. Both calls are
   * cheap and idempotent, and both early-return when there is nothing to drop.
   */
  usePageNav.getState().forget(fileId)
  useSearch.getState().forget(fileId)
}

/**
 * Forgets every file, for an operation that invalidates the whole library.
 *
 * Restore is the case this exists for. It deletes the library directory and
 * writes an archive's files in its place, so *every* id-keyed assumption in the
 * process is stale at once — and because ids are preserved by design, "stale"
 * means "wrong", not merely "absent".
 *
 * Not built as a loop over `forgetFileEverywhere`, deliberately: the caller
 * would have to know every id, and after a restore the ids that matter are
 * precisely the ones it no longer has. Clearing wholesale needs no such list
 * and cannot miss one.
 *
 * Note what this does **not** clear: the MMKV scroll keys. A restore's own
 * position data is written into them (see backup restore), and blanking every
 * key here would either race that write or discard it. Per-file removal is
 * where those keys get cleaned up.
 */
export function resetAllCaches(): void {
  clearPrepared()
  clearPreparedOnDisk()
  clearSizeCache()
  resetAllThumbnailAttempts()
  resetPrefetchFailures()
  clearSnippets()
  forgetAllScroll()
  /*
   * The two id-keyed stores, cleared wholesale.
   *
   * `setState` rather than a loop over `forget()`, for the reason given above:
   * after a restore the ids that matter are exactly the ones no caller still
   * has. Replacing the four maps outright cannot miss one.
   *
   * Only the keyed maps are replaced. `useSearch.open` and `query` describe the
   * *search bar*, not any file, and blanking them would close a bar the user
   * has open — a restore invalidates documents, not UI state.
   */
  usePageNav.setState({ byFile: {}, jump: {}, hrefJump: {}, toc: {} })
  useSearch.setState({ byFile: {}, request: {}, step: {} })
}
