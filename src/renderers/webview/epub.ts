import { File } from 'expo-file-system'
import { strFromU8 } from 'fflate'

import { LIBRARY_DIR } from '../../storage/paths'
import { normalizeBookCss } from './bookCss'
import { mimeForImage } from './bytes'
// Images are registered as raw bytes here and encoded once, lazily, when the
// renderer streams them — so no base64 work happens during parsing any more.
import { openArchive, type ArchiveHandle, type OffloadLane } from './offload'
import { now, type PrepareTrace } from '../../ui/perf'
import { parseXml, asArray, attr, child, textOfNode } from './xml'
import { sanitizeHtml } from './sanitize'
import {
  CHARS_PER_PAGE,
  pagesFromChars,
  provisionalPageCount,
  parseNavPageList,
  parseNavToc,
  parseNcxPageList,
  parseNcxToc,
  visibleTextLength,
  type PageMark,
  type TocEntry,
} from './pagination'

/**
 * Unpacks an EPUB into a single HTML document.
 *
 * An EPUB is a ZIP of XHTML chapters plus an OPF manifest giving their reading
 * order. We resolve that order, concatenate the chapters, and inline images as
 * data URIs so the WebView needs no filesystem access.
 *
 * This is the mobile counterpart of the desktop app's epub.js renderer with
 * `manager: 'continuous'`: the whole book scrolls, rather than stopping at the
 * end of the first chapter.
 *
 * Page numbers come from the book itself where it declares them (EPUB 3
 * `page-list`, EPUB 2 NCX `<pageList>`), so a 145-page book reads as 145. Only
 * when a book declares nothing do we fall back to a character-count estimate.
 */

const MAX_INLINE_IMAGE_BYTES = 2_000_000

/**
 * Total budget for images carried with one book.
 *
 * The per-image cap alone is not enough: a book of sixty 1.5MB illustrations
 * passes every individual check and still adds up to ~90MB, which is what
 * exhausts memory on a real device.
 *
 * Past the budget, images are dropped rather than the book failing to open —
 * text is what a reader is there for, and a partly-illustrated book is far
 * better than a hang.
 *
 * **This is now a budget on raw bytes, not on base64.** Images used to be
 * embedded in the HTML as `data:` URIs, which cost ~4/3 of the bytes as a
 * string, held in the prepared-document cache, concatenated into one giant
 * document, and then duplicated again on the far side of the bridge — roughly
 * three times the underlying size. They are now delivered separately and turned
 * into `blob:` URLs inside the viewer (see `streamImages` in
 * `WebViewRenderer`), so the browser holds them as binary and decodes them
 * lazily, and the HTML string stays proportional to the *text*.
 */
const MAX_TOTAL_INLINE_BYTES = 24_000_000

/**
 * Spine items decompressed for the first paint.
 *
 * Deliberately a small count rather than a byte budget: phase 1 has to decide
 * what to decompress *before* it can measure anything, and a chapter's
 * uncompressed size from the central directory is the only signal available.
 * Three covers the title page plus a real opening chapter for essentially every
 * book.
 *
 * Deliberately not "the first chapter": a book whose first spine item is a
 * one-line title page would render an almost-empty screen and then jump.
 */
const FIRST_PAINT_SPINE_ITEMS = 3

/**
 * Assembled HTML per follow-up batch.
 *
 * Each batch crosses the bridge as one `postMessage` and is appended in one
 * DOM write, so this trades bridge round-trips against how long a single append
 * blocks the WebView's main thread. 250KB keeps an append comfortably inside a
 * frame on a mid-range device.
 */
const BATCH_CHARS = 250_000

