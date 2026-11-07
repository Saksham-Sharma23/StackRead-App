import type { FileEntry } from '../types'
import type { SearchPage } from '../storage/db'

/**
 * What a library search may show and open.
 *
 * ## The bug this closes
 *
 * Search answers from SQLite, and SQLite lags the store: a removed file keeps
 * its row until its 5-second undo window ends, and every change reaches the
 * database up to a 400 ms debounce later. So a file the user had just removed
 * still appeared in the results — and tapping it opened the reader on a group
 * that (correctly) hides it, which fell back to index 0 and **opened a
 * different file**. A file moved since the query was run opened into its old
 * group the same way.
 *
 * The store is the truth for both questions, so results are filtered against
 * it when shown, and a tapped result is swapped for the store's own entry
 * before it is opened.
 *
 * Pure, so it is tested in Node (`searchTarget.test.ts`).
 */

/**
 * The page minus anything inside its undo window.
 *
 * Returns **the same page** when nothing is hidden, so a memo over it keeps its
 * identity on every keystroke that hides nothing — which is nearly all of them.
 *
 * `total` drops by what was filtered here. A hidden match beyond the fetched
 * rows is not seen, so the count can be one or two high while a removal is
 * pending — never low, and corrected the moment the removal commits.
 */
export function visibleResults(page: SearchPage, hidden: ReadonlySet<string>): SearchPage {
  if (!hidden.size || !page.files.length) return page
  const files = page.files.filter((f) => !hidden.has(f.id))
  if (files.length === page.files.length) return page
  return { files, total: Math.max(files.length, page.total - (page.files.length - files.length)) }
}

/**
 * The entry to open for a tapped result, or null if it should not open.
 *
 * Null when the file is mid-removal or already gone. Otherwise the store's
 * entry rather than the row search returned, so the reader opens it in the
 * group it is in now.
 */
export function openTarget(
  result: FileEntry,
  filesById: Readonly<Record<string, FileEntry>>,
  hidden: ReadonlySet<string>,
): FileEntry | null {
  if (hidden.has(result.id)) return null
  return filesById[result.id] ?? null
}
