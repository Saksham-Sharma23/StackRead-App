# AUDIT4 — Crashes, defects and vulnerabilities, with a fix plan

Eighth audit. It was prompted by a field report: **the app crashes after opening
a file (e.g. an EPUB) and going back to the home screen.** The brief was wider
than that one report: read the whole project, explain the architecture, and find
every crash, bug and vulnerability the code allows, with the reason for each.

Read after [AUDIT3.md](AUDIT3.md) and [stackreadrelease/bugs/Fix.md](stackreadrelease/bugs/Fix.md).
Where an earlier finding is still open it is listed again with its original
reference instead of being re-argued.

**Method.** Every module under `src/`, `App.tsx`, the local Expo module
`modules/pdf-text`, the Gradle/R8 scripts, and the parts of
`react-native-webview`, `react-native-pdf` and `react-native-worklets` the app
relies on were read and traced by hand. Each finding has a location, a mechanism
and a concrete failure scenario.

**What was verified and what was not.**

- `npm run check`: typecheck clean, **377 tests pass** (2026-10-08).
- **There was no device available.** The crash could not be reproduced and its
  stack could not be read, so §2 *ranks* the candidate causes by evidence. Step
  0.1 of the plan is a five-minute logcat capture that tells you which one it is.
  Do that before anything else.
- Items marked **(verify)** depend on runtime behaviour that cannot be confirmed
  from source alone.

### Status

| Finding | State | Notes |
|---|---|---|
| **A1** | **Fixed** | `MAX_PREPARE_BYTES.epub = 100 MB`, enforced by `prepareFile` and by `extractCover` |
| **A2** | **Fixed** | Archive parked on the worker once; every later pass sends names only. See "A2 — what was done" below |
| B2 | Fixed as a side effect | `loadRest`/`loadImages` are memoised, which A2's release accounting needs |

`npm run check`: typecheck clean, **396 tests pass** (377 + 12 in
`zipWorklet.test.ts` + 7 in `archiveOffload.test.ts`). Not yet verified on a
device.

---

## 1. The architecture in one page

StackRead is a document reader organised as a **2-D board**. Rows are groups,
which are logical tags rather than folders. Cards are files. Opening a card shows
the file full-screen: you scroll vertically to read and swipe horizontally to move
to the next file in the same group. Files are copied into
`files/library/<nanoid>.<ext>`. The index lives in SQLite (WAL + FTS5). Hot
per-file state (scroll position, progress, zoom, anchor) lives in MMKV.

```
App.tsx ── Root
  ├─ useAppLifecycle            background → commit removals, flush index, drop caches
  ├─ LibraryScreen   (mounted only while no file is open)
  │    ├─ FlatList of GroupRow → DraggableCard → FileCard
  │    │      FileCard: useThumbnail (EPUB/CBZ cover extraction), useSnippet (text preview)
  │    └─ PdfCoverFactory       off-screen react-native-pdf, captures page 1 with view-shot
  └─ ReaderTransition → Suspense → lazy(ReaderScreen)   (mounted only while a file is open)
       └─ HorizontalPager       mounts index ±1 (neighbours only for WebView formats)
            └─ FileRenderer
                 ├─ PdfRenderer      react-native-pdf (pdfium) + usePdfSearch (modules/pdf-text, pdfium)
                 ├─ ImageRenderer    expo-image + pinch/pan
                 └─ WebViewRenderer  one inert WebView for 9 formats
                        prepareFile() ─ memory cache ─ disk cache
                          └─ worklet runtimes ('user', 'prefetch') do unzip/base64
                        viewer = 1,700-line template literal (viewerHtml.ts)
                          ├─ first paint: JSON island or postMessage
                          ├─ later chapters: injectJavaScript(__srAppend(base64))
                          └─ images: postMessage → blob: URLs
```

**The switch between the two screens is total.** `App.tsx` renders
*either* the board *or* the reader, never both. Opening a file unmounts the
whole board, including `PdfCoverFactory`. Going back unmounts the whole reader
and remounts the board from scratch. Several findings below come from this.

**Where memory goes when an EPUB is open:**

| Holder | What | Bounded by |
|---|---|---|
| JS heap | the whole `.epub` file as a `Uint8Array` | **nothing** (EPUB has no size limit) |
| closures `loadRest` / `loadImages` | the same `Uint8Array`, kept alive by the cached `Prepared` | **nothing**; the cache does not count it |
| worklet boundary | a full copy of the archive for each of 6 calls | transient, but proportional to the book |
| `prepareCache` | first-paint HTML + rest batches | 24 MB *of what it counts* |
| WebView renderer process | DOM, decoded blob images | the OS |
| board after return | expo-image thumbnails, cover extraction, snippets | 2 concurrent extractions, **unbounded** sizes |

---

## 2. The reported crash: open an EPUB, go back home

### What happens at that moment

1. Back is pressed. `ReaderTransition` runs a 300 ms close, then `setReading(null)`.
2. The reader unmounts. Async work started by the WebView renderer **keeps
   running**: `loadRest()` (decompresses and assembles the rest of the book) and
   `loadImages()` (decompresses every registered image). Both run on the `user`
   worklet runtime and each copies the whole archive across the boundary.
   `cancelled` flags only discard the results once they arrive.
3. The board remounts from scratch. Every visible card runs `useThumbnail`, which
   for an EPUB or comic with no cover yet **unzips the entire archive**
   (`covers.ts:206`), two files at a time, on the same `user` runtime. Text-like
   cards run `useSnippet`, which **reads the whole file** as a string
   (`useSnippet.ts:96`).
4. Once interactions settle, `PdfCoverFactory` mounts a hidden pdfium document
   for the next PDF without a cover.
5. The EPUB's `Prepared` object stays in the memory cache, and through its
   closures it keeps the whole book's bytes alive.

So the return to the board is the point of peak memory: the reader's leftover
work, the board's thumbnail work and a native PDF parse all start in the same
second.

### Candidate causes, ranked