export interface EpubResult {
  html: string
  title?: string
  /** Chapter list for the reader's Chapters sheet. */
  toc: TocEntry[]
  /** Real page count when the book declares one, else a character estimate. */
  totalPages: number
  /** True when `totalPages` came from the publisher rather than an estimate. */
  hasRealPages: boolean
  /**
   * Chapters held back from the first paint, in reading order.
   *
   * Appended by the viewer after it reports `ready`. Empty for a book small
   * enough to deliver whole.
   */
  rest: string[]
  /**
   * Phase 2, **not yet run**.
   *
   * Present when the book has spine items beyond the first paint. Calling it
   * decompresses and assembles the remainder and returns the batches plus the
   * *exact* page count.
   *
   * A function rather than eager work is the whole of R4-1: the previous
   * version parsed, sanitised, anchored and character-counted every chapter
   * before splitting off a first paint, so the reader waited for the entire
   * book to see page one ([AUDIT2 §1.3](../../AUDIT2.md)). Returning a thunk
   * moves that behind the first render instead of merely behind the first
   * delivery.
   */
  loadRest?: () => Promise<{ rest: string[]; totalPages: number }>
  /**
   * Images the markup references, **as paths rather than bytes**.
   *
   * Keeping them out of the HTML is what stops a heavily illustrated book
   * becoming one enormous string; keeping the *bytes* out of here as well is
   * what stops it becoming 24MB sitting in the prepared-document cache — three
   * of which the pinned window can hold at once.
   *
   * `loadImages` fetches them, once, when the reader streams them in. So a book
   * closed after two pages never decompresses an illustration it did not reach
   * — which the delivery code has always claimed and could not previously
   * deliver, because parsing had already paid for every one of them.
   */
  images: EpubImageRef[]
  /** Decompresses the registered images. Absent when the book has none. */
  loadImages?: () => Promise<EpubImage[]>
}

export interface EpubImage {
  token: string
  mime: string
  bytes: Uint8Array
}

/**
 * An image the markup references, **without its bytes**.
 *
 * Registered during parsing from the size in the ZIP central directory, so the
 * budgets below can be enforced with nothing decompressed. `loadImages`
 * fetches the bytes later, once the reader is actually looking at the book.
 */
export interface EpubImageRef {
  token: string
  mime: string
  /** Path inside the archive. */
  path: string
}

function textOf(zip: Record<string, Uint8Array>, path: string): string | null {
  const entry = zip[path]
  return entry ? strFromU8(entry) : null
}

