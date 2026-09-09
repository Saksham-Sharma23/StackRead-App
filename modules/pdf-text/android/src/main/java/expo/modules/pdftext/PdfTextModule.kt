package expo.modules.pdftext

import android.net.Uri
import android.os.ParcelFileDescriptor
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import io.legere.pdfiumandroid.FindFlags
import io.legere.pdfiumandroid.PdfDocument
import io.legere.pdfiumandroid.PdfiumCore
import java.io.File
import java.util.EnumSet

/**
 * PDF text extraction and search, over the pdfium engine that is already in the
 * build.
 *
 * ## Why this module exists at all
 *
 * The plan recorded PDF search as "deferred, deliberately — `react-native-pdf`
 * exposes no text layer". That is true of its **JavaScript API** and false of
 * what it links against: it depends on `io.legere:pdfiumandroid`, which wraps
 * pdfium's complete `FPDFText_*` and `FPDF_TextSearch` surface. The engine has
 * been compiled into every APK this project has produced; nothing exposed it.
 *
 * So this is a bridge, not an integration. No new rendering path, no second PDF
 * library, no change to `PdfRenderer` — which is the entire reason this option
 * was chosen over swapping the renderer for one that ships search.
 *
 * ## Why it opens its own document
 *
 * The rendering view holds its own `PdfDocument`, and it would be tempting to
 * reuse it. That is exactly the mistake that produced the crash the pager was
 * redesigned around: three live pdfium documents, and unmounting one mid-render
 * died inside `FPDF_LoadPage`. A handle owned here, opened and closed inside a
 * single call, cannot be invalidated by anything the renderer does — and the
 * renderer cannot be invalidated by a search.
 *
 * The cost is re-parsing the document per call. pdfium's open is lazy — it
 * reads the cross-reference table, not the pages — so this is milliseconds, and
 * it buys complete isolation between two things that must never share state.
 *
 * ## Coordinates
 *
 * Everything returned is in **character offsets into the document's extracted
 * text**, because that is the coordinate the WebView search already speaks and
 * the one `src/search/types.ts` defines. A hit from a PDF and a hit from an
 * EPUB are therefore the same shape, which is what keeps find-in-document one
 * feature rather than two.
 *
 * Rects are the exception: they are inherently per-page and in PDF page space,
 * so they travel alongside rather than instead.
 */
class PdfTextModule : Module() {

  override fun definition() = ModuleDefinition {
    Name("PdfText")

    /**
     * Whole-document text, with the character offset at which each page starts.
     *
     * The offsets are the useful half. Without them a caller has a string and
     * no way to say which page any position in it belongs to, so a search hit
     * could not be turned into a page to scroll to.
     */
    AsyncFunction("extractText") { uri: String ->
      withDocument(uri) { doc ->
        val pageCount = doc.getPageCount()
        val builder = StringBuilder()
        val pageStarts = ArrayList<Int>(pageCount)

        for (index in 0 until pageCount) {
          pageStarts.add(builder.length)
          builder.append(pageText(doc, index))
          // Pages are joined with a newline so a word cannot appear to span a
          // page boundary — searching for "the end" must not match the last
          // word of one page and the first of the next.
          if (index < pageCount - 1) builder.append('\n')
        }

        mapOf(
          "text" to builder.toString(),
          "pageCount" to pageCount,
          "pageStarts" to pageStarts,
        )
      }
    }

    /** Text of one page. 1-based, matching every other page number in the app. */
    AsyncFunction("pageText") { uri: String, page: Int ->
      withDocument(uri) { doc ->
        val index = page - 1
        if (index < 0 || index >= doc.getPageCount()) {
          throw PdfTextException("Page $page is outside this document")
        }
        pageText(doc, index)
      }
    }

    /**
     * Finds every occurrence of `query`, as hits in the shared shape.
     *
     * Uses pdfium's own `FPDF_TextSearch` rather than extracting the whole
     * document and matching in Kotlin. That matters for correctness as much as
     * speed: pdfium knows where a word is hyphenated across a line, which
     * glyphs are ligatures, and how a multi-column page reads — none of which
     * survives naive string matching over extracted text.
     */
    AsyncFunction("search") { uri: String, query: String, options: Map<String, Any?>? ->
      if (query.isEmpty()) return@AsyncFunction mapOf("hits" to emptyList<Any>(), "truncated" to false)

      val matchCase = options?.get("matchCase") as? Boolean ?: false
      val wholeWord = options?.get("wholeWord") as? Boolean ?: false
      val limit = (options?.get("limit") as? Number)?.toInt() ?: DEFAULT_LIMIT

      withDocument(uri) { doc ->
        val flags = EnumSet.noneOf(FindFlags::class.java)
        if (matchCase) flags.add(FindFlags.MatchCase)
        if (wholeWord) flags.add(FindFlags.MatchWholeWord)

        val hits = ArrayList<Map<String, Any?>>()
        var truncated = false
        var documentOffset = 0

        for (index in 0 until doc.getPageCount()) {
          if (truncated) break

          doc.openPage(index).use { page ->
            page.openTextPage().use { textPage ->
              val charCount = textPage.textPageCountChars()
              // The page's own text, used only for building context snippets —
              // the offsets themselves come from pdfium's search.
              val text = textPage.textPageGetText(0, charCount) ?: ""

              /*
               * `findStart` is nullable: pdfium returns no search handle for a
               * page it cannot build a text index for — an image-only scan, or
               * a page whose fonts have no usable encoding. That is a normal
               * page in a real document, not an error, so it is skipped and the
               * search continues rather than failing the whole document.
               */
              val find = textPage.findStart(query, flags, 0)
              if (find != null) {
                try {
                  while (find.findNext()) {
                    if (hits.size >= limit) {
                      truncated = true
                      break
                    }

                    val start = find.getSchResultIndex()
                    val length = find.getSchCount()
                    if (length <= 0) continue

                    hits.add(
                      buildHit(
                        pageNumber = index + 1,
                        documentOffset = documentOffset,
                        start = start,
                        length = length,
                        pageText = text,
                        rects = rectsFor(textPage, start, length),
                      ),
                    )
                  }
                } finally {
                  // Closed explicitly: a FindResult holds a native handle that
                  // is not owned by the text page, so letting it fall out of
                  // scope leaks for the life of the process.
                  find.closeFind()
                }
              }

              // +1 for the newline `extractText` inserts, so an offset returned
              // here indexes the same string that function produces.
              documentOffset += charCount + 1
            }
          }
        }

        mapOf("hits" to hits, "truncated" to truncated)
      }
    }
  }

