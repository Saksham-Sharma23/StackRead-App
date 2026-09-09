import { requireOptionalNativeModule } from 'expo'

import type { SearchHit, SearchQuery, SearchRect, SearchResult } from '../../../src/search/types'

/**
 * PDF text extraction and search, over the pdfium engine already in the build.
 *
 * ## Why `requireOptionalNativeModule`
 *
 * This is a **new native module**, so a JS bundle can reach a device whose app
 * binary predates it — which is the normal state of affairs during development,
 * because JS arrives over Fast Refresh and native code does not. The
 * non-optional `requireNativeModule` throws at import time in that situation,
 * and this module is imported by the reader, so the failure would not be "PDF
 * search is unavailable" but "the reader will not load".
 *
 * The same reasoning already governs the deferred `react-native-view-shot`
 * import in `PdfRenderer`, for the same failure mode. Here the graceful
 * degradation is `isAvailable() === false`, and the search UI says so.
 */

interface NativeHit {
  charOffset: number
  length: number
  page: number
  context: string
  contextOffset: number
  rects: SearchRect[]
}

interface NativeModule {
  extractText(uri: string): Promise<{ text: string; pageCount: number; pageStarts: number[] }>
  pageText(uri: string, page: number): Promise<string>
  search(
    uri: string,
    query: string,
    options?: { matchCase?: boolean; wholeWord?: boolean; limit?: number },
  ): Promise<{ hits: NativeHit[]; truncated: boolean }>
}

const native = requireOptionalNativeModule<NativeModule>('PdfText')

/**
 * Whether the native module is present in this build.
 *
 * False on a dev client that predates the module, and on iOS — where the
 * equivalent is PDFKit's `findString` and is separate work. Callers disable the
 * affordance and say why rather than offering a search that finds nothing.
 */
export function isAvailable(): boolean {
  return native !== null
}

/**
 * Whole-document text plus where each page begins.
 *
 * The page starts are what let a character offset be turned back into a page
 * number, which is how a hit becomes somewhere to scroll to.
 */
export async function extractText(
  uri: string,
): Promise<{ text: string; pageCount: number; pageStarts: number[] }> {
  if (!native) throw new Error('PDF text extraction is not available in this build')
  return native.extractText(uri)
}

/** Text of one page, 1-based. */
export async function pageText(uri: string, page: number): Promise<string> {
  if (!native) throw new Error('PDF text extraction is not available in this build')
  return native.pageText(uri, page)
}

/**
 * Searches a PDF, returning hits in the shape every engine in this app uses.
 *
 * The `fileId` is stamped on here rather than passed into native code: the
 * native side knows about a file on disk and nothing about the library's
 * identifiers, and keeping it that way means the module has no dependency on
 * how this app happens to name things.
 */
export async function search(
  uri: string,
  fileId: string,
  query: SearchQuery,
): Promise<SearchResult> {
  if (!native) return { hits: [], truncated: false }
  if (!query.text) return { hits: [], truncated: false }

  const result = await native.search(uri, query.text, {
    matchCase: query.matchCase,
    wholeWord: query.wholeWord,
    limit: query.limit,
  })

  const hits: SearchHit[] = result.hits.map((hit) => ({
    fileId,
    charOffset: hit.charOffset,
    length: hit.length,
    context: hit.context,
    contextOffset: hit.contextOffset,
    page: hit.page,
    rects: hit.rects,
  }))

  return { hits, truncated: result.truncated }
}