/** ZIP paths are absolute-ish; resolve an href relative to its manifest. */
function resolvePath(base: string, href: string): string {
  const clean = href.split('#')[0]
  if (!base) return clean
  const parts = base.split('/')
  parts.pop()
  for (const seg of clean.split('/')) {
    if (seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

/** `chapter3.xhtml#page_42` → `{ path, fragment }`, resolved against the OPF. */
function splitHref(base: string, href: string): { path: string; fragment: string | null } {
  const hash = href.indexOf('#')
  return {
    path: resolvePath(base, hash >= 0 ? href.slice(0, hash) : href),
    fragment: hash >= 0 ? href.slice(hash + 1) : null,
  }
}

export async function loadEpubAsHtml(
  storedName: string,
  /** Which worklet runtime unzips the book. See `offload.ts`. */
  lane: OffloadLane = 'user',
  /**
   * Optional timing sink, threaded from `prepareFile`.
   *
   * EPUB is the one format that reads its own bytes rather than being handed
   * them, so the `read` segment has to be recorded here — `prepareFile` never
   * sees the file for this branch.
   */
  trace?: PrepareTrace,
): Promise<EpubResult> {
  const source = new File(LIBRARY_DIR, storedName)

  /*
   * Reads the book off disk.
   *
   * A function rather than bytes, and that is the point of A2
   * ([AUDIT4](../../../AUDIT4.md)). The archive is handed to the worker once
   * and parked there, and `loadRest` / `loadImages` below hold the *handle* —
   * so a cached book no longer keeps its whole file alive on the JS side. If
   * the worker has evicted the archive by the time they run, the handle calls
   * this again. Only the first read is a real part of opening the book, so
   * only it is timed.
   */
  let firstRead = true
  const load = async (): Promise<Uint8Array> => {
    const started = now()
    const bytes = await source.bytes()
    if (firstRead) {
      firstRead = false
      trace?.read(now() - started)
    }
    return bytes
  }

  const archive = await openArchive(load, lane, trace)
  try {
    return await buildBook(archive, trace)
  } catch (err) {
    // A book that fails to parse must not keep its archive on the worker.
    archive.release()
    throw err
  }
}

/**
 * Phase 1 of an EPUB, plus the deferred phase-2 thunks, over an open archive.
 *
 * Every read goes through `archive.unzip`, which sends entry names to the
 * worker rather than the book. That is what took an open from six full-archive
 * copies across the worklet boundary to one.
 */
async function buildBook(archive: ArchiveHandle, trace?: PrepareTrace): Promise<EpubResult> {
  /*
   * ## Two phases, and why
   *
   * This used to unzip the whole archive and then parse, sanitise, anchor and
   * character-count **every** chapter before splitting off a first paint — so a
   * 600-page book was fully assembled before the reader saw page one. The split
   * deferred *delivery*; it never deferred the work
   * ([AUDIT2 §1.3](../../AUDIT2.md)).
   *
   * Phase 1 below decompresses only what the first screens need: the container,
   * the OPF, the nav or NCX, the stylesheets, and the first few spine items.
   * Everything else is named but left compressed, which also keeps it off the
   * worklet boundary entirely — and that boundary copies every byte twice in
   * each direction ([AUDIT2 §1.2](../../AUDIT2.md)).
   *
   * ## What the entry listing buys
   *
   * The archive's listing comes from its central directory, taken when it was
   * parked, so `originalSize` is available with nothing decompressed. That is
   * what lets a book with no declared page list still report a page count on
   * the first frame.
   */
  const sizeOf = new Map<string, number>()
  for (const entry of archive.entries) sizeOf.set(entry.name, entry.originalSize)

  // The container names the OPF, and the OPF names everything else — so the
  // first read has to be these two before the rest can even be identified.
  const bootstrap = await archive.unzip(['META-INF/container.xml'], trace)
  const container = textOf(bootstrap, 'META-INF/container.xml')
  if (!container) throw new Error('Not a valid EPUB (no container.xml)')

  /*
   * Parsed as XML rather than scraped with regexes.
   *
   * The previous version matched every `<item>` tag with one regex and then
   * pulled each attribute out with a second. That fails silently on a book
   * whose manifest uses an explicit namespace (`<opf:item>`): the whole
   * manifest comes back empty and the book opens with no chapters, which reads
   * as "this EPUB has no table of contents" rather than as a parsing bug. Same
   * for a CDATA title and for attributes in an unexpected order. See `xml.ts`.
   */
  const containerDoc = parseXml(container)
  const opfPath = attr(
    asArray(child(child(child(containerDoc, 'container'), 'rootfiles'), 'rootfile'))[0],
    'full-path',
  )
  if (!opfPath) throw new Error('EPUB manifest not found')

  const opfZip = await archive.unzip([opfPath], trace)
  const opf = textOf(opfZip, opfPath)
  if (!opf) throw new Error('EPUB manifest unreadable')

  const opfDoc = parseXml(opf)
  const pkg = child(opfDoc, 'package')
  if (!pkg) throw new Error('EPUB manifest unreadable')

  // CDATA is merged into the element text by the parser, so a title wrapped in
  // it reads the same as a plain one — which the previous text capture could
  // not do.
  const title = textOfNode(child(child(pkg, 'metadata'), 'title')) || undefined

  // manifest: id -> { href, mediaType, properties }
  const manifest = new Map<string, { href: string; type: string; props: string }>()
  for (const item of asArray(child(child(pkg, 'manifest'), 'item'))) {
    const id = attr(item, 'id')
    const href = attr(item, 'href')
    if (!id || !href) continue
    manifest.set(id, {
      href,
      type: attr(item, 'media-type') ?? '',
      props: attr(item, 'properties') ?? '',
    })
  }

  const spineNode = child(pkg, 'spine')
  const spine: string[] = []
  for (const ref of asArray(child(spineNode, 'itemref'))) {
    const idref = attr(ref, 'idref')
    const item = idref ? manifest.get(idref) : undefined
    if (item) spine.push(item.href)
  }
  if (!spine.length) throw new Error('EPUB has no readable chapters')

  /*
   * ---- phase 1: decompress only what the first paint needs -----------------
   *
   * Named up front and fetched in one pass: nav, NCX, every stylesheet, and the
   * opening spine items. Everything else in the archive stays compressed and
   * never crosses the worklet boundary.
   *
   * The stylesheets are not optional here even though they are small — they
   * apply to every chapter, so appending them later would restyle the book
   * under the reader.
   */
  const navItemEarly = [...manifest.values()].find((i) => /nav/.test(i.props))
  const ncxIdEarly = attr(spineNode, 'toc')
  const ncxItemEarly = ncxIdEarly
    ? manifest.get(ncxIdEarly)
    : [...manifest.values()].find((i) => /ncx/i.test(i.type))

  const firstSpine = spine.slice(0, FIRST_PAINT_SPINE_ITEMS)

  const wanted = new Set<string>()
  if (navItemEarly) wanted.add(resolvePath(opfPath, navItemEarly.href))
  if (ncxItemEarly) wanted.add(resolvePath(opfPath, ncxItemEarly.href))
  for (const item of manifest.values()) {
    if (/text\/css/i.test(item.type)) wanted.add(resolvePath(opfPath, item.href))
    /*
     * Images travel with phase 1, and they have to.
     *
     * `registerImage` below resolves an <img> against the decompressed slice it
     * was given, so an image left out of every slice is not merely late — it is
     * dropped, silently, and the book renders without its illustrations. That
     * is a bug this restructure introduced and the test for it now pins.
     *
     * Cheap in practice despite the wording: `MAX_TOTAL_INLINE_BYTES` still
     * caps what is *kept*, and an image the reader never scrolls to is never
     * encoded — the lazy delivery in `WebViewRenderer` is what makes that true,
     * and it is unaffected by this.
     */
    if (/^image\//i.test(item.type)) wanted.add(resolvePath(opfPath, item.href))
  }
  for (const href of firstSpine) wanted.add(resolvePath(opfPath, href))

  const zip = await archive.unzip([...wanted], trace)

  // ---- navigation: page numbers and chapter list ----------------------------

  let pageMarks: PageMark[] = []
  let toc: TocEntry[] = []
  let navBase = opfPath

  // EPUB 3: the manifest item carrying properties="nav".
  const navItem = [...manifest.values()].find((i) => /\bnav\b/.test(i.props))
  if (navItem) {
    const navPath = resolvePath(opfPath, navItem.href)
    const navDoc = textOf(zip, navPath)
    if (navDoc) {
      navBase = navPath
      pageMarks = parseNavPageList(navDoc)
      toc = parseNavToc(navDoc)
    }
  }

  // EPUB 2 fallback: the NCX referenced by the spine's toc attribute.
  if (!pageMarks.length || !toc.length) {
    const ncxId = attr(spineNode, 'toc')
    const ncxItem = ncxId ? manifest.get(ncxId) : [...manifest.values()].find((i) => /ncx/i.test(i.type))
    if (ncxItem) {
      const ncxPath = resolvePath(opfPath, ncxItem.href)
      const ncx = textOf(zip, ncxPath)
      if (ncx) {
        if (!pageMarks.length) {
          pageMarks = parseNcxPageList(ncx)
          navBase = ncxPath
        }
        if (!toc.length) toc = parseNcxToc(ncx)
      }
    }
  }

  // Page marks grouped by the chapter they land in, so each chapter can have
  // its anchors injected while it is being processed.
  const marksByChapter = new Map<string, { label: string; fragment: string | null }[]>()
  for (const mark of pageMarks) {
    const { path, fragment } = splitHref(navBase, mark.href)
    const list = marksByChapter.get(path) ?? []
    list.push({ label: mark.label, fragment })
    marksByChapter.set(path, list)
  }

  // ---- stylesheet -----------------------------------------------------------

  const cssParts: string[] = []
  for (const item of manifest.values()) {
    if (!/text\/css/i.test(item.type)) continue
    const css = textOf(zip, resolvePath(opfPath, item.href))
    if (css) cssParts.push(css)
  }

  // ---- chapters -------------------------------------------------------------

  /**
   * Images this book needs, keyed by the token written into its markup.
   *
   * Held as raw bytes rather than base64 `data:` URIs. The renderer streams
   * these to the viewer after the document renders, and the viewer turns each
   * into a `blob:` URL — so the bytes cross the bridge once, as binary, and the
   * browser decodes them lazily instead of the app holding a ~4/3-sized string
   * copy of every image on both sides.
   */
  /**
   * Images this book needs, keyed by the token written into its markup.
   *
   * **Paths, not bytes.** The budgets below are enforced from the uncompressed
   * sizes in the ZIP central directory, which phase 1 already has — so a book
   * can be parsed, budgeted and rendered without a single illustration being
   * decompressed or crossing the worklet boundary
   * ([AUDIT2 §1.2](../../AUDIT2.md)).
   */
  const images = new Map<string, { path: string; mime: string }>()
  /** Token -> zip path, so a repeated image resolves to one entry. */
  const tokenByPath = new Map<string, string>()
  let inlinedBytes = 0

  /**
   * Registers one image for later fetching, returning its token.
   *
   * No decompression and no bytes: the size comes from the central-directory
   * listing, so both budgets are applied exactly as before while the image
   * itself stays compressed in the archive until something asks for it.
   *
   * The budget accounting lives here, on the registration path, so two chapters
   * referencing the same image charge it once.
   */
  const registerImage = (path: string): string | null => {
    const existing = tokenByPath.get(path)
    if (existing) return existing

    const size = sizeOf.get(path)
    if (size === undefined || size > MAX_INLINE_IMAGE_BYTES) return null

    if (inlinedBytes + size > MAX_TOTAL_INLINE_BYTES) return null
    inlinedBytes += size

    const token = `sr-img-${images.size}`
    images.set(token, { path, mime: mimeForImage(path) })
    tokenByPath.set(path, token)
    return token
  }

  const chapters: string[] = []
  let charCount = 0

  /**
   * Turns one spine item into an assembled `.sr-chapter` block.
   *
   * Extracted so **both phases run the same code**. Phase 1 calls it for the
   * opening items and phase 2 for the rest, and the alternative — two loops
   * that have to stay in step on sanitising, image registration and anchor
   * injection — is precisely the duplicated-decision shape
   * [AUDIT §7](../../AUDIT.md) named as a class of fault.
   *
   * Returns null for an entry that is not present in the archive slice it was
   * given, which is the normal way phase 1 skips a chapter it did not fetch.
   */
  const assembleChapter = (
    href: string,
    slice: Record<string, Uint8Array>,
  ): { html: string; chars: number } | null => {
    const chapterPath = resolvePath(opfPath, href)
    const raw = textOf(slice, chapterPath)
    if (!raw) return null

    let body = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? raw

    /*
     * Sanitise before anything else touches the chapter.
     *
     * The viewer sanitises too, and its DOM-based pass is the stronger one —
     * but it runs inside the WebView, after this markup has crossed the bridge.
     * An EPUB is a file from an arbitrary source, so the executable parts come
     * out here, on the native side, first. Done before image inlining so the
     * data: URIs generated below are never themselves re-inspected.
     */
    body = sanitizeHtml(body)

    /*
     * Rewrite image sources to tokens; drop ones we cannot resolve rather than
     * leaving a broken icon.
     *
     * Runs after sanitising, so an <img> a hostile book tried to smuggle past
     * the sanitiser is already gone and is never registered.
     *
     * The token goes in `data-sr-img` rather than `src`, and `src` is removed
     * outright. An `src` the browser cannot resolve would fire a network
     * request for a relative path — harmless here, since the viewer has no
     * network, but it also logs errors and leaves a broken-image icon until the
     * bytes land. With no `src` at all the element is simply empty until the
     * viewer fills it in.
     */
    body = body.replace(/<img\b[^>]*>/gi, (tag) => {
      const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1]
      if (!src) return ''
      if (/^(https?:|data:)/i.test(src)) return ''

      const token = registerImage(resolvePath(chapterPath, src))
      if (!token) return ''

      return tag.replace(/\bsrc\s*=\s*["'][^"']+["']/i, `data-sr-img="${token}"`)
    })

    body = injectPageAnchors(body, marksByChapter.get(chapterPath))

    // The chapter's own path becomes its id, so TOC links can find it.
    return {
      html: `<div class="sr-chapter" data-src="${escapeAttr(chapterPath)}">${body}</div>`,
      chars: visibleTextLength(body),
    }
  }

  for (const href of firstSpine) {
    const built = assembleChapter(href, zip)
    if (!built) continue
    chapters.push(built.html)
    charCount += built.chars
  }

  if (!chapters.length) throw new Error('EPUB chapters could not be read')

  /**
   * How many chapters the first paint carries.
   *
   * `loadRest` appends to the same `chapters` array, so this is the boundary
   * between what has already been delivered as `html` and what still has to be
   * batched. Captured before the thunk can run, which is the only moment it is
   * unambiguous.
   */
  const firstCount = chapters.length

  const style = cssParts.length
    ? `<style>${normalizeBookCss(cssParts.join('\n'))}</style>`
    : ''

  /*
   * ---- phase 2, deferred ----------------------------------------------------
   *
   * Built as a thunk and **not run here**. The caller renders the first paint,
   * and the renderer calls this once the viewer reports it is on screen — so
   * the reader sees page one after phase 1 rather than after the whole book.
   *
   * One targeted unzip for the remaining spine, so entries phase 1 already read
   * are neither fetched nor copied across the worklet boundary a second time.
   */
  const restSpine = spine.slice(FIRST_PAINT_SPINE_ITEMS)

  /*
   * When the archive can leave the worker.
   *
   * Phase 2 needs the archive, and it runs after the first paint — so it stays
   * parked until each thunk this book returns has finished once, then is
   * released. Set below, once `imageList` says whether there is an image thunk.
   * A thunk that is never called (the reader left before the first paint)
   * leaves the archive to the worker's own eviction, which keeps at most two.
   */
  let outstanding = 0
  const settle = (): void => {
    outstanding -= 1
    if (outstanding === 0) archive.release()
  }

  /*
   * Phase 2 runs **at most once** per parse.
   *
   * The thunk lives in the cached `Prepared`, so every renderer mounted from
   * that cache drains it: a reopen, a remounted neighbour. It appends to the
   * shared `chapters` array, so running it twice delivered the rest of the book
   * twice and doubled the page count ([AUDIT4 B2](../../../AUDIT4.md)). It is
   * also what decides when the archive is released, which only works if it
   * finishes once. A failure clears the memo so a later mount can retry.
   */
  let restDone: Promise<{ rest: string[]; totalPages: number }> | null = null

  const loadRest = (): Promise<{ rest: string[]; totalPages: number }> => {
    if (!restDone) {
      restDone = assembleRest().then(
        (result) => {
          settle()
          return result
        },
        (err: unknown) => {
          restDone = null
          throw err
        },
      )
    }
    return restDone
  }

  const assembleRest = async (): Promise<{ rest: string[]; totalPages: number }> => {
    if (restSpine.length) {
      const restPaths = restSpine.map((href) => resolvePath(opfPath, href))
      const restZip = await archive.unzip(restPaths)
      for (const href of restSpine) {
        const built = assembleChapter(href, restZip)
        if (!built) continue
        chapters.push(built.html)
        charCount += built.chars
      }
    }

    /*
     * Split for progressive delivery.
     *
     * Chapters are packed by accumulated size rather than count, and a chapter
     * is never split: `.sr-chapter` boundaries are what the TOC resolves
     * against (`seekToHref` matches on `data-src`), so a half-delivered chapter
     * would mean a chapter link that lands nowhere.
     *
     * The first-paint chapters are skipped here — they already went out with
     * `html`.
     */
    const batches: string[] = []
    let batchChars = 0
    let batch: string[] = []

    for (const chapter of chapters.slice(firstCount)) {
      batch.push(chapter)
      batchChars += chapter.length
      if (batchChars >= BATCH_CHARS) {
        batches.push(batch.join('\n'))
        batch = []
        batchChars = 0
      }
    }
    if (batch.length) batches.push(batch.join('\n'))

    return {
      rest: batches,
      // Exact now that every chapter has been counted. The publisher's own
      // page list still wins where the book declares one.
      totalPages: pageMarks.length || pagesFromChars(charCount, CHARS_PER_PAGE),
    }
  }

  const imageList: EpubImageRef[] = []
  for (const [token, image] of images) {
    imageList.push({ token, mime: image.mime, path: image.path })
  }

  /**
   * Fetches the registered images, in one targeted unzip.
   *
   * Called by the renderer when it starts streaming them, which is after the
   * document is on screen — so an illustrated book opens at the same speed as a
   * plain one, and one closed after two pages decompresses nothing at all.
   *
   * A single pass for every image rather than one per image: the archive's
   * central directory is walked once either way, and forty separate crossings
   * would cost far more than the one this makes.
   */
  const fetchImages = async (): Promise<EpubImage[]> => {
    if (!imageList.length) return []
    const slice = await archive.unzip(imageList.map((i) => i.path))
    const out: EpubImage[] = []
    for (const ref of imageList) {
      const entry = slice[ref.path]
      // An image the archive turns out not to contain simply does not arrive;
      // its element stays empty, exactly as a failed decode already does.
      if (entry) out.push({ token: ref.token, mime: ref.mime, bytes: entry })
    }
    return out
  }

  /*
   * Memoised like `loadRest`, for the same two reasons: a cached book must not
   * decompress its images again for every renderer mounted from the cache, and
   * the archive is released only once each thunk has finished.
   */
  let imagesDone: Promise<EpubImage[]> | null = null

  const loadImages = (): Promise<EpubImage[]> => {
    if (!imagesDone) {
      imagesDone = fetchImages().then(
        (result) => {
          settle()
          return result
        },
        (err: unknown) => {
          imagesDone = null
          throw err
        },
      )
    }
    return imagesDone
  }

  outstanding = (restSpine.length ? 1 : 0) + (imageList.length ? 1 : 0)
  // Nothing deferred: phase 1 was the whole book, so the worker can drop it now.
  if (!outstanding) archive.release()

  /*
   * The two-tier page count, with the second tier now provisional.
   *
   * Tier 1 is unchanged and still exact on the first frame: the publisher's
   * `page-list` lives in the nav or the NCX, both of which phase 1 decompresses.
   *
   * Tier 2 cannot be exact yet — phase 2 has not run, so most of the book's
   * text has not been counted. The estimate comes from the *uncompressed byte
   * sizes* in the ZIP central directory instead, which phase 1 has for free.
   * That keeps the invariant that matters: the number is a function of the
   * book's own content, never of layout, so rotating the phone still cannot
   * change it ([DETAIL.md §5.2](../../DETAIL.md)). `loadRest` replaces it with
   * the exact figure a moment later.
   */
  const spinePaths = spine.map((href) => resolvePath(opfPath, href))
  const totalPages =
    pageMarks.length || provisionalPageCount(spinePaths, sizeOf)

  return {
    html: style + chapters.slice(0, firstCount).join('\n'),
    title,
    toc,
    totalPages,
    hasRealPages: pageMarks.length > 0,
    // Phase 1 delivers everything it assembled; the remainder arrives through
    // `loadRest`.
    rest: [],
    images: imageList,
    loadImages: imageList.length ? loadImages : undefined,
    loadRest: restSpine.length ? loadRest : undefined,
  }
}

/**
 * Injects invisible markers at the publisher's page boundaries.
 *
 * The viewer reports the last marker scrolled past, which is how a print page
 * number can be shown for reflowable text — the same approach the W3C locators
 * note describes.
 */
function injectPageAnchors(
  body: string,
  marks: { label: string; fragment: string | null }[] | undefined,
): string {
  if (!marks?.length) return body

  let out = body
  for (const mark of marks) {
    const marker = `<span class="sr-pb" data-page="${escapeAttr(mark.label)}"></span>`

    if (!mark.fragment) {
      // Whole-chapter target: the boundary is the start of the chapter.
      out = marker + out
      continue
    }

    // Place the marker immediately before the element carrying that id.
    const idPattern = new RegExp(
      `<[a-z][a-z0-9]*\\b[^>]*\\bid\\s*=\\s*["']${escapeRegex(mark.fragment)}["']`,
      'i',
    )
    const at = out.search(idPattern)
    if (at >= 0) out = out.slice(0, at) + marker + out.slice(at)
    else out = marker + out
  }
  return out
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