  /**
   * Opens a document, runs `body`, and always closes it.
   *
   * The `use` blocks throughout are load-bearing rather than tidy: every pdfium
   * object here owns a native allocation that the JVM's garbage collector knows
   * nothing about, so a missed close is a leak that no amount of memory
   * pressure will reclaim.
   */
  private fun <T> withDocument(uri: String, body: (PdfDocument) -> T): T {
    val path = resolvePath(uri)
    val file = File(path)
    if (!file.exists()) throw PdfTextException("File not found: $path")

    val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    return descriptor.use { fd ->
      val core = PdfiumCore()
      core.newDocument(fd).use { doc -> body(doc) }
    }
  }

  /**
   * Turns a `file://` URI into a path.
   *
   * The library stores plain paths and hands out `file://` URIs; both arrive
   * here depending on the caller, and guessing wrong is a "file not found" on a
   * file that plainly exists.
   */
  private fun resolvePath(uri: String): String {
    if (!uri.startsWith("file://") && !uri.startsWith("content://")) return uri
    return Uri.parse(uri).path ?: uri
  }

  private fun pageText(doc: PdfDocument, index: Int): String =
    doc.openPage(index).use { page ->
      page.openTextPage().use { textPage ->
        textPage.textPageGetText(0, textPage.textPageCountChars()) ?: ""
      }
    }

  /**
   * Highlight geometry for one match.
   *
   * Returned per rect rather than merged here: merging is defined once in
   * `src/search/types.ts` so that the rule is shared with any other engine, and
   * duplicating it in Kotlin is how the two would drift.
   */
  private fun rectsFor(
    textPage: io.legere.pdfiumandroid.PdfTextPage,
    start: Int,
    length: Int,
  ): List<Map<String, Double>> = try {
    val count = textPage.textPageCountRects(start, length)
    (0 until count).mapNotNull { i ->
      textPage.textPageGetRect(i)?.let { r ->
        mapOf(
          "left" to r.left.toDouble(),
          "top" to r.top.toDouble(),
          "right" to r.right.toDouble(),
          "bottom" to r.bottom.toDouble(),
        )
      }
    }
  } catch (e: Exception) {
    // A match with no geometry is still a match. Losing the highlight is far
    // better than losing the hit.
    emptyList()
  }

  /** Assembles one hit in the shape `src/search/types.ts` defines. */
  private fun buildHit(
    pageNumber: Int,
    documentOffset: Int,
    start: Int,
    length: Int,
    pageText: String,
    rects: List<Map<String, Double>>,
  ): Map<String, Any?> {
    val from = maxOf(0, start - CONTEXT_RADIUS)
    val to = minOf(pageText.length, start + length + CONTEXT_RADIUS)

    // Guarded because pdfium's char indices and the extracted string can
    // disagree on documents with unusual encodings; a bad slice would throw and
    // fail the whole search rather than one snippet.
    val context = if (from < to && to <= pageText.length) {
      pageText.substring(from, to).replace(WHITESPACE, " ").trim()
    } else {
      ""
    }
    val prefix = if (from < start && start <= pageText.length) {
      pageText.substring(from, start).replace(WHITESPACE, " ").trimStart()
    } else {
      ""
    }

    return mapOf(
      "charOffset" to documentOffset + start,
      "length" to length,
      "page" to pageNumber,
      "context" to context,
      "contextOffset" to minOf(prefix.length, context.length),
      "rects" to rects,
    )
  }

  private companion object {
    /** Matches the JS side, so a snippet looks the same whichever engine made it. */
    const val CONTEXT_RADIUS = 40

    /**
     * Default cap on hits.
     *
     * A search for "the" in a long book has tens of thousands of matches and
     * nobody pages through them, but building the list still costs the memory
     * and the marshalling across the bridge.
     */
    const val DEFAULT_LIMIT = 500

    val WHITESPACE = Regex("\\s+")
  }
}

/** Surfaces as a rejected promise with a readable message rather than a crash. */
class PdfTextException(message: String) : Exception(message)
