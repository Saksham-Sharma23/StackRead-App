import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Linking, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'

import { getScroll, setScroll, setProgress, getAnchor, setAnchor } from '../store/scroll'
import { usePageNav } from '../store/pageNav'
import { useSearch } from '../store/search'
import { useReaderSettings, type ReaderSettings } from '../store/readerSettings'
import { useTheme, type Theme } from '../ui/theme'
import { Spring } from '../ui/motion'
import { LoadingCover } from '../components/LoadingCover'
import { buildViewerHtml } from './webview/viewerHtml'
import { prepareFile, type Prepared, type PreparedImage } from './webview/prepare'
import { strToU8 } from 'fflate'

import { toBase64OffThread } from './webview/offload'
import { getPrepared, replacePrepared, setPrepared } from './webview/prepareCache'
import { readPrepared, readPreparedAsync, writePrepared } from './webview/diskCache'
import { LIBRARY_DIR } from '../storage/paths'
import { File } from 'expo-file-system'
import { PERF, now, perf } from '../ui/perf'
import type { RendererProps } from './types'
import { parseViewerMessage } from './webview/viewerMessage'

/**
 * Host for every format the desktop app rendered as HTML: EPUB, HTML, Markdown
 * and plain text.
 *
 * One WebView serves all of them — the format only decides how content is
 * prepared before it is pushed in. That is what makes the remaining formats
 * (DOCX, spreadsheets, CBZ) additive rather than another native integration
 * each: they become new preparation functions feeding the same host.
 *
 * The WebView loads bundled HTML and is denied navigation entirely, so file
 * content can never reach the network.
 */

type Payload = {
  format: string
  content: string
  mode: string
  /** Content-derived page count; the viewer never computes this from layout. */
  totalPages: number
  scroll: number
  /**
   * Reading position as a character offset, preferred over `scroll`.
   *
   * Both travel: the anchor is accurate across a rotation or font change, and
   * the pixel offset is the fallback for a document with no usable text nodes.
   */
  anchor: number
  settings: ReturnType<typeof viewerSettings>
  /**
   * True when more content follows this payload.
   *
   * The viewer needs to know, because it changes what an unreachable scroll
   * target means: with everything delivered it means layout has not settled and
   * is worth retrying for a few frames, but mid-stream it means the content is
   * simply not here yet and must be parked until it arrives.
   */
  streaming?: boolean
}

/** The subset of reader settings the viewer needs, resolved against the theme. */
function viewerSettings(s: ReaderSettings, theme: Theme) {
  const paper =
    s.theme === 'sepia'
      ? '#f4ecd8'
      : s.theme === 'black'
        ? '#000000'
        : s.theme === 'dark'
          ? '#17171b'
          : s.theme === 'light'
            ? '#ffffff'
            : theme.surface

  const ink =
    s.theme === 'sepia'
      ? '#4a3f2f'
      : s.theme === 'black' || s.theme === 'dark'
        ? '#e8e8ee'
        : s.theme === 'light'
          ? '#14141a'
          : theme.fg

  return { fontSize: s.fontSize, lineHeight: s.lineHeight, margin: s.margin, paper, ink }
}

/**
 * Reads a prepared document from disk and promotes it into the memory cache.
 *
 * Promoting matters: without it a file swiped away from and back to would hit
 * the disk every time, and the pinned window — which exists to make exactly
 * that free — would never hold it. One read, then it behaves like any other
 * warm entry.
 *
 * Returns undefined rather than null so it composes with `getPrepared` under
 * `??`, whose miss value is undefined.
 */
function readPreparedFromDisk(fileId: string, storedName: string): Prepared | undefined {
  const hit = readPrepared(fileId, new File(LIBRARY_DIR, storedName))
  if (!hit) return undefined
  setPrepared(fileId, hit)
  return hit
}

/**
 * The prepared document for a file, from memory or disk, or undefined.
 *
 * Extracted because this exact expression appeared twice — in the lazy `payload`
 * initialiser and again in the `active` effect — and the two had drifted in what
 * they did with the result. One function means a future change to the lookup
 * order cannot be applied to only one of them.
 *
 * Both callers need it synchronously: the initialiser so a warm file paints on
 * frame one rather than flashing a spinner, and the effect so a cache hit does
 * not yield to the event loop before rendering.
 */
function readCached(fileId: string, storedName: string): Prepared | undefined {
  return getPrepared(fileId) ?? readPreparedFromDisk(fileId, storedName)
}

/**
 * The navigation guard, at module scope.
 *
 * A constant rather than an inline arrow: it closes over nothing, so there is
 * no reason for it to have a new identity on every render — and it is handed to
 * a native view, where a changed prop is a real update rather than a cheap
 * comparison. The security posture is unchanged; only the identity is.
 */
/**
 * How many times a dead WebView renderer is replaced before giving up.
 *
 * One. The renderer process is killed mostly under memory pressure, and one
 * fresh start usually succeeds. A second death in the same renderer means the
 * document itself is what exhausts it, and restarting again would loop.
 */
const MAX_RENDERER_RESTARTS = 1

/**
 * Offers an external link from a document to the user — never opens it unasked.
 *
 * The viewer intercepts every link tap ([AUDIT4 B6](../../AUDIT4.md)). Before
 * that, an external link failed the WebView's origin whitelist and
 * `react-native-webview` passed it straight to the OS, so a document could
 * launch the browser, the dialler or the store with a URL of its choosing.
 *
 * Only `http(s)` is offered. A document has no legitimate reason to start a
 * call or an app install, and `intent:`-style schemes are exactly what a
 * hostile file would use. The URL is shown before anything opens, truncated so
 * a long one cannot push the buttons off screen.
 */