| # | Cause | Evidence | Logcat signature |
|---|---|---|---|
| **1** | **Memory exhaustion**: the process is killed by the low-memory killer or Hermes aborts on OOM | §3 A1–A7: no EPUB size cap, ~6 full-archive copies per open, every image decompressed twice, book bytes held by cached closures and not counted, neighbours stream whole books, the board fully unzips every uncovered EPUB/CBZ | `lowmemorykiller` / `am_kill` / `Process … has died` with **no Java stack**; or `Abort message: … OutOfMemory` in `libhermes.so` |
| **2** | **pdfium torn down mid-render** by `PdfCoverFactory` | §3 A8: the board, and the factory with it, unmounts the instant a card is tapped and remounts on return. The code's own comments record this exact crash class | `Fatal signal 11 (SIGSEGV)` with frames in `libmodpdfium.so` / `libpdfium*.so` |
| **3** | **Uncaught JS error** with no error boundary anywhere | §3 A10: `App.tsx` has none, so any render or effect error kills the app in release | `ReactNativeJS` error, then `FATAL EXCEPTION` with `JavascriptException` |
| **4** | **Layout-animation teardown** on Android (verify) | `LoadingCover` has `exiting={FadeOut}` inside the reader subtree being removed. Board rows use `exiting` + `layout` under a `FlatList` with `removeClippedSubviews` | Java `IllegalStateException` / `IndexOutOfBoundsException` in `ReactViewGroup` or Reanimated `LayoutAnimations` |
| **5** | **WebView renderer process died** and the dead view kept being used | §3 A9: no `onRenderProcessGone`. Pumps keep calling `injectJavaScript`/`postMessage` on it | `The WebView rendering process crashed` / `…was killed by the system` just before the crash |

Cause 1 is the most likely for the EPUB → home pattern. Cause 2 is the most
likely if the library contains PDFs that still show a badge instead of a cover.
**The fixes for all five are in the plan regardless**, because each one is a real
defect. The logcat step only decides which to do first.

### A related symptom that can look like a hang

Reopening any WebView document you have already scrolled through can leave the
**loading cover on screen forever** (§3 B1). The viewer never says `ready` when it
restores to a saved anchor. If "crash" sometimes means "it froze on the cover",
this is the reason.

---

## 3. Findings

Severity: **Critical** = crash or data loss on a common path · **High** = crash or
data loss on a plausible path, or a security boundary broken · **Medium** = wrong
behaviour users will meet · **Low** = hardening.

### Summary

| ID | Severity | Area | Finding |
|---|---|---|---|
| A1 | Critical | memory | EPUB has no size ceiling; the whole file is read into JS |
| A2 | Critical | memory | Each EPUB open copies the full archive across the worklet boundary ~6 times |
| A3 | High | memory | Phase 1 decompresses **every** image in the book, unbudgeted, then `loadImages` does it again |
| A4 | High | memory | Cached `Prepared` keeps the whole book alive through closures; `prepareCache` doesn't count it |
| A5 | High | memory | Inactive neighbour WebViews run `loadRest` + image streaming (three books at once) |
| A6 | High | memory | Board cover extraction fully unzips every uncovered EPUB/CBZ, on the user lane |
| A7 | High | memory | `useSnippet` reads entire text files for a 200-character preview; imports are not size-limited |
| A8 | High | native | `PdfCoverFactory` is unmounted mid-render whenever a file is opened |
| A9 | High | native | No `onRenderProcessGone` handling; a dead WebView keeps receiving calls |
| A10 | High | JS | No error boundary or global handler; any thrown render error is fatal |
| A11 | Medium | memory | CBZ/ZIP are fully decompressed before any budget applies (zip bomb) |
| A12 | Medium | native | Failing covers are retried on every board mount; a crashing PDF/EPUB is retried every launch |
| B1 | **High** | viewer | Anchor restore returns before posting `ready` → loading cover never lifts, rest of book never streams |
| B2 | **High** | EPUB | `loadRest` is not idempotent: every reopen appends the rest of the book **again** and doubles the page count |
| B3 | Medium | EPUB | Images referenced only from chapter 4 onward are never delivered |
| B4 | Medium | viewer | A single bad image or batch posts `error`, which replaces a readable book with an error screen |
| B5 | Medium | pager | Zoom lock (`isZoomed`) is never reset when the file changes, so swiping stays disabled |
| B6 | Medium | viewer | In-book links and footnotes don't work; external links silently launch other apps |
| B7 | Medium | storage | `INSERT OR REPLACE` bypasses the FTS delete/update triggers, so the search index drifts |
| B8 | Low | formats | `x.constructor`, `x.__proto__`, `x.toString` pass `isKnownExtension` |
| C1 | **High** | data | A failed index save is silent and sticky; the next launch's prune then deletes the unsaved files |
| C2 | Medium | data | Removal deletes bytes before the index write lands |
| C3 | Medium | data | Restore overwrites live library files before commit, so it is not actually additive |
| C4 | Medium | data | Export reads whole files into memory and ignores stream backpressure (OOM on big libraries); it also skips pending unsaved changes |
| D1 | **High** | security | Streamed EPUB chapters skip the DOM sanitiser, and the regex sanitiser is bypassable (`<svg/onload=…>`) |
| D2 | **High** | security | Restored `library.json` is unvalidated; `storedName` becomes a path (AUDIT3 §2.1, still open) |
| D3 | Medium | security | No CSP in the viewer: documents can make network requests (tracking pixels, `fetch`) |
| D4 | Medium | security | Restore has no per-entry or total size cap (memory and disk exhaustion) |
| D5 | Low | security | Viewer messages unchecked for finiteness and length (AUDIT3 §2.3) |
| D6 | Low | security | Filenames in logs (AUDIT3 §2.4) |
| D7 | Low | security | `copyIntoLibrary` trusts its caller for the extension (AUDIT3 §2.2) |
| E1 | Medium | release | R8 keep rules miss `io.legere.pdfiumandroid` and Gson-serialised models (verify) |
| E2 | Medium | perf | `fast-xml-parser` still in the startup bundle (AUDIT3 §3.1) |
| E3 | Low | perf | Disk-cache read (`textSync` + `JSON.parse`) runs synchronously inside render |
| E4 | Low | UX | Opening the file picker or share sheet backgrounds the app → pending removals commit, undo lost |
| E5 | Low | dev | `ReaderTransition` mutates a ref already captured by a worklet (dev warning, frozen value) |