function offerExternalLink(href: string): void {
  const url = href.trim().slice(0, 2048)
  if (!/^https?:\/\//i.test(url)) {
    Alert.alert('Link not opened', 'StackRead only opens web links from documents.')
    return
  }
  const shown = url.length > 200 ? `${url.slice(0, 200)}…` : url
  Alert.alert('Open this link in your browser?', shown, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Open', onPress: () => void Linking.openURL(url).catch(() => {}) },
  ])
}

function allowOnlyBundledContent(req: { url: string }): boolean {
  return req.url === 'about:blank' || req.url.startsWith('data:')
}

export function WebViewRenderer({ file, active, fullscreen, onScaleChange }: RendererProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()

  const webRef = useRef<WebView>(null)
  /*
   * Seeded from the cache during the very first render, not in an effect.
   *
   * Effects run after the first paint, so reading the cache there guarantees
   * one frame with `payload` null — a spinner flash on every swipe to an
   * already-prepared neighbour, which is precisely what the pinned window
   * exists to eliminate. A lazy initialiser runs before that frame, so a warm
   * file paints its content immediately and never shows a loading state at all.
   */
  // Read before the payload initialiser below, which uses them during the
  // first render — a later declaration would be a temporal dead zone error.
  const fontSize = useReaderSettings((s) => s.fontSize)
  const lineHeight = useReaderSettings((s) => s.lineHeight)
  const margin = useReaderSettings((s) => s.margin)
  const readerTheme = useReaderSettings((s) => s.theme)

  /**
   * The cache hit this mount started from, if there was one.
   *
   * Read once into a ref rather than twice: the `payload` initialiser needs it,
   * and so do the delivery refs below, which are declared after it and cannot
   * be written from inside a `useState` initialiser.
   *
   * `useRef` with a lazy-ish guard rather than `useState`, because nothing
   * renders from this and it must be available during the very first render.
   */
  const warmRef = useRef<{ done: boolean; hit: Prepared | undefined }>({
    done: false,
    hit: undefined,
  })
  if (!warmRef.current.done) {
    // Memory first, then disk. Both are synchronous, which is what lets a warm
    // file paint its content on the very first frame instead of showing a
    // spinner for one frame and then replacing it.
    warmRef.current = { done: true, hit: readCached(file.id, file.storedName) }
  }

  const [payload, setPayload] = useState<Payload | null>(() => {
    const cached = warmRef.current.hit
    if (!cached) return null
    return { ...cached, scroll: getScroll(file.id), anchor: getAnchor(file.id), settings: viewerSettings(
      { fontSize, lineHeight, margin, theme: readerTheme },
      theme,
    ) }
  })
  /**
   * The payload embedded in the document, if this mount started warm.
   *
   * Captured once, at mount, and never updated — it names the object that went
   * into the HTML, so the push effect below can compare against it by identity
   * and skip a redundant re-render of a document the viewer already has.
   *
   * Only a warm mount inlines. A cold one still gets an empty shell and the
   * message path, deliberately: the WebView can be constructing itself while
   * `prepareFile` runs, and rebuilding `source` when the parse lands would
   * throw that overlap away and reload the whole page.
   */
  const inlinedPayload = useRef(payload).current

  /**
   * Whether this renderer is the one on screen, readable from a callback.
   *
   * A ref rather than a dependency: `handleMessage` is handed to a native view,
   * so a new identity is a real prop update on a component that is rendering a
   * document — and `active` flips on every page turn. Assigned during render so
   * a message arriving in the same frame as a swipe sees the current value.
   */
  const activeRef = useRef(active)
  activeRef.current = active

  const [error, setError] = useState<string | null>(null)

  /*
   * Readiness is two distinct states, not one.
   *
   * `booted` means the viewer script is running and can receive a message — it
   * is what gates pushing content in. `rendered` means that content is actually
   * in the DOM and measured, which is what `settings`, `seek` and `seekHref`
   * need: a seek posted before the document exists finds nothing to scroll to
   * and is silently dropped. Collapsing the two is what made a TOC jump or a
   * font change issued immediately after opening a file do nothing at all.
   */
  const [booted, setBooted] = useState(false)
  const [rendered, setRendered] = useState(false)

  /**
   * The viewer's own lifecycle, for the `[perf] viewer` line.
   *
   * A ref rather than state because nothing renders from it and it is written
   * on three messages plus every payload push — as state that would be four
   * extra renders per document, on the component this series is trying to make
   * cheaper.
   *
   * `pushedAt` is the clock all three segments are measured from: it is the
   * moment content exists to be shown, which is what makes `boot` the WebView's
   * own construction cost rather than a number that includes the parse.
   */
  const viewerTrace = useRef({ pushedAt: 0, boot: 0, ready: 0, batches: 0, images: 0 })

  const report = usePageNav((s) => s.report)
  const forget = usePageNav((s) => s.forget)
  const setToc = usePageNav((s) => s.setToc)
  const jump = usePageNav((s) => s.jump[file.id])
  const hrefJump = usePageNav((s) => s.hrefJump[file.id])
  const searchRequest = useSearch((s) => s.request[file.id])
  const searchStep = useSearch((s) => s.step[file.id])


  const settings = useMemo(
    () => viewerSettings({ fontSize, lineHeight, margin, theme: readerTheme }, theme),
    [fontSize, lineHeight, margin, readerTheme, theme],
  )

  // Animated so entering fullscreen expands the page rather than snapping it.
  const inset = useSharedValue(1)

  useEffect(() => {
    inset.value = withSpring(fullscreen ? 0 : 1, Spring.smooth)
  }, [fullscreen, inset])

  const insetStyle = useAnimatedStyle(() => ({
    marginTop: insets.top * inset.value,
    marginBottom: insets.bottom * inset.value,
  }))

  const webViewStyle = useMemo(() => ({ backgroundColor: theme.bg }), [theme.bg])

  const initialScroll = useRef(getScroll(file.id)).current
  // Read once on mount for the same reason as the offset above: re-reading it
  // later would fight the reader's own scrolling.
  const initialAnchor = useRef(getAnchor(file.id)).current

  const html = useMemo(
    () =>
      buildViewerHtml(
        {
          bg: theme.bg,
          fg: theme.fg,
          fgDim: theme.fgDim,
          accent: theme.accent,
          border: theme.border,
          surfaceAlt: theme.surfaceAlt,
          surface: theme.surface,
          gutter: theme.gutter,
        },
        initialScroll,
        // Not a dependency: PERF is a module-level constant, so it cannot
        // change for the life of the process.
        PERF,
        /*
         * `?? undefined`, so the call says what it means.
         *
         * A cold mount holds `null` here, and "no cache hit" and "nothing to
         * inline" are the same statement — but only one of them was expressible
         * to a builder that tested for absence. Normalising at the call site
         * makes the intent local rather than something the reader has to
         * reconstruct from the guard at the other end.
         */
        inlinedPayload ?? undefined,
      ),
    [theme, initialScroll, inlinedPayload],
  )

  /*
   * Latest settings without making them a load dependency.
   *
   * Declared above the effect that reads it, not below. The read below happens
   * inside an async closure, so a later declaration type-checks and works by
   * accident of effect ordering — but it is a temporal dead zone reference, and
   * it would throw `Cannot access 'settingsRef' before initialization` the day
   * that effect becomes a layout effect or runs any earlier.
   */
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  /**
   * Content batches still to be delivered to the viewer.
   *
   * A ref, not state: these are written once when preparation finishes and
   * drained once by the effect below, and nothing renders them — as state they
   * would cost a re-render per batch for no visible change.
   */
  const restRef = useRef<string[]>([])

  /**
   * Images awaiting delivery to the viewer, drained after `ready`.
   *
   * A ref for the same reason as `restRef`: written once when preparation
   * finishes, drained once, and never rendered.
   */
  const imagesRef = useRef<PreparedImage[]>([])

  /**
   * Phase 2 of an EPUB, still to be run.
   *
   * Held rather than called, and drained once by the streaming effect below —
   * which is the point of R4-1: assembling the rest of the book happens after
   * the first paint is on screen, not before the caller sees anything.
   */
  const loadRestRef = useRef<Prepared['loadRest'] | null>(null)

  /**
   * The EPUB image fetcher, still to be run.
   *
   * Paired with `imagesRef`: when this is set, the images have been *referenced*
   * but not decompressed, and the streaming effect below fetches them before it
   * starts encoding. That is what keeps an illustrated book out of the prepared
   * cache at full size and lets one closed after two pages pay for nothing.
   */
  const loadImagesRef = useRef<Prepared['loadImages'] | null>(null)

  /*
   * Seed both refs from a warm-cache mount, matching what `apply()` does.
   *
   * The lazy `payload` initialiser above seeds the *content* from cache so a
   * warm file paints on frame one — correct, and well documented. It did not
   * seed these two, so a renderer mounted from cache had a document but no
   * deferred chapters and no images queued to deliver.
   *
   * Today the `active` effect below re-reads the same cache and calls
   * `apply(cached)`, which repairs it before anything notices — so this is not
   * a live bug. It is a trap armed for whoever re-enables neighbour mounting: a
   * renderer mounted **inactive** with a warm cache takes the initialiser path
   * and never the effect, and would render a book's first screens with its
   * remaining chapters silently dropped.
   *
   * Guarded on the same one-shot flag, so a re-render cannot re-seed refs the
   * delivery effects have already drained — that would append the book twice.
   *
   * **`setToc` is deliberately not called here.** It is a store write, and a
   * render-phase initialiser must not write to another component's store; it
   * stays in the effect, which is the only place it can legally run. That is
   * why this seeds refs only and does not try to be a complete `apply()`.
   */
  const seededRef = useRef(false)
  if (!seededRef.current) {
    seededRef.current = true
    const warm = warmRef.current.hit
    if (warm) {
      restRef.current = warm.rest ?? []
      imagesRef.current = warm.images ?? []
      loadRestRef.current = warm.loadRest ?? null
      loadImagesRef.current = warm.loadImages ?? null
    }
  }

  /**
   * The cached document this renderer's content came from, by identity.
   *
   * Held so that when phase 2 finishes, the cache entry can be replaced with the
   * whole book (`replacePrepared`) — but only if it is still this exact object.
   * Updated in `apply()` alongside the delivery refs.
   */
  const sourceRef = useRef<Prepared | undefined>(warmRef.current.hit)

  /**
   * Whether the viewer has rendered the payload most recently applied.
   *
   * `rendered` cannot answer this on its own. When a neighbour becomes active,
   * `apply()` re-seeds the delivery refs and pushes a fresh payload in the same
   * effect flush in which the drain effects below re-run — with `rendered`
   * still true from the old document. Draining then would inject batches the
   * incoming payload is about to replace, and the drain refs are cleared up
   * front, so the book would come back truncated. A ref is updated
   * synchronously by `apply()`, which runs first; state is not.
   */
  const viewerCurrentRef = useRef(false)

  /**
   * True while the viewer holds exactly the inlined island and nothing has been
   * drained into it or pushed over it.
   *
   * `apply()` uses it to avoid re-pushing the same cached document. It always
   * built a new payload object, so a warm mount rendered its island, began
   * draining batches into it, and then had the whole DOM replaced by the
   * identical re-push — losing the batches, since the drain refs are cleared
   * when draining starts. With finished EPUBs now cached with their `rest`
   * (`replacePrepared`), that would have truncated every reopened book.
   */
  const inlineUntouchedRef = useRef(inlinedPayload !== null)

  /*
   * Preparation lives in `webview/prepare`, so every format converges on one
   * code path and adding a format never touches this component.
   *
   * Gated on `active`, and that gate is load-bearing rather than an
   * optimization. Parsing an EPUB means unzipping it, assembling every chapter
   * and base64-encoding its images — hundreds of megabytes for a large book.
   * Doing that for a file the user is not looking at is what made the reader
   * hang when an EPUB was merely *near* the current file. `cancelled` does not
   * help: it discards the result after the work is already done.
   */
  useEffect(() => {
    if (!active) return

    let cancelled = false

    // Settings are read once, not tracked, so changing the font re-styles via a
    // `settings` message instead of re-parsing the file.
    const apply = (prepared: Awaited<ReturnType<typeof prepareFile>>) => {
      // Deferred batches ride a ref rather than state: they are consumed once by
      // the streaming effect below and never rendered, so putting them in state
      // would re-render the component for data nothing displays.
      restRef.current = prepared.rest ?? []
      imagesRef.current = prepared.images ?? []
      loadRestRef.current = prepared.loadRest ?? null
      loadImagesRef.current = prepared.loadImages ?? null
      sourceRef.current = prepared
      /*
       * Counts captured here, not read at report time.
       *
       * Both refs above are cleared the moment their drain effect starts, which
       * is well before `complete` arrives — so reading them in the reporter
       * would print zeroes for every document that actually streamed.
       */
      viewerTrace.current.batches = restRef.current.length
      viewerTrace.current.images = imagesRef.current.length
      viewerTrace.current.pushedAt = now()

      // The viewer already has this exact document as its island and nothing
      // has touched it: the refs above are all it needs. No re-push, so the
      // drains run against the DOM that will stay.
      if (inlineUntouchedRef.current && prepared === warmRef.current.hit) {
        setToc(file.id, prepared.toc ?? [])
        return
      }
      inlineUntouchedRef.current = false

      // A new payload is about to replace whatever the viewer shows; nothing
      // may be drained into it until the viewer says `ready` for this one.
      viewerCurrentRef.current = false
      /*
       * Clear any error the viewer reported before this content arrived.
       *
       * `setError` is otherwise a one-way latch: it short-circuits the whole
       * render and unmounts the WebView, so a document that prepared perfectly
       * well had nowhere to be delivered and the open was lost permanently.
       * That is what turned a boot-time viewer fault into "reopen the file and
       * it works" rather than a recoverable blip.
       *
       * This cannot loop. A genuinely unrenderable document re-posts `error`
       * from the viewer, but `payload` does not change again, so `apply` does
       * not run a second time and the error stands.
       */
      setError(null)
      setPayload({
        ...prepared,
        scroll: initialScroll,
        anchor: initialAnchor,
        settings: settingsRef.current,
        /*
         * A pending `loadRest` counts. An EPUB's first open carries its rest as
         * a thunk, not as batches, and reporting `streaming: false` for it made
         * the viewer treat a saved position past the first paint as
         * unreachable instead of parking it until the chapters arrive.
         */
        streaming: restRef.current.length > 0 || loadRestRef.current !== null,
      })
      setToc(file.id, prepared.toc ?? [])
    }

    /*
     * Synchronous cache hit, deliberately not awaited.
     *
     * Going through the async path even for a hit would yield to the event loop
     * and render one frame with `payload` still null — a spinner flash on every
     * swipe back to a book already in memory, which is the exact jank this
     * cache exists to remove.
     */
    const cached = readCached(file.id, file.storedName)
    if (cached) {
      apply(cached)
      return
    }

    void (async () => {
      try {
        /*
         * A disk entry too large to read during the first render
         * (`SYNC_READ_MAX_BYTES`) is still worth reading — it saves a full
         * re-parse — just not synchronously ([AUDIT4 E3](../../AUDIT4.md)).
         * The loading cover is up while it reads.
         */
        const fromDisk = await readPreparedAsync(file.id, new File(LIBRARY_DIR, file.storedName))
        if (fromDisk) {
          setPrepared(file.id, fromDisk)
          if (!cancelled) apply(fromDisk)
          return
        }

        const prepared = await prepareFile(file)
        /*
         * Cached *before* the cancellation check, on purpose.
         *
         * If the user swiped away mid-parse this renderer must not call
         * setState — but the parse itself already completed and cost the same
         * seconds either way. Throwing the result away would make swiping
         * away-and-back during a slow load the one case that never benefits
         * from the cache, which is precisely when the wait is most annoying.
         */
        setPrepared(file.id, prepared)
        /*
         * Persisted as well as held in memory.
         *
         * The memory cache is dropped wholesale when the app backgrounds, so
         * without this every cold open reparses — seconds of unzip and assembly
         * for a result that is a pure function of bytes that have not changed.
         * `writePrepared` declines documents carrying images on its own, so
         * this is a no-op for the formats where it would be wrong.
         */
        writePrepared(file.id, new File(LIBRARY_DIR, file.storedName), prepared)
        if (cancelled) return
        apply(prepared)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()

    return () => {
      cancelled = true
    }
    // Deliberately not depending on `settings`: a font change must not reload
    // the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, active, initialScroll, initialAnchor, setToc])

  useEffect(() => () => forget(file.id), [file.id, forget])

  // Search state is per-file too, and a stale match count outliving its
  // renderer would show the previous document's results.
  useEffect(() => () => useSearch.getState().forget(file.id), [file.id])

  /*
   * Deliver the rest of a progressively-loaded document.
   *
   * Starts only once the viewer reports `rendered`, so the first screens are on
   * screen and interactive before any of this runs — that is the entire point:
   * a long EPUB opens in a moment and grows behind the reader instead of
   * holding a spinner for the whole assembly.
   *
   * Batches go out one at a time, each deferred to the next macrotask. Posting
   * them in a loop would hand the WebView several megabytes in one turn and
   * block its main thread through every append, which would trade a spinner at
   * the start for a freeze in the middle — strictly worse, because by then the
   * reader is already reading.
   *
   * `cancelled` matters here: swiping away mid-stream unmounts this renderer,
   * and posting into a dead WebView throws.
   */
  useEffect(() => {
    /*
     * Only the active renderer drains ([AUDIT4 A5](../../AUDIT4.md)).
     *
     * A warm neighbour renders its island and reports `ready` like any other
     * renderer, and this used to assemble the rest of its book and stream every
     * image into it while nobody was looking — three books at once, the exact
     * failure mounting neighbours was claimed to be safe from. Its refs stay
     * seeded and drain when it becomes active.
     *
     * `viewerCurrentRef` keeps a drain from starting against a document that
     * `apply()` is about to replace — see its declaration.
     */
    if (!rendered || !active || !viewerCurrentRef.current) return
    if (!restRef.current.length && !loadRestRef.current) return

    // From here the viewer's DOM is more than the inlined island.
    inlineUntouchedRef.current = false

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    // The cache entry this content came from, to be finished once phase 2 is.
    const source = sourceRef.current

    const queue = restRef.current
    // Cleared up front so a re-render cannot start a second drain over the same
    // batches and append the book twice.
    restRef.current = []

    /*
     * Phase 2 runs **here**, not during preparation.
     *
     * `loadRest` decompresses and assembles the rest of the book. Calling it at
     * this point rather than inside `prepareFile` is the whole of R4-1: the
     * first paint is already on screen and interactive, so the reader is
     * looking at page one while the remainder is built behind them, instead of
     * waiting for the entire book before seeing anything
     * ([AUDIT2 §1.3](../../AUDIT2.md)).
     *
     * Taken from the ref and cleared before awaiting, so a re-render cannot
     * start a second assembly over the same archive.
     */
    const pending = loadRestRef.current
    loadRestRef.current = null

    /*
     * Each batch leaves `queue` once it has been handed to the viewer.
     *
     * Indexing instead kept every batch referenced by this effect's closure
     * until unmount — the whole book's text held a second time for the life of
     * the renderer, after the viewer already had it.
     */
    const pump = async () => {
      if (cancelled || !webRef.current) return
      const content = queue[0]
      const last = queue.length === 1

      /*
       * `injectJavaScript` with a base64 argument, not `postMessage`.
       *
       * `postMessage` on Android compiles to `evaluateJavascript` with the
       * payload wrapped in `JSONObject.toString()`, so a batch is JSON-escaped
       * once here and again natively, then handed to V8 as JavaScript *source*
       * ([AUDIT2 §2.1](../../AUDIT2.md)). `injectJavaScript` has no wrapper, and
       * base64's alphabet needs no escaping in a string literal — so the batch
       * arrives as one opaque token rather than several hundred kilobytes of
       * escaped markup for a parser to walk.
       *
       * Encoded on the worklet lane: the conversion is a byte loop over the
       * batch, and running it here would be the JS-thread stall the streaming
       * design exists to avoid.
       */
      try {
        /*
         * `strToU8`, not `TextEncoder`.
         *
         * React Native does not provide `TextEncoder` — it is not in RN's
         * polyfills and Hermes has no built-in — so it would have thrown at
         * runtime, been swallowed by the catch below, and silently truncated
         * every streamed book. fflate is already a dependency and already the
         * UTF-8 encoder used on the export path.
         */
        const b64 = await toBase64OffThread(strToU8(content))
        if (cancelled || !webRef.current) return
        // The trailing `true;` is required, not cosmetic: the injected source
        // is evaluated as an expression, and returning a large value from it
        // stalls the call on some Android versions.
        webRef.current.injectJavaScript(`window.__srAppend('${b64}',${last});true;`)
      } catch {
        // A batch that will not encode must not strand the rest of the book.
      }

      queue.shift()
      if (queue.length && !cancelled) timer = setTimeout(() => void pump(), 0)
    }

    /*
     * Assemble first if there is anything left to assemble, then pump.
     *
     * `loadRest` decompresses and assembles the remainder of the book, so this
     * is the seconds of work that used to happen before the reader saw
     * anything. It also returns the **exact** page count, which supersedes the
     * provisional one the first paint carried.
     */
    const start = async () => {
      if (pending) {
        try {
          const done = await pending()

          /*
           * Finish the cache entry, even if this renderer has since gone.
           *
           * The entry held a first paint and a thunk; it becomes the whole
           * book. A later mount then streams `rest` directly instead of
           * reaching back into the archive, the budget measures the text the
           * entry really holds, and a book with no images becomes
           * disk-cacheable ([AUDIT4 A4](../../AUDIT4.md)). `replacePrepared`
           * does nothing if the entry was evicted or re-parsed meanwhile.
           */
          if (source) {
            const finished: Prepared = {
              ...source,
              rest: [...(source.rest ?? []), ...done.rest],
              totalPages: done.totalPages > 0 ? done.totalPages : source.totalPages,
              loadRest: undefined,
              // Only the image thunk can still be holding the archive.
              retainedBytes: source.loadImages ? source.retainedBytes : undefined,
            }
            if (replacePrepared(file.id, source, finished)) {
              sourceRef.current = finished
              writePrepared(file.id, new File(LIBRARY_DIR, file.storedName), finished)
            }
          }

          if (cancelled) return
          queue.push(...done.rest)

          /*
           * Correct the page count.
           *
           * The first paint carried an estimate derived from the archive's
           * uncompressed byte sizes, because phase 2 had not counted the text
           * yet. A book that declares its own `page-list` was exact from the
           * first frame and gets the same number back here, so this is a no-op
           * for it rather than a visible correction.
           */
          if (webRef.current && done.totalPages > 0) {
            webRef.current.injectJavaScript(
              `window.__srPages(${done.totalPages});true;`,
            )
          }
        } catch {
          // The first paint is already on screen and readable. A failure here
          // costs the rest of the book, not the whole open.
        }
      }

      if (cancelled || !queue.length) return
      timer = setTimeout(() => void pump(), 0)
    }

    void start()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // `file` is fixed for the life of a renderer; listed for the cache writes.
  }, [rendered, active, file.id, file.storedName])

  /*
   * Deliver images after the document is on screen.
   *
   * Text first, pictures after: the reader can start on the opening page while
   * illustrations fill in behind them, which is the same trade the chapter
   * streaming above makes.
   *
   * Each image is encoded on the worklet runtime, one at a time, and posted on
   * its own macrotask. Two reasons for the drip rather than a batch:
   *
   *  - Encoding is the expensive half, and doing it lazily means a book whose
   *    reader closes it after two pages never pays for the images they did not
   *    reach.
   *  - Each `postMessage` is a string crossing the bridge. Posting sixty at
   *    once would queue tens of megabytes of strings simultaneously — the exact
   *    memory spike this whole change exists to remove.
   */
  useEffect(() => {
    // Active only, and only against the current payload: see the text drain.
    if (!rendered || !active || !viewerCurrentRef.current) return
    if (!imagesRef.current.length && !loadImagesRef.current) return

    inlineUntouchedRef.current = false

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const queue = imagesRef.current
    // Cleared up front so a re-render cannot start a second drain.
    imagesRef.current = []

    /*
     * The EPUB path decompresses its images **here**.
     *
     * Parsing registers them by path and size only, so nothing was decompressed
     * or copied across the worklet boundary during the open, and the prepared
     * cache is holding markup rather than tens of megabytes of JPEG. Taken and
     * cleared before awaiting, so a re-render cannot fetch them twice.
     */
    const fetchImages = loadImagesRef.current
    loadImagesRef.current = null

    /*
     * Each image leaves `queue` once posted, so its bytes can be collected.
     * Indexing kept every decoded image alive in this closure until unmount —
     * up to the whole image budget, held after the viewer had its own copy.
     */
    const pump = async () => {
      if (cancelled || !webRef.current) return

      const image = queue[0]

      try {
        const data = await toBase64OffThread(image.bytes)
        if (cancelled || !webRef.current) return
        webRef.current.postMessage(
          JSON.stringify({ type: 'image', token: image.token, mime: image.mime, data }),
        )
      } catch {
        // A single image that will not encode is not worth failing the book
        // for; its element simply stays empty.
      }

      queue.shift()
      if (queue.length && !cancelled) timer = setTimeout(() => void pump(), 0)
    }

    const start = async () => {
      if (fetchImages) {
        try {
          const fetched = await fetchImages()
          if (cancelled) return
          queue.push(...fetched)
        } catch {
          // Illustrations are not what a reader is here for. A failure leaves
          // the elements empty, which is what a failed decode already does.
        }
      }
      if (cancelled || !queue.length) return
      timer = setTimeout(() => void pump(), 0)
    }

    void start()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [rendered, active])

  // Typography changes are pushed as a style-only update.
  useEffect(() => {
    if (!rendered || !webRef.current) return
    webRef.current.postMessage(JSON.stringify({ type: 'settings', settings }))
  }, [rendered, settings])

  // Chapter selection from the TOC sheet.
  useEffect(() => {
    if (!rendered || !hrefJump || !webRef.current) return
    webRef.current.postMessage(JSON.stringify({ type: 'seekHref', href: hrefJump.href }))
  }, [rendered, hrefJump])

  // Push content in once both the page and the payload are ready.
  const pushContent = useCallback(() => {
    if (!payload || !webRef.current) return
    webRef.current.postMessage(JSON.stringify(payload))
  }, [payload])

  useEffect(() => {
    if (!booted || !payload) return
    /*
     * Already in the document — do not push it again.
     *
     * A warm mount embeds the first paint as a JSON island, so the viewer has
     * rendered it before `boot` even reaches us. Pushing the identical payload
     * would re-render the whole document a second time, which is slower than
     * the message path this replaces rather than faster.
     *
     * Compared by identity against the exact object that was inlined, so a
     * *later* payload — a re-parse, a restored file — still pushes normally.
     */
    if (payload === inlinedPayload) return
    // A new payload means the viewer is about to replace its document, so the
    // rendered flag drops until the viewer says `ready` again — otherwise a
    // seek could be posted against the outgoing document. Gated on `payload`
    // too, so this does not churn state before there is anything to push.
    setRendered(false)
    pushContent()
  }, [booted, payload, pushContent])

  /*
   * Run a search, or clear one.
   *
   * Gated on `rendered` for the same reason a seek is: a query posted before
   * the document is in the DOM has nothing to walk, and would silently return
   * no matches for a book that contains them.
   *
   * An empty query is not skipped — it is how the search bar closes, and the
   * viewer reads it as "drop the highlights".
   */
  useEffect(() => {
    if (!rendered || !searchRequest || !webRef.current) return
    webRef.current.postMessage(
      JSON.stringify({ type: 'search', query: searchRequest.query }),
    )
  }, [rendered, searchRequest])

  // Next/previous match. Nonce'd, so pressing next twice on a single-match
  // document delivers twice rather than being deduplicated into one.
  useEffect(() => {
    if (!rendered || !searchStep || !webRef.current) return
    webRef.current.postMessage(
      JSON.stringify({ type: searchStep.delta > 0 ? 'searchNext' : 'searchPrev' }),
    )
  }, [rendered, searchStep])

  // Serve seek requests from the scrollbar. Nonce'd in the store, so dragging
  // to the same page twice still delivers.
  useEffect(() => {
    if (!rendered || !jump || !webRef.current) return
    webRef.current.postMessage(JSON.stringify({ type: 'seek', page: jump.page }))
  }, [rendered, jump])

  /**
   * Emits the `[perf] viewer` line once per document.
   *
   * Guarded on `pushedAt`, which `apply()` sets and this clears: a streamed
   * document reaches both `ready` and `complete`, and without the guard a book
   * would report twice with the second line describing nothing new.
   */
  const reportViewer = useCallback(() => {
    const t = viewerTrace.current
    if (!t.pushedAt) return
    const complete = now() - t.pushedAt
    t.pushedAt = 0
    perf(
      `viewer    ${file.format} boot ${t.boot}ms → ready ${t.ready}ms → complete ${complete}ms` +
        ` (${t.batches} batches, ${t.images} images)`,
    )
  }, [file.format])

  /*
   * The WebView's renderer process died ([AUDIT4 A9](../../AUDIT4.md)).
   *
   * Android kills it first under memory pressure, and it can crash on its own.
   * `react-native-webview` stops that from killing the app, but the WebView
   * object is dead from then on — Android's contract is that it must be
   * replaced — and nothing here noticed: the pumps kept calling
   * `injectJavaScript`/`postMessage` on it and the page stayed blank.
   *
   * So: stop everything that talks to it, re-seed delivery from the cached
   * document, and mount a fresh WebView. It boots the same HTML (island
   * included), the boot handshake pushes the payload if there was no island,
   * and the drains re-run on `ready`. A second death shows the error view.
   */
  const [webKey, setWebKey] = useState(0)
  const rendererDeaths = useRef(0)

  const handleRenderProcessGone = useCallback(() => {
    rendererDeaths.current += 1

    viewerCurrentRef.current = false
    setBooted(false)
    setRendered(false)

    if (rendererDeaths.current > MAX_RENDERER_RESTARTS) {
      setError('The page renderer stopped working while showing this file.')
      return
    }

    const source = sourceRef.current
    if (source) {
      restRef.current = source.rest ?? []
      imagesRef.current = source.images ?? []
      loadRestRef.current = source.loadRest ?? null
      loadImagesRef.current = source.loadImages ?? null
    }
    // The fresh view starts from the same HTML, island and all.
    inlineUntouchedRef.current = inlinedPayload !== null
    setWebKey((k) => k + 1)
  }, [inlinedPayload])

  const handleMessage = useCallback(
    (e: WebViewMessageEvent) => {
      /*
       * Normalised before anything reads it ([AUDIT4 D5](../../AUDIT4.md)):
       * numbers finite and in range, strings capped, oversized messages
       * dropped. The checks below can then stay simple presence tests.
       */
      const msg = parseViewerMessage(e.nativeEvent.data)
      if (!msg) return

      if (msg.type === 'boot') {
        // The script is alive and listening; content can be pushed in.
        viewerTrace.current.boot = now() - viewerTrace.current.pushedAt
        setBooted(true)
      } else if (msg.type === 'ready') {
        // Content is in the DOM and measured. Only now can a seek or a style
        // update land on something.
        viewerTrace.current.ready = now() - viewerTrace.current.pushedAt
        // Set before the state update, so the drain effects it triggers see it.
        viewerCurrentRef.current = true
        setRendered(true)
        // Reported here as well as on `complete`, because a document with
        // nothing deferred never sends `complete` at all — and those are most
        // documents. Without this the line would only ever appear for EPUBs.
        if (!viewerTrace.current.batches) reportViewer()
      } else if (msg.type === 'complete') {
        // Every deferred batch has landed. Nothing else to do — the viewer
        // reports its own position as it appends — but it is the end of the
        // streamed document and therefore where its timing line belongs.
        reportViewer()
      } else if (msg.type === 'perf') {
        // A long `measure()` inside the viewer. Forwarded rather than handled:
        // the viewer has no console anyone reads, so the only way this reaches
        // Metro is through the bridge.
        perf(`longtask  measure() ${msg.ms ?? 0}ms over ${msg.anchors ?? 0} anchors`)
      } else if (msg.type === 'scale') {
        // Pinch zoom. The pager watches this to stop a pan on a zoomed page
        // from flipping to the next file.
        if (typeof msg.scale === 'number') onScaleChange?.(msg.scale)
      } else if (msg.type === 'pos') {
        /*
         * Persisted only for the file the user is actually reading.
         *
         * A neighbour is mounted now (R5), and a neighbour with a warm cache
         * renders its document and reports a position like any other — so
         * without this guard, merely being *next to* the current file would
         * write that file's scroll offset and progress to MMKV. The restore is
         * not pixel-exact, so the value written back is not always the value
         * read, and a book nobody opened would drift a little further from
         * where its reader left it on every swipe past it.
         *
         * `report` is deliberately outside the guard: it is memory-only, keyed
         * per file id, and having a neighbour's page count ready is part of why
         * it is mounted at all.
         */
        if (activeRef.current) {
          if (typeof msg.scrollY === 'number') setScroll(file.id, msg.scrollY)
          if (typeof msg.percent === 'number') setProgress(file.id, msg.percent)
        }
        if (typeof msg.current === 'number' && typeof msg.total === 'number') {
          report(file.id, msg.current, msg.total, {
            label: msg.label,
            percent: msg.percent,
          })
        }
      } else if (msg.type === 'anchor') {
        // Debounced on the viewer side, so this arrives after a scroll settles
        // rather than per frame. Gated for the same reason as the offset above:
        // a neighbour must not rewrite a reading position nobody moved.
        if (activeRef.current && typeof msg.offset === 'number') setAnchor(file.id, msg.offset)
      } else if (msg.type === 'search') {
        // Reported through `getState()` rather than a bound action, so
        // publishing a result cannot re-render this renderer.
        useSearch.getState().report(file.id, {
          query: msg.query ?? '',
          total: msg.total ?? 0,
          current: msg.current ?? 0,
          truncated: msg.truncated,
        })
      } else if (msg.type === 'warn') {
        // A partial failure — one image, one batch. The document is still on
        // screen and readable, so this is logged, never shown (AUDIT4 B4).
        if (__DEV__) console.warn(`[viewer] ${String(msg.message ?? '').slice(0, 300)}`)
      } else if (msg.type === 'link') {
        // An external link in the document. Only the file on screen may ask.
        if (activeRef.current && typeof msg.href === 'string') offerExternalLink(msg.href)
      } else if (msg.type === 'error') {
        setError(msg.message ?? 'Could not display this file')
      }
    },
    [file.id, report, onScaleChange, reportViewer],
  )

  if (error) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <Text style={[styles.errTitle, { color: theme.fg }]}>Couldn’t open this file</Text>
        <Text style={[styles.errBody, { color: theme.fgDim }]}>{error}</Text>
      </View>
    )
  }

  return (
    <Animated.View style={[styles.fill, { backgroundColor: theme.bg }, insetStyle]}>
      <WebView
        key={webKey}
        ref={webRef}
        source={{ html }}
        originWhitelist={['about:blank']}
        onMessage={handleMessage}
        onRenderProcessGone={handleRenderProcessGone}
        // iOS equivalent: WKWebView's content process terminated.
        onContentProcessDidTerminate={handleRenderProcessGone}
        // The viewer is self-contained: no navigation, no network, no file access.
        // This is the analogue of the desktop app's `will-navigate` guard.
        onShouldStartLoadWithRequest={allowOnlyBundledContent}
        setSupportMultipleWindows={false}
        javaScriptEnabled
        domStorageEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        // Only the active file is mounted (see HorizontalPager), so this is
        // really about the brief overlap while a swipe hands over.
        androidLayerType={active ? 'hardware' : 'none'}
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        // Memoised rather than inline: a new style object on every render is a
        // prop update pushed to a native view that is rendering a document.
        style={webViewStyle}
        containerStyle={styles.fill}
      />

      {/*
        Held until the viewer reports `ready`, not merely until `payload` is
        set. Between those two the document has been posted but is not yet in
        the DOM and measured, so uncovering at `payload` shows a blank white
        page — the one frame this whole component exists to avoid.
      */}
      {!rendered && active && <LoadingCover theme={theme} thumbhash={file.thumbhash} />}
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, width: '100%' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 8 },
  errTitle: { fontSize: 16, fontWeight: '600' },
  errBody: { fontSize: 13, textAlign: 'center' },
})