---

### A. Crashes and memory

#### A1 — EPUB has no size ceiling · Critical
[formats.ts:108-131](src/storage/formats.ts#L108-L131). `MAX_PREPARE_BYTES` deliberately
omits `epub`, on the grounds that the EPUB path "streams chapter by chapter and
budgets its own images". It does neither for the raw archive.
[epub.ts:201](src/renderers/webview/epub.ts#L201) reads the whole file with
`File.bytes()`. A 150 MB textbook EPUB goes straight into the JS heap, and
everything in A2–A4 multiplies it.

**Fix.** Add an `epub` ceiling. Start at 100 MB and raise it only after
measuring on a release build. Also apply it to cover extraction (A6).

#### A2 — The archive crosses the worklet boundary ~6 times per open · Critical
[epub.ts:225](src/renderers/webview/epub.ts#L225),
[231](src/renderers/webview/epub.ts#L231), [252](src/renderers/webview/epub.ts#L252),
[328](src/renderers/webview/epub.ts#L328), [543](src/renderers/webview/epub.ts#L543),
[604](src/renderers/webview/epub.ts#L604). `listEntriesOffThread`, then three
`unzipSomeOffThread` calls during the open, then one each in `loadRest` and
`loadImages`. **Every call passes the full `bytes`.** `runOnRuntimeAsync`
serialises arguments through `createSerializableArrayBufferView`, which copies the
*entire backing buffer* (`node_modules/react-native-worklets/src/memory/serializable.native.ts:598-616`).
AUDIT2 §1.2 measured two copies per crossing. In `__DEV__`, `createSerializable(args)`
runs once more as a check (`runtimes.native.ts:443-446`).

So a 50 MB book creates on the order of 600 MB of transient native allocations
within a few seconds, and two of those crossings happen *after* the first paint,
while the user may already be leaving.

**Fix (recommended).** Keep the archive **resident on the worker runtime**. The
first call transfers the bytes once and stores them in the runtime's own
`globalThis` map, keyed by file id. Later calls send only entry names. Evict the
entry when the renderer unmounts and when the cache forgets the id; wire that
eviction into [lifecycle.ts](src/storage/lifecycle.ts) like every other id-keyed
cache (CLAUDE.md §7). A cheaper partial fix is to merge the three open-time
calls into one worklet call that lists the archive, reads `container.xml`, then
finds and decompresses the OPF. Container/OPF discovery can use a regex inside
the worklet, as `covers.ts` already does.

**A2 — what was done, and a worse problem found on the way.** While fixing
this it turned out the offload **never ran off the JS thread for unzips**.
babel-preset-expo adds the worklets plugin without bundle mode, so a worklet
can only call other worklets. fflate's `unzipSync` is a plain import: it is
serialised as a remote function, and calling it on the worker throws "Tried to
synchronously call a Remote Function". Every "off-thread" unzip therefore
copied the archive across, threw, and redid the unzip on the JS thread in the
`catch`. The base64 worklet was unaffected, because it calls no imports.

The fix:

- [zipWorklet.ts](src/renderers/webview/zipWorklet.ts) is a self-contained ZIP
  reader and inflater written as `'worklet'` functions with no imports. It
  handles stored and deflate entries, and throws on ZIP64, encryption or
  corruption, which sends that archive to fflate on the JS thread.
  [zipWorklet.test.ts](src/__tests__/zipWorklet.test.ts) pins it byte for byte
  against fflate.
- `parkArchive` / `readParked` / `releaseParked` keep archives on the worker
  runtime's own `globalThis`, at most two per runtime, least recently used
  evicted first.
- [offload.ts](src/renderers/webview/offload.ts) `openArchive()` returns a
  handle. It crosses with the bytes once, then sends only names. If the archive
  was evicted, it re-parks it from disk. It falls back to fflate on the JS
  thread when no runtime exists or the archive can't be parked.
  `unzipOffThread`, used by comics, ZIP archives and covers, now really runs on
  the worker too.
- [epub.ts](src/renderers/webview/epub.ts) holds the handle, not the bytes, so
  a cached book no longer keeps its file alive on the JS side (part of A4).
  `loadRest` and `loadImages` are memoised and release the archive once both
  have finished. A failed parse releases it too.
- `releaseAllArchives()` runs on background (`useAppLifecycle`) and on restore
  (`resetAllCaches`).

**Verify on device:** `[perf] prepare` for an EPUB should now show a small
`unzip` figure reported from the worker, and one `cross` that is roughly the
file size. Open a large EPUB, background the app, come back and scroll to the
end: chapters must still arrive, because they are re-parked from disk.

#### A3 — Phase 1 decompresses every image in the book · High
[epub.ts:311-325](src/renderers/webview/epub.ts#L311-L325) adds every
`image/*` manifest item to `wanted`. The comment says this is needed because
`registerImage` "resolves an `<img>` against the decompressed slice". It does
not: `registerImage` ([epub.ts:419-433](src/renderers/webview/epub.ts#L419-L433))
uses only `sizeOf`, which comes from the central directory. So every illustration
is decompressed and copied back across the boundary for nothing, with no
budget. Then `loadImages` decompresses the budgeted subset a second time.

**Fix.** Remove the image clause from `wanted`. The test this comment cites pins
the wrong property: rewrite it to assert that images in first-paint chapters are
*registered* (they have tokens in `images`), not that they were decompressed.

#### A4 — Cached documents keep the whole book alive · High
[prepareCache.ts:154](src/renderers/webview/prepareCache.ts#L154) `sizeOf` counts
`content`, `rest` and eager `images`. An EPUB `Prepared` also carries `loadRest`
and `loadImages`. Those closures capture `bytes` (the whole archive), the
`chapters` array and the `images` map, and none of it is counted. The tail allows
6 entries under a 24 MB budget that sees only the first-paint HTML. In practice it
can hold six whole EPUBs plus three pinned ones. `cancelPrefetch()` only
*demotes* pinned entries, so leaving the reader frees nothing.

**Fix.** Two parts:
1. When `loadRest` completes, replace the cache entry with a **finished**
   `Prepared`: `rest` filled in, `loadRest` removed. Release `bytes` once images
   are fetched too. This also makes text-only EPUBs disk-cacheable.
2. Until then, charge the raw archive size to the entry. Add `retainedBytes` to
   `Prepared` and count it in `sizeOf`.

#### A5 — Inactive neighbours stream whole books · High
[WebViewRenderer.tsx:522-524](src/renderers/WebViewRenderer.tsx#L522-L524) and
[659-661](src/renderers/WebViewRenderer.tsx#L659-L661) gate streaming on
`rendered`, not on `active`. R5 mounts WebView neighbours, and a neighbour with a
warm cache renders its island, posts `ready`, and then runs `loadRest()` and the
whole image pipeline while nobody is looking at it. This brings back the "three
EPUBs at once" failure that [HorizontalPager.tsx:341-353](src/components/HorizontalPager.tsx#L341-L353)
says R5 had made safe. It also triggers B2.

**Fix.** Gate both drain effects on `active && rendered`. Keep the deferred refs
in place so they drain when the neighbour becomes active.

#### A6 — Board cover extraction fully unzips archives · High
[covers.ts:206](src/storage/covers.ts#L206): `unzipOffThread(await file.bytes())`,
with no filter and no size limit, on the **`user`** lane (the default). It runs
for every EPUB and CBZ card without a cover, two at a time
([thumbs.ts:19](src/storage/thumbs.ts#L19)). It is the same head-of-line
blocking the two-lane design was meant to remove, and it is a full
decompression of every book on the board. It also uses `TextDecoder`
([covers.ts:93,97,148](src/storage/covers.ts#L93)). WebViewRenderer's own notes
say Hermes lacks `TextEncoder`. If `TextDecoder` is missing too **(verify:
`typeof TextDecoder` on device)**, every EPUB cover attempt throws after the full
unzip, is never recorded as failed, and repeats on every launch.

**Fix.** List entries, decompress only `container.xml` and the OPF, then the
single cover entry (size-checked against the central directory). Use the
`prefetch` lane. Replace `TextDecoder` with fflate's `strFromU8`, which
`epub.ts` already uses.

#### A7 — Snippets read whole files · High
[useSnippet.ts:96](src/components/useSnippet.ts#L96): `(await source.text()).slice(0, N)`.
Text, Markdown, CSV and HTML imports have no size limit (`MAX_PREPARE_BYTES` is
checked only when a file is *opened*). One 400 MB log file on the board means a
400 MB string allocation every time the board mounts and the snippet isn't
cached. Because the cache is per process, that is every launch, which makes it a
crash loop.

**Fix.** Read only the first `SNIPPET_READ_BYTES` bytes through a file handle.
Check the SDK 57 `expo-file-system` docs for the exact handle API, per
AGENTS.md. Skip snippets for files over a few MB if no ranged read is available.

#### A8 — `PdfCoverFactory` is unmounted mid-render · High
[LibraryScreen.tsx:855](src/screens/LibraryScreen.tsx#L855) mounts the factory
*inside* the board. [App.tsx](App.tsx) unmounts the board the instant a card is
tapped. The factory's `enabled` flag and its "abandon if the reader opens" effect
([PdfCoverFactory.tsx:190-196](src/components/PdfCoverFactory.tsx#L190-L196)) never
get to run: the whole component disappears with a live pdfium document
mid-`FPDF_LoadPage`. That is the crash class recorded in DETAIL.md §8 and in the
factory's own header. On return, the factory starts again within about a second,
so a quick "back, open another file" repeats it.

**Fix.** Make pdfium ownership explicit:
- A tiny module-level **pdfium lease** (`acquire` / `release` / `isBusy`).
  The factory and `PdfRenderer` both take it.
- Hoist `PdfCoverFactory` to `Root` so it is never unmounted by navigation.
  Drive it with `enabled={!reading}`. When it is disabled mid-capture it
  **drains** (waits for `onLoadComplete`/`onError`, skips the capture, then
  unmounts) instead of aborting.
- `PdfRenderer` waits for the lease before mounting `<Pdf>`. The wait is at most
  one parse, and it hides behind the open transition.
- Apply the same rule on close: if the document has not reported
  `onLoadComplete`, keep it mounted (hidden) until it does, or until a 2 s
  timeout, before releasing. **(verify)** with a "back immediately after open"
  stress test on a large PDF.

#### A9 — No renderer-process-gone handling · High
`react-native-webview` returns `true` from `onRenderProcessGone`, so the app is
not killed outright (`RNCWebViewClient.java:279-307`). Android's contract is that
the WebView is then unusable and must be destroyed. `WebViewRenderer` registers
no handler, keeps the dead view mounted, and its pumps keep calling
`injectJavaScript`/`postMessage`. The renderer process is shared by all three
mounted WebViews, and the OS kills it first under memory pressure (A1–A7).

**Fix.** Handle `onRenderProcessGone`: stop the pumps, bump a `key` to remount a
fresh WebView from the cached payload, and show the error view on a second
failure. Add `onContentProcessDidTerminate` for iOS parity.

#### A10 — No error boundary · High
Nothing in [App.tsx](App.tsx) catches render errors. In a release build an error
thrown during render or an effect unmounts the root and exits the app. The reader
is the riskiest subtree: it holds three renderer families, a lazy chunk and
native views.

**Fix.**
- A root `ErrorBoundary` that renders a "Something went wrong — restart"
  screen.
- A reader-level boundary inside `ReaderTransition`. It closes the reader, logs
  the error, and shows a toast on the board, so a bad file costs the open rather
  than the app.
- `ErrorUtils.setGlobalHandler` to log fatal errors before the default handler
  runs. This is also the hook R7-1 crash reporting needs.

#### A11 — CBZ/ZIP zip bomb · Medium
[prepare.ts:363](src/renderers/webview/prepare.ts#L363) and
[423](src/renderers/webview/prepare.ts#L423) decompress the **whole** archive and
only then apply the per-image and total budgets. A 40 MB archive within
`MAX_PREPARE_BYTES` can expand to gigabytes. fflate allocates from the declared
size.

**Fix.** `listEntriesOffThread` first. Choose the entries that fit the budget
from `originalSize`, then `unzipSomeOffThread` only those. Reject archives whose
declared total exceeds a cap. Comic pages are only ever images ≤ 2 MB within a
24 MB total, so the wanted set is small.

#### A12 — Failures are retried forever · Medium
- `PdfCoverFactory`'s `tried` and `made` are `useRef`s
  ([PdfCoverFactory.tsx:121-124](src/components/PdfCoverFactory.tsx#L121-L124)),
  so they reset every time the board remounts. "40 per session" is really "40 per
  visit to the board".
- A PDF that fails to load (`onError`) is never marked by
  `hasAttemptedThumbnail`, so it is re-parsed on every return.
- A file that **crashes** the process during cover work leaves no trace, so it
  is retried on every launch. That is a crash loop.

**Fix.** Move the counters to module scope. Before each attempt, write an MMKV
`thumbfail:<id>` = `in-progress` marker and clear it on completion. At launch,
treat a leftover `in-progress` marker as a failure.

---

### B. Functional bugs

#### B1 — Anchor restore never posts `ready` · High
[viewerHtml.ts:1412-1416](src/renderers/webview/viewerHtml.ts#L1412-L1416):

```js
if (scrollToAnchor(payload.anchor)) {
  pendingScroll = 0;
  reportPosition(true);
  return;            // ← skips post({ type: 'ready' }) at line 1451
}
```

Every WebView document records an anchor once it has been scrolled
(`setAnchor`). On the next open, if the anchor falls inside the first paint,
`render` returns without `ready`. `rendered` then stays false in the host, so:
`LoadingCover` never lifts; the rest of the EPUB never streams; images never
arrive; settings, seek, TOC and search messages are never sent.
[viewerSearch.test.ts:469-472](src/__tests__/viewerSearch.test.ts#L469-L472)
**pins the bug**: it requires a bare `return;` within 200 characters.

**Fix.** Post `ready` on that path, ideally from a single exit. Repair the test
so it asserts *every successful render path posts `ready`* and that the anchor
path does not also apply the pixel offset.

#### B2 — Reopening an EPUB duplicates the book · High
[epub.ts:540-584](src/renderers/webview/epub.ts#L540-L584). `loadRest` pushes
onto the closure-level `chapters` array and adds to `charCount`, then returns
`chapters.slice(firstCount)`. Its result is never memoised, and the thunk lives
in the cached `Prepared`. Every mount that drains it calls it again: a reopen in
the same session, a neighbour that remounts, or A5. After *n* opens the rest of
the book is delivered *n* times, the exact page count is *n×* too large, the
anchor/scroll restore lands in the wrong copy, and memory grows each time.

**Fix.** Memoise: `let restPromise: Promise<…> | null = null` and return it on
later calls. Better still, finish the entry as in A4 so later mounts never see
a thunk. Add a test that calls `loadRest` twice and asserts identical output.

#### B3 — Images in later chapters never load · Medium
`imageList` is built at [epub.ts:586-589](src/renderers/webview/epub.ts#L586-L589),
*before* `loadRest` runs. Chapters assembled in phase 2 call `registerImage`,
which writes tokens into the markup and adds entries to `images`, but those
entries are never in `imageList`, so `loadImages` never fetches them. In an
illustrated book every image after chapter 3 stays empty.

**Fix.** Have `loadImages` read the live `images` map, and run it **after**
`loadRest` resolves: chain the two in the renderer, or have `loadImages` await
`restPromise`.

#### B4 — Non-fatal viewer errors are treated as fatal · Medium
[viewerHtml.ts:1541](src/renderers/webview/viewerHtml.ts#L1541) (batch decode)
and [1646](src/renderers/webview/viewerHtml.ts#L1646) (one image) post
`type: 'error'`. The host handles that by replacing the entire renderer with
"Couldn't open this file" ([WebViewRenderer.tsx:906-908](src/renderers/WebViewRenderer.tsx#L906-L908)),
which also unmounts a WebView that was displaying a readable book.

**Fix.** Post `type: 'warn'` for partial failures and log it in `__DEV__`.
Reserve `error` for a failed first render.

#### B5 — Zoom lock survives a file change · Medium
[HorizontalPager.tsx:85](src/components/HorizontalPager.tsx#L85),
[283-290](src/components/HorizontalPager.tsx#L283-L290). `isZoomed` and `zoomed`
change only when the active renderer reports a scale. Picking another file from
the File sheet or switching group while zoomed mounts a new renderer. PDF and
WebView renderers report only on *change*, so they never report 1, and the
pager's `.enabled(!isZoomed …)` stays false until the user pinches.

**Fix.** Reset `isZoomed`/`zoomed` in an effect keyed on `files[index]?.id`,
before the new renderer reports.

#### B6 — Links inside documents · Medium
The sanitisers keep non-executable `href`s. A tap on `<a href="chapter2.xhtml#n1">`
(footnotes, in-book TOCs) resolves against `about:blank` and does nothing.
A tap on `https:`, `tel:`, `market:` and similar fails the `originWhitelist`, and
`react-native-webview` then **calls `Linking.openURL`** on it
(`WebViewShared.tsx:53-58`). A book can launch the browser or another app with
a URL it chose, which contradicts the "file content can never reach the network"
claim in [WebViewRenderer.tsx:35](src/renderers/WebViewRenderer.tsx#L35).

**Fix.** In the viewer, intercept every `<a>` click with `preventDefault`.
- `#frag` and in-book paths → existing `seekToHref`.
- External schemes → post `{type:'link', href}`. The host shows a confirm
  ("Open in browser?") and only allows `http(s)`.

This needs no change to the WebView props.

#### B7 — FTS index drifts · Medium
[db.ts:454](src/storage/db.ts#L454) upserts files with `INSERT OR REPLACE`. In
SQLite, a REPLACE deletes the conflicting row **without firing DELETE triggers**
unless `recursive_triggers` is on, which it is not here. The UPDATE trigger does
not fire either. Every rename, move, reorder and cover capture therefore adds a
new FTS entry and leaves the old one in place. Renamed files keep matching their
old name, results can duplicate, and mismatched `'delete'` commands on an
external-content table can corrupt the index (`SQLITE_CORRUPT_VTAB`), which then
makes every `applyDiff` throw (see C1).

**Fix.** Use `INSERT … ON CONFLICT(id) DO UPDATE SET …` (a true upsert, which
fires the UPDATE trigger). Then force one FTS `'rebuild'` by bumping the
`ftsBuilt` meta value to `'2'`.

#### B8 — Prototype keys are "known extensions" · Low
[formats.ts:140,148](src/storage/formats.ts#L140). `FORMATS` is a plain object,
so `'constructor' in FORMATS` is true. A picked file named `notes.constructor`
is imported with `format: undefined`. That value binds into a `NOT NULL` column,
which makes every later `applyDiff` fail (C1).

**Fix.** `Object.hasOwn(FORMATS, ext)` in both places.

---

### C. Data integrity

#### C1 — Silent, sticky save failure, then prune deletes the files · High
[library.ts saveLibraryNow](src/storage/library.ts) catches and logs. The shadow
is not advanced, so the failing row is resent on every later save and **every
save fails for the rest of the session** (B7 and B8 are two ways to get there).
The user sees nothing. On the next launch the index lacks everything imported
since, so those files are unreferenced, and `schedulePruneOrphans` deletes their
bytes. The empty-library interlock does not help, because the library isn't
empty. This is the DETAIL.md §6.3 failure mode reached by a new route.

**Fix.**
1. Record `lastSuccessfulSave` in MMKV. `pruneOrphans` must never delete a file
   whose `modificationTime` is newer than that timestamp minus a margin.
2. After N consecutive failures, retry row by row and quarantine the offending
   row, logging its id rather than its name.
3. Surface persistent failure to the user once ("Changes couldn't be saved").

#### C2 — Removal deletes bytes before the index write · Medium
[pendingRemoval.ts:213-215](src/store/pendingRemoval.ts#L213-L215).
`removeFile` schedules a 400 ms debounced save, then `deleteFromLibrary` runs
immediately and the MMKV pending marker is cleared. A kill inside that window
leaves an index row for a file that no longer exists, and `resumeInterrupted`
cannot repair it because the marker is gone.

**Fix.** `flushLibrarySave()` between `removeFile` and `deleteFromLibrary`, or
clear the marker only after the flush.

#### C3 — Restore is not additive · Medium
[backup.ts:373](src/storage/backup.ts#L373) writes each entry straight into
`LIBRARY_DIR` with `create({ overwrite: true })`. An archive entry whose name
matches a **live** file overwrites it before `replaceLibrary` commits. A failure
mid-restore then leaves the current library pointing at foreign bytes, which
breaks the promise in CLAUDE.md §4.

**Fix.** Stream into a staging directory (`files/restore-<ts>/`). Validate (D2),
then move into place, then commit. Delete the staging directory on failure.
Refuse names that already exist in the live library unless the restored index
claims the same id.

#### C4 — Export loads every file into memory · Medium
[backup.ts:163-168](src/storage/backup.ts#L163-L168) `await source.bytes()` per
file, and `void writer.write(chunk)` never awaits. Nothing provides
backpressure, so a 2 GB library tries to queue 2 GB in memory. Export also reads
the DB without `flushLibrarySave()` first, so it misses the last 400 ms of
changes.

**Fix.** `flushLibrarySave()` first. Read each file in chunks and
`await writer.write(...)` per chunk, feeding `ZipPassThrough.push` chunk by
chunk.

---

### D. Security

#### D1 — Streamed EPUB chapters skip the DOM sanitiser · High
CLAUDE.md §5.4 says both sanitiser passes are load-bearing. They are on the
first paint (`render` → `sanitize()`). But `appendChunk`
([viewerHtml.ts:1556](src/renderers/webview/viewerHtml.ts#L1556)) inserts
batches with `insertAdjacentHTML` **without** `sanitize()`. Chapter 4 onward of
every EPUB is protected only by the regex pass, and that pass is bypassable.
`EVENT_ATTR`, `STYLE_ATTR` and `SCRIPT_URL` ([sanitize.ts](src/renderers/webview/sanitize.ts))
require whitespace before the attribute name, but HTML also accepts `/`:

```html
<svg/onload=…>   <details/open/ontoggle=…>   <audio src="x"/onerror=…>
```

The `<img>` rewrite in `epub.ts` happens to remove most `<img>` vectors, but not
these. A hostile EPUB can therefore run script in the viewer. It can then forge
bridge messages (D5), and because there is no CSP (D3), reach the network.

**Fix.** All three; each is cheap.
1. Call `sanitize(html)` in `appendChunk` to restore the two-pass invariant.
2. Change the regex prefixes from `\s` to `[\s/]` and add the three vectors above
   to [sanitize.test.ts](src/__tests__/sanitize.test.ts).
3. Add the CSP in D3. With `script-src 'nonce-…'`, inline event handlers cannot
   run at all, whatever the sanitisers miss.

#### D2 — Restore trusts `library.json` · High (AUDIT3 §2.1, still open)
[backup.ts:409-415](src/storage/backup.ts#L409-L415). `storedName` reaches
`new File(LIBRARY_DIR, …)` in a dozen places. A value like `../../databases/stackread.db`
becomes a read primitive, and `id`/`format`/`lastScroll` are unchecked. Implement
`validateLibrary` as AUDIT3 specifies: reject the whole archive on any bad
entry, require `Number.isFinite`, use `Object.hasOwn` for the format check, and
share the safe-name check with the entry-name guard at
[backup.ts:336](src/storage/backup.ts#L336).

#### D3 — No Content-Security-Policy in the viewer · Medium
The WebView is inert for *navigation* only. `fetch`, XHR and image loads are not
navigations. A sanitised HTML, DOCX or Markdown document keeps
`<img src="https://tracker/…">`, which loads, so opening a document can
announce itself to its author. The app holds `INTERNET`.

**Fix.** Emit a CSP `<meta>` in `buildViewerHtml`:

```
default-src 'none'; img-src blob: data:; style-src 'unsafe-inline';
script-src 'nonce-<random per build>'; font-src data:
```

The JSON island is `type="application/json"` and unaffected. Generate the nonce
once per `buildViewerHtml` call. Pin the CSP's presence in
[viewerHtml.test.ts](src/__tests__/viewerHtml.test.ts). Optionally also block
`INTERNET` in release builds through `blockedPermissions`: nothing in the app
needs the network, but the dev client does, so it would need to be release-only.

#### D4 — Restore size limits · Medium
Each entry is gathered fully in `parts` before writing, and nothing caps entry
count, entry size or total size. A crafted backup can exhaust memory, which
crashes the app, or fill storage. Cap entry size (e.g. 1 GB), write in chunks,
and check free space against the archive's declared sizes before starting.

#### D5–D7 — AUDIT3 §2.2–2.4, still open · Low
`Number.isFinite` and length caps on viewer messages; ids instead of names in
[files.ts:63,183](src/storage/files.ts#L63); the extension guard inside
`copyIntoLibrary` (with `Object.hasOwn`, per B8). Do D6 **before** adding crash
reporting, or the names will be uploaded.

---

### E. Release, build and performance

- **E1 (verify).** `react-native-pdf` serialises the PDF outline with Gson
  (`PdfView.java:186-187`), and both it and `modules/pdf-text` use
  `io.legere.pdfiumandroid`. The release keep rules in
  [tune-gradle.mjs](scripts/tune-gradle.mjs) cover `org.wonday.pdf` and
  `com.github.barteksc` but not `io.legere.pdfiumandroid.**`. Add
  `-keep class io.legere.pdfiumandroid.** { *; }`. Then open a PDF that has an
  outline **on a minified release build**; a debug build cannot show this.
  Also confirm that `pdfiumandroid` 1.0.32 serialises calls across instances,
  because the renderer and `usePdfSearch` drive two documents from two threads.
- **E2.** AUDIT3 §3.1: `lifecycle.ts:6` still imports `prefetch.ts`, which pulls
  `fast-xml-parser` into the startup bundle. Move `forgetPrefetchFailure` and
  `resetPrefetchFailures` into a `prefetchState.ts` with no imports.
- **E3.** `readCached` runs `textSync()` + `JSON.parse` of up to 12 MB inside the
  `useState` initialiser ([WebViewRenderer.tsx:101-122](src/renderers/WebViewRenderer.tsx#L101-L122)).
  Fine for small entries; for large ones it is a dropped first frame. Consider
  skipping the disk tier in the initialiser for entries above about 1 MB.
- **E4.** `useAppLifecycle` commits pending removals on `background`. On Android
  the document picker and the share sheet both background the app, so "delete,
  then tap Add files" commits the deletion and loses the undo. Commit after a
  short grace period, or skip when the app knowingly launched an intent.
- **E5.** [ReaderTransition.tsx:106-107,133-136](src/components/ReaderTransition.tsx#L106-L136):
  after `onClosedRef` is captured by the worklet, dev builds freeze it, so
  `onClosedRef.current = onClosed` logs a warning and stops updating. Harmless
  today because `handleClosed` is stable. Call a stable JS-side function through
  `runOnJS` instead of capturing the ref.

---

## 4. The plan

Ordered so that each phase is shippable on its own, and the phases that stop
crashes come first. Effort estimates assume one developer who knows the code.

### Phase 0 — See the crash (½ day)

| # | Task | Done when |
|---|---|---|
| 0.1 | **Capture the crash.** Build `npm run apk:dev`, install, then `adb logcat -c` and `adb logcat -b main -b crash -b events > crash.log`. Reproduce: open an EPUB, read a little, go back. Search the log for `FATAL EXCEPTION`, `Fatal signal`, `am_kill`, `lowmemorykiller`, `ReactNativeJS`, `rendering process`. | The signature matches one row of the §2 table |
| 0.2 | Root + reader `ErrorBoundary`, plus `ErrorUtils.setGlobalHandler` logging (A10) | A thrown error in a renderer closes the reader with a toast instead of killing the app |
| 0.3 | `__DEV__` memory line: log `HermesInternal.getInstrumentedStats()` heap size at reader open, close and board mount, next to the existing `[perf]` lines | Heap is visible before and after each fix |

### Phase 1 — Stop the crashes (3–4 days)

| # | Task | Findings | Done when |
|---|---|---|---|
| 1.1 | EPUB size ceiling; apply the same limit to cover extraction | A1 | A 300 MB EPUB shows a readable refusal |
| 1.2 | Stop decompressing images in phase 1; repair the test to pin registration, not decompression | A3 | Phase-1 unzip list has no images |
| 1.3 | Memoise `loadRest`; `loadImages` reads the live map and runs after `loadRest`; finish the cache entry and drop the archive reference | B2, B3, A4 | New tests: `loadRest` twice → same output; image in chapter 5 → delivered |
| 1.4 | Charge retained archive bytes in `prepareCache.sizeOf` until the entry is finished | A4 | `prepareCacheStats().bytes` reflects the archive |
| 1.5 | Gate the rest/image drain effects on `active` | A5 | Neighbour WebViews never call `loadRest` |
| 1.6 | Archive resident on the worker runtime (or the merged open-time call); evict through `lifecycle.ts` | A2 | One full-archive crossing per EPUB open |
| 1.7 | Cover extraction: targeted unzip, `prefetch` lane, `strFromU8`, size cap, in-progress marker | A6, A12 | Board mount of 20 uncovered EPUBs stays flat in heap |
| 1.8 | Snippet reads a bounded prefix only | A7 | A 400 MB `.txt` on the board does not move the heap |
| 1.9 | CBZ/ZIP: list, budget, then targeted unzip | A11 | A crafted 40 MB → 4 GB archive is refused without allocating |
| 1.10 | pdfium lease; factory hoisted to `Root`, drains instead of aborting; module-scope counters; reader waits for the lease | A8, A12 | Stress: tap a PDF card during a capture 50× → no SIGSEGV |
| 1.11 | `onRenderProcessGone` → remount the WebView from cache, error view on repeat | A9 | On a rooted emulator (`adb root`, then `adb shell pkill -f sandboxed_process`) with a book open, the reader recovers instead of freezing or dying |
| 1.12 | If 0.1 shows a layout-animation stack: remove `exiting` from `LoadingCover` (fade with an animated style instead) and drop `removeClippedSubviews` or the row `exiting` | cause 4 | Open/close loop ×50 is clean |

### Phase 2 — Functional bugs (1–2 days)

| # | Task | Findings |
|---|---|---|
| 2.1 | Post `ready` on the anchor path; repair `viewerSearch.test.ts` to assert `ready` on every successful path | B1 |
| 2.2 | Partial viewer failures post `warn`, not `error` | B4 |
| 2.3 | Reset the zoom lock on file change | B5 |
| 2.4 | Link interception in the viewer: in-book → `seekToHref`, external → confirm in the host | B6 |
| 2.5 | `ON CONFLICT … DO UPDATE` upserts and a one-time FTS rebuild | B7 |
| 2.6 | `Object.hasOwn` for extension lookup | B8 |
| 2.7 | `pageNav.report` dedupe includes `label` (Fix.md, "also found" #4) | — |

### Phase 3 — Data integrity (1–2 days)

| # | Task | Findings |
|---|---|---|
| 3.1 | `lastSuccessfulSave` + prune age guard; quarantine after repeated failures; one user-visible notice | C1 |
| 3.2 | Flush the index before deleting bytes on removal | C2 |
| 3.3 | Restore into a staging dir, validate, move, commit | C3, D2, D4 |
| 3.4 | Export: flush first, chunked reads, awaited writes | C4 |

### Phase 4 — Security hardening (1 day)

| # | Task | Findings |
|---|---|---|
| 4.1 | `sanitize()` in `appendChunk` | D1 |
| 4.2 | `[\s/]` attribute prefixes in the regex sanitiser + the three bypass vectors as tests | D1 |
| 4.3 | CSP meta with a nonce; test pins it | D1, D3 |
| 4.4 | `validateLibrary` (AUDIT3 §2.1) | D2 |
| 4.5 | `Number.isFinite` and string caps on bridge messages; ids, not names, in logs; `copyIntoLibrary` guard | D5–D7 |
| 4.6 | Decide on blocking `INTERNET` for release | D3 |

### Phase 5 — Release and performance (½–1 day)

| # | Task | Findings |
|---|---|---|
| 5.1 | `io.legere.pdfiumandroid` keep rule; verify outline on a minified build; confirm pdfium call serialisation | E1 |
| 5.2 | `prefetchState.ts` to sever the startup import chain | E2 |
| 5.3 | Remaining low items: E3, E4, E5; `versionCode` automation (TASKS2 R7) | E3–E5 |

### Device verification matrix (after Phase 1, again after Phase 4)

Run on a **release** build (`npm run apk:dev`). Debug numbers are 3–8× off.
Test by **force-quitting from recents**, never by reloading.

1. Open a large illustrated EPUB (≥ 50 MB), read for 30 s, go back. Repeat 20×,
   alternating with a PDF. Expect no crash and a flat heap line.
2. Open the same EPUB 5× in one session. The page count must stay the same and
   the text must not repeat (B2).
3. Scroll an EPUB halfway, force-quit, reopen. The loading cover must lift and
   the position restore (B1).
4. A board with 20 uncovered EPUBs, 10 uncovered PDFs and one 400 MB `.txt`:
   cold launch, scroll, open, back. Expect no crash.
5. Tap a PDF card during cover capture (watch for the hidden factory in
   `[perf]`/logcat). Repeat 50×.
6. Zoom a PDF, pick another file from the File sheet, then swipe. It must page (B5).
7. Rename, move and reorder 30 files, then search for an old name. It must not
   match (B7).
8. Restore a backup containing a `../` `storedName`. It must be rejected without
   touching the current library (D2, C3).
9. Open the EPUB test vectors from 4.2 and confirm no script runs. Open an HTML
   file with a remote `<img>` and confirm no request in `adb logcat` / proxy (D3).

---

## 5. What this audit did not cover

- **No device.** Every crash attribution in §2 is by mechanism. Phase 0.1
  replaces that with evidence.
- **No dependency CVE scan** (`npm audit` was not run); `xlsx` 0.20.3 is past the
  known prototype-pollution and ReDoS fixes.
- **No iOS review.** The app targets Android, and iOS-specific paths (WKWebView
  termination, file URLs) were not traced.
- **`react-native-pdf`'s own teardown** (`PdfView.onDetachedFromWindow` → base
  `PDFView.recycle`) was read, not stress-tested. A8's lease makes the app robust
  to it either way.
