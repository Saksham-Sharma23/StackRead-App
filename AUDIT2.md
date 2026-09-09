# StackRead for Android — engineering audit

A read of [src/](src/) plus `App.tsx`, the build scripts, the generated
`android/gradle.properties`, and — new in this pass — the **C++ of
`react-native-worklets`** and the **Kotlin of `react-native-webview`**, because
three of this audit's findings are only visible from inside the libraries the
app hands its bytes to.

Verified against a clean `npm run check` — typecheck plus **323 passing tests,
0 failures**, up from 291.

Audited at branch `master` with the working tree as read. Line references point
at that tree. Every finding below was traced through the code — or through the
dependency's own source — rather than inferred from documentation.

This is the **sixth** audit of this project. The five before it found, in order:
**structural** faults (work registered in the wrong scope), **frequency** faults
(cheap operations on a hot path), **lifetime** faults (nothing owning when a
`file.id` stops being valid), **unpropagated fixes** (a good decision applied to
one path and not its twin), and **enforcement** faults (a rule stated in writing
and not upheld by code).

Companion documents: [TASKS2.md](TASKS2.md) for the worklist this produces,
[AUDIT.md](AUDIT.md) for the fourth audit (**its P13–P17 backlog is still
open** and is carried forward here), [DETAIL.md](DETAIL.md) for the project
record, [CLAUDE.md](CLAUDE.md) for the rules that cost real debugging time.

---

## Verdict

**81 / 100.** Up three points from the fourth audit. Q1–Q5 landed and were
correct as written; the pager is windowed, search is debounced, the id-keyed
stores are invalidated, the composed gesture is memoised. The architecture
continues to be better than most production React Native.

The score is held down by two things, and they pull in opposite directions.
`AUDIT.md`'s **P13 (restore safety) is still open**, which means the app still
has a data-recovery path that can destroy the data it exists to recover — that
alone caps production readiness. And the performance work, which is genuinely
sophisticated at the level of *scheduling*, has never been examined at the level
of *transport*. Every remaining second of latency in this app is a byte crossing
a boundary more times than it needs to.

| Dimension | Score | Δ | Notes |
|---|---|---|---|
| Architecture & design | 90 | — | State split by update frequency, the single WebView host, the format pipeline |
| Code quality & documentation | 92 | −3 | Still the best in any project this size — but two docstrings now describe behaviour the code does not have (§3.1, §3.13) |
| Correctness of core paths | 80 | — | Persistence, gestures and pagination carefully reasoned and tested |
| Security posture | 88 | — | Inert WebView, blocked permissions, `allowBackup=false`, CDN-sourced SheetJS |
| Testing | 70 | +5 | 323 tests, still pure logic only. No integration, no device, no E2E |
| Scalability | 62 | +7 | Pager windowed (Q3-1), search debounced (Q2-2); O(n)-per-mutation paths remain |
| Production readiness | 45 | — | No crash reporting, no error boundary, `versionCode` 1, **restore still unsafe** |
| **Performance engineering** | **68** | **−14** | Scheduling is excellent. **Transport is not, and it dominates.** |

That last row is the entire point of this audit and is a deliberate downgrade,
not a new problem appearing. The previous score of 82 was given for the worklet
lanes, the streaming delivery and the S3-FIFO cache — all of which are real and
all of which remain. What was never examined is what those mechanisms *cost*,
and the answer turns out to be that the two most celebrated optimisations in the
codebase each made the app slower in a dimension nobody was measuring.

### The class of fault this audit found

Each previous audit named a class. This one is **boundary faults**:

> **Work is placed correctly relative to the thread, and incorrectly relative to
> the boundary.**
>
> `offload.ts` moves the unzip off the JS thread — and hands a 10 MB input and a
> 30 MB output across a runtime boundary that copies both, twice (§1.2).
> `epub.ts` streams delivery — across the bridge, after doing all the work
> (§1.3). `WebViewRenderer` batches its posts — into a transport that
> JSON-escapes the content twice and then hands it to a *JavaScript parser*
> (§2.1). `prepare.ts` lazy-imports mammoth — and statically imports 975 KB of
> SheetJS three lines above it (§2.2).

The shape is consistent and it is the natural blind spot of a codebase that
reasons carefully about *when* work runs. Every one of these decisions is right
about scheduling. None of them asked what it costs to move the data to the place
where the work now happens.

The durable version of the lesson, in the spirit of
[DETAIL.md §6.10](DETAIL.md) and §6.12:

> **Moving work across a boundary is not free, and the cost scales with the
> data, not with the work.** Before moving a computation to another thread,
> another runtime, or another process, ask what crosses — and prefer to cross
> once with the *answer* rather than twice with the *question and the raw
> material*.

This is mechanically checkable in a way the previous five classes were not: any
`runOnRuntimeAsync`, `postMessage` or `injectJavaScript` whose argument or
return value is unbounded in size is a candidate. There are five in the app and
four of them are findings below.

---

## 1. Critical

### 1.1 Restore is still unstreamed and still destructive — carried, unresolved

**Severity: total library loss if the process dies mid-restore. Unchanged from
the fourth audit. This is the highest-priority item in the project.**

Re-verified against the current tree. Both findings are exactly as
[AUDIT §1.1](AUDIT.md) and [§1.2](AUDIT.md) described them:

[backup.ts:196](src/storage/backup.ts#L196):

```ts
const unzipped = unzipSync(await archive.bytes())
```

[backup.ts:213](src/storage/backup.ts#L213):

```ts
if (LIBRARY_DIR.exists) LIBRARY_DIR.delete()
```

Peak memory is `archive + fully decompressed library`, on the JS thread, with
the library directory already deleted and `replaceLibrary` not yet called
([backup.ts:249](src/storage/backup.ts#L249)). An OOM kill between those lines
leaves the index describing files that no longer exist, and `pruneOrphans`
cannot help — it removes bytes with no row, not rows with no bytes.

It is worth stating plainly that this is the **only remaining `unzipSync` on the
JS thread** in the app, and that it is on the one path where failure is
unrecoverable. Everything else routes through
[offload.ts:120](src/renderers/webview/offload.ts#L120) — which §1.2 shows has
its own problem, but at least fails safe.

**Fix.** Unchanged from AUDIT.md: fflate's streaming `Unzip`, entry by entry,
and unpack-to-sibling-then-swap so the operation is atomic at the granularity
the user cares about. Ideally both directions share one helper, per that
audit's class-of-fault note.

**Why it is listed again rather than left as a cross-reference.** Five audits
have now been written and this has been the top item in two of them. Repeating
it is the only mechanism available for saying: nothing below matters as much as
this does.

---

### 1.2 The worklet offload copies every byte four times

**Severity: ~4× memory traffic and ~2× peak heap on every EPUB, CBZ and ZIP
open. This is the single largest source of the reported load latency, and it was
introduced by an optimisation.**

[offload.ts:120-142](src/renderers/webview/offload.ts#L120-L142) hands a
`Uint8Array` to a worklet runtime and receives a `Record<string, Uint8Array>`
back:

```ts
return await runOnRuntimeAsync(getRuntime(lane), (data: Uint8Array) => {
  'worklet'
  return unzipSync(data)
}, bytes)
```

The module's own docstring is precise about *why* this is on another thread and
it is correct — `unzipSync` is a synchronous loop over megabytes and belongs off
the JS thread. What it does not say, because nothing in the JS API reveals it,
is what a runtime boundary does to a typed array. From
`react-native-worklets`' own C++:

```cpp
// Serializable.h:261 — crossing IN
SerializableArrayBuffer(jsi::Runtime &rt, const jsi::ArrayBuffer &arrayBuffer, ...)
  : data_(arrayBuffer.data(rt), arrayBuffer.data(rt) + arrayBuffer.size(rt)) {}

// Serializable.cpp:147 — crossing OUT
jsi::Value SerializableArrayBuffer::toJSValue(jsi::Runtime &rt) {
  auto arrayBuffer = rt.global().getPropertyAsFunction(rt, "ArrayBuffer")
      .callAsConstructor(rt, size).getObject(rt).getArrayBuffer(rt);
  memcpy(arrayBuffer.data(rt), data_.data(), size);
  ...
}
```

Every typed array is copied into a `std::vector<uint8_t>` on the way in and
`memcpy`'d into a freshly allocated `ArrayBuffer` on the way out. There is no
shared-memory path and no transfer semantics. On top of that, the returned
`Record` is a `SerializableObject`, so each of the archive's entries is
constructed individually on both sides.

Derived — not measured — for a 10 MB EPUB decompressing to ~30 MB:

| Leg | Bytes copied | Peak resident during the leg |
|---|---|---|
| JS `Uint8Array` → C++ vector | 10 MB | 20 MB |
| C++ vector → worklet `ArrayBuffer` | 10 MB | 20 MB |
| Worklet result → C++ vectors | 30 MB | 60 MB |
| C++ vectors → JS `ArrayBuffer`s | 30 MB | 60 MB |
| **Total** | **~80 MB memcpy** | **~70 MB peak** |

All of it before a single character of the book has been parsed. On a mid-range
device with a per-process heap ceiling in the low hundreds of megabytes, this is
both the latency and the OOM-kill exposure — and it is why
`MAX_PREPARE_BYTES.comic = 300_000_000`
([formats.ts:115](src/storage/formats.ts#L115)) is an unreachable ceiling
(§3.6).

The `canOffload()` fallback compounds it in the failure case: when the worklet
throws — and a serialisation limit on a very large archive is one of the reasons
the docstring itself anticipates — it runs `unzipSync(bytes)` on the JS thread
*after* having already paid for one crossing.

**The boundary is in the wrong place.** The runtime should receive the file
bytes and return the *finished first-paint HTML string*, not the raw archive
contents. Everything between those two points — unzip, XML parse, sanitise,
image registration, anchor injection, character counting — is pure JS over byte
arrays and strings with no native module, no React and no shared mutable state,
which is exactly the shape `offload.ts`'s own docstring says a worklet runtime
can take.

**Fix.** Move `loadEpubAsHtml` and `prepareComic`/`prepareArchive` wholesale
onto the worklet lane and return `{ html, totalPages, toc, rest }`. First-paint
HTML is ~120 KB against a 30 MB record — a **~250× reduction in boundary
traffic**. Strings cross as `SerializableString` (one utf8 conversion each),
which is not free but is three orders of magnitude cheaper here.

Two things must stay on the JS thread and both are already isolated: the
`expo-file-system` read (native module) and `prepareDocx`/`prepareSheet` (heavy
lazy imports that cannot be captured by a worklet closure). Those formats keep
the current shape; they are also the two that do not unzip into a large record.

The images channel needs care: `PreparedImage.bytes` are raw `Uint8Array`s and
returning them would reintroduce the crossing. Return image *offsets into the
archive* instead, and decompress each one on demand at delivery time — which is
what the lazy streaming in
[WebViewRenderer.tsx:449-502](src/renderers/WebViewRenderer.tsx#L449-L502)
already assumes it is doing.

---

### 1.3 The "streaming" EPUB loader parses the whole book before first paint

**Severity: EPUB time-to-first-paint is O(entire book) when it should be O(first
three chapters). This is the second half of the reported "a 10 MB file takes too
long" complaint.**

[epub.ts:313-378](src/renderers/webview/epub.ts#L313-L378):

```ts
for (const href of spine) {                  // ← every chapter in the book
  body = sanitizeHtml(body)                  // ← ~10 regex passes over the chapter
  body = body.replace(/<img\b[^>]*>/gi, ...) // ← image registration
  body = injectPageAnchors(body, ...)        // ← a RegExp constructed per page mark
  charCount += visibleTextLength(body)       // ← another full pass
  chapters.push(...)
}
// ...only now:
const first: string[] = []
const rest: string[] = []
for (const chapter of chapters) {
  if (firstChars < FIRST_PAINT_CHARS) { ... }
}
```

`FIRST_PAINT_CHARS = 120_000` ([epub.ts:76](src/renderers/webview/epub.ts#L76))
splits an array that has **already been fully built**. The
[Prepared.rest](src/renderers/webview/prepare.ts#L57-L79) docstring says the
split exists so that *"a long EPUB opens in a moment and grows behind the reader
instead of holding a spinner for the whole assembly"* — and the delivery does
behave that way. The assembly does not. The reader waits for all 600 pages to be
unzipped, sanitised, anchored and counted, and is then shown the first 120 KB.

The constraint that produced this structure is real and worth preserving:
`totalPages` must be a function of the whole book, never of how much has
arrived, or the content-derived pagination invariant in
[DETAIL.md §5.2](DETAIL.md) breaks and a page count starts depending on load
progress. That would be strictly worse than the layout-derived count it
replaced.

**But the constraint is satisfiable far more cheaply than by parsing the book.**
fflate's `unzipSync` accepts a filter, and the filter receives every entry's
metadata from the ZIP central directory *without decompressing it*
([fflate/lib/index.d.ts:1382](node_modules/fflate/lib/index.d.ts)):

```ts
interface UnzipFileInfo {
  name: string
  size: number          // compressed
  originalSize: number  // ← uncompressed, from the central directory
  compression: number
}
```

So the two-tier page rule survives intact:

1. **Publisher `page-list` wins, unchanged.** It lives in the nav document or
   the NCX — two small entries, decompressed in phase 1. A book that declares
   its pages reports them exactly as it does today, on the first frame.
2. **The character estimate becomes a two-step.** Phase 1 computes a provisional
   count from `Σ originalSize` of the spine's XHTML entries divided by a
   calibrated constant; phase 2 replaces it with the exact
   `visibleTextLength` count when assembly completes and posts a correction.

For XHTML the ratio of raw bytes to visible characters is stable enough that the
provisional number lands within a few percent — far closer than the layout
artefact this design was built to eliminate, and it is corrected within seconds
by a number that is cached thereafter.

**Fix.** Two phases:

- **Phase 1, blocking (~50 ms):** one `unzipSync` with a filter that decompresses
  only `META-INF/container.xml`, the OPF, the nav/NCX, every `text/css` entry,
  and the first ~3 spine items. Derive the page count as above. Assemble, return,
  paint.
- **Phase 2, background:** decompress and assemble the remaining spine on the
  prefetch lane, feeding the existing `rest` batching. Post the exact page count
  on completion.

Combined with §1.2 this is the difference between seconds and roughly 150 ms.

**Note on the interaction with §1.2.** These two fixes compose but are
independent, and §1.3 is the cheaper one. Doing §1.3 alone still crosses the
boundary — but with a filtered archive of five entries rather than six hundred,
so most of the copying disappears as a side effect. Do §1.3 first.

---

## 2. High

### 2.1 Document content reaches the WebView through a JavaScript parser

[WebViewRenderer.tsx:436](src/renderers/WebViewRenderer.tsx#L436) and
[:519](src/renderers/WebViewRenderer.tsx#L519):

```ts
webRef.current.postMessage(JSON.stringify({ type: 'append', content, last }))
webRef.current.postMessage(JSON.stringify(payload))
```

`react-native-webview` implements `postMessage` on Android like this
(`RNCWebViewManagerImpl.kt:322`):

```kotlin
"postMessage" -> {
  val eventInitDict = JSONObject()
  eventInitDict.put("data", args.getString(0))
  webView.evaluateJavascriptWithFallback(
    "(function () {" +
      "var event;" +
      "var data = " + eventInitDict.toString() + ";" +
      ...
  )
}
```

Traced end to end, every byte of every document makes **four full passes**:

| # | Where | What happens |
|---|---|---|
| 1 | JS | `JSON.stringify(payload)` — escape pass over the whole document |
| 2 | Native | `JSONObject.toString()` — **escapes the same content a second time** |
| 3 | Chromium | `evaluateJavascript` — the V8 parser **tokenises a multi-megabyte JavaScript source string** |
| 4 | Viewer | `JSON.parse(e.data)` — third parse |

Two of those are string escaping and one of them is a **JavaScript parser being
used as a data transport**. A 5 MB book delivered in 250 KB batches does this
twenty times.

The batching in
[WebViewRenderer.tsx:400-445](src/renderers/WebViewRenderer.tsx#L400-L445) is
well reasoned — posting in a loop would block the WebView's main thread through
every append — and it correctly bounds *each* pass. It does not reduce their
number.

**Fix, and this needs to be the right one, because the obvious one is closed.**

[TASKS.md P4-1](TASKS.md) already investigated serving content from disk and
recorded the outcome: `allowingReadAccessToURL` is **iOS-only**, and the Android
equivalent would open the WebView to the whole app sandbox. That path is
correctly shut and this audit does not reopen it. The blob-URL solution adopted
instead was the right call.

The available fix is better than either, and it costs nothing:

- **First paint travels in the document, not in a message.** `buildViewerHtml`
  already produces the shell as an HTML string handed to `source={{ html }}`
  ([WebViewRenderer.tsx:645](src/renderers/WebViewRenderer.tsx#L645)), which
  Android loads via `loadDataWithBaseURL` — **Chromium's HTML parser, not its
  JavaScript parser**. Interpolating the first-paint content into that string
  removes all four passes for the largest single chunk, *and* removes the
  `boot → push → ready` round trip with it. First paint capped at
  `FIRST_PAINT_CHARS = 120_000` means this is a bounded, safe amount of markup.
- **Streamed batches use `injectJavaScript`, not `postMessage`.** That command
  is `evaluateJavascriptWithFallback(args.getString(0))` with **no `JSONObject`
  wrapping**, so pass 2 disappears. Carry the payload as base64 — which contains
  no character requiring JS-string escaping, so V8 tokenises it as a single
  opaque literal — and decode in the viewer. Passes 1 and 4 collapse into one
  `atob` + `TextDecoder`.

Small control messages (`settings`, `seek`, `search`) stay on `postMessage`
exactly as they are. They are a few hundred bytes and the current path is
perfectly good for them; this finding is entirely about the unbounded ones.

---

### 2.2 975 KB of SheetJS is evaluated on every cold start

[prepare.ts:3](src/renderers/webview/prepare.ts#L3):

```ts
import * as XLSX from 'xlsx'
```

A static, top-level import, in a module reachable from the app root:

```
App.tsx:10 → ReaderScreen → HorizontalPager → FileRenderer
           → WebViewRenderer → prepare.ts → xlsx
```

`node_modules/xlsx/package.json` resolves `main` to `xlsx.js` — **975,564
bytes** of JavaScript. And the mitigation that would normally save this is
explicitly disabled by Expo SDK 57's own Metro config:

```js
// expo/node_modules/@expo/metro-config/build/ExpoMetroConfig.js:346
getTransformOptions: async () => ({
  transform: { experimentalImportSupport: true, inlineRequires: false },
}),
```

With `inlineRequires: false` there is no lazy-require rescue. **Every cold
launch evaluates the entire SheetJS bundle before the splash can hide**, whether
or not the user owns a single spreadsheet.

What makes this sharp rather than merely unfortunate is that the file already
knows the technique. Ten lines below, `prepareDocx`
([prepare.ts:270-277](src/renderers/webview/prepare.ts#L270-L277)) lazy-imports
mammoth with the reasoning spelled out — *"mammoth is heavy and most sessions
never open a DOCX"* — and that reasoning is equally true of SheetJS and was not
applied to it. This is the fourth audit's class of fault (a good decision not
propagated to its sibling) surviving inside a single function's neighbourhood.

**Fix.** Make `prepareSheet` async and `await import('xlsx')` inside it, exactly
as `prepareDocx` does. Three call sites in the `prepareFile` switch already
`await`, so the change is contained.

**And while the module graph is open:** `React.lazy` the `ReaderScreen` subtree.
It statically pulls in `react-native-pdf`, the WebView host,
[viewerHtml.ts](src/renderers/webview/viewerHtml.ts)'s 1,511-line template
literal, `pagination`, `epub`, `bookCss` and `sanitize` — none of which is
needed to paint the board. The reader mounts on a tap, and
[ReaderTransition](src/components/ReaderTransition.tsx) is already animating
over that moment, which makes it a natural suspense boundary with a designed
cover already in place.

---

### 2.3 `measure()` is O(document) and runs once per appended batch

[viewerHtml.ts:1379](src/renderers/webview/viewerHtml.ts#L1379) — `appendChunk`
calls `measure()` after every insert.
[viewerHtml.ts:496-543](src/renderers/webview/viewerHtml.ts#L496-L543) —
`measure()` walks the whole document:

```js
var breaks = el.querySelectorAll('.sr-pb');
for (var b = 0; b < breaks.length; b++) {
  pbTops.push(breaks[b].offsetTop);   // forced synchronous layout, per node
  pbLabels.push(breaks[b].getAttribute('data-page') || String(b + 1));
}
```

Each `offsetTop` on a freshly mutated DOM forces a layout flush. For a 600-page
book with publisher page anchors, delivered in twenty batches, that is
**~12,000 forced layouts over a document that is growing** — so each batch is
more expensive than the last. This is the mechanism behind a long book becoming
progressively janky *while it loads*, rather than being uniformly slow.

The same applies to `itemTops` in `items` mode
([viewerHtml.ts:513](src/renderers/webview/viewerHtml.ts#L513)) for a long
comic.

The `scrollRange` caching immediately below it
([viewerHtml.ts:526-541](src/renderers/webview/viewerHtml.ts#L526-L541)) is
excellent work and its comment is right about why `progress()` must not read
`scrollHeight` per frame. The identical reasoning was never applied one loop up.

**Fix.** Content is only ever **appended** — `insertAdjacentHTML('beforeend')`
— so every anchor measured before a batch has an unchanged `offsetTop`. Track
`measuredCount` and measure only the anchors added since the last call. That
turns O(batches × pages) into O(pages) for the whole document.

**Better, and worth considering as the real fix:** replace the anchor scan with
an `IntersectionObserver` over `.sr-pb`. Zero forced layout, zero work in the
scroll handler, and the browser reports the current page itself. It is the
browser-native expression of what this code is hand-rolling, and it composes
with streaming appends for free.

---

### 2.4 `persist()` flattens the entire library on every mutation, outside the debounce

[store/library.ts:99-102](src/store/library.ts#L99-L102) is called synchronously
inside **eleven** reducers ([:168](src/store/library.ts#L168),
[:197](src/store/library.ts#L197), [:206](src/store/library.ts#L206),
[:239](src/store/library.ts#L239), [:257](src/store/library.ts#L257),
[:277](src/store/library.ts#L277), [:294](src/store/library.ts#L294),
[:315](src/store/library.ts#L315), [:335](src/store/library.ts#L335),
[:351](src/store/library.ts#L351)), and it calls `toLibrary`
([:83-97](src/store/library.ts#L83-L97)):

```ts
ids.forEach((id, index) => {
  const entry = state.filesById[id]
  if (entry) files.push({ ...entry, orderInGroup: index })   // ← new object per file
})
```

`scheduleSave` debounces the **write**. It does not debounce this. So every
mutation allocates a fresh object for every file in the library, and then
`diffLibrary` hashes all of them
([libraryDiff.ts](src/storage/libraryDiff.ts)) when the timer fires.

The cost lands exactly where it hurts most: `setThumb` is called once per
generated thumbnail, so importing 50 files rebuilds the whole library 50 times
in quick succession — on the JS thread, while the board is animating those cards
in.

This does not contradict the SQLite migration's premise. Row-level writes did
remove megabytes of `JSON.stringify`, and that was the expensive half. What
remained was the flatten, which was correct to keep and incorrect to leave
outside the debounce.

**Fix.** Have `scheduleSave` accept the normalized state (or a thunk) and call
`toLibrary()` once, inside the timer, immediately before diffing.
`flushLibrarySave` does the same on its synchronous path. Ten call sites change
shape; no behaviour does.

---

### 2.5 Every swipe destroys and rebuilds a WebView

[HorizontalPager.tsx:295-358](src/components/HorizontalPager.tsx#L295-L358)
mounts a renderer only for the active file, and the reasoning is one of the best
comments in the codebase — three live pdfium documents crashed inside
`FPDF_LoadPage`, and three EPUB renderers parsed three whole books at once. That
constraint is real and this finding does not challenge it.

**It is a pdfium constraint, and it has been applied to the WebView, which does
not share it.** For the eight formats served by the WebView host, every swipe
pays:

- Chromium view construction
- `loadDataWithBaseURL` of the ~30 KB shell plus its inline script
- script evaluation and the `boot` message round trip
- content post
- layout, and the `ready` round trip

`prepareCache` warms the *content* and does so well — the pinned window, the
S3-FIFO tail and the synchronous first-render read in
[WebViewRenderer.tsx:168-172](src/renderers/WebViewRenderer.tsx#L168-L172) are
all correct. None of it warms the **view**, and the view is the part with a
fixed hundreds-of-milliseconds floor.

**Fix.** One WebView instance owned by the pager for the life of the reader
session, with documents swapped on index change. PDF and image renderers keep
single-mounting unchanged.

**Sequence this after §2.1 and measure first**, because the two interact: §2.1's
first-paint-in-the-document technique requires constructing the WebView *with*
its content, which is in tension with reusing one instance. The likely resolution
is inline source for the first document of a session and an injected swap for
subsequent ones — but that is a design decision that should be made against a
number, not against this paragraph. See [TASKS2.md R5](TASKS2.md).

---

## 3. Medium

**3.1 `useGroupFiles` re-renders every row on any file metadata change — and its
docstring says the opposite.** [selectors.ts:43-44](src/store/selectors.ts#L43):

```ts
const ids = useLibrary((s) => s.groupOrder[groupId]) ?? EMPTY_IDS
const filesById = useLibrary((s) => s.filesById)   // ← replaced by every setThumb
```

`groupOrder`'s identity is stable per group, which is the property the
normalization was built for. But `filesById` is a **second subscription**, and
every reducer that touches a file replaces the whole map. So one thumbnail
landing re-runs every mounted row's `useMemo`, allocates a new array for each,
re-renders every `GroupRow`, and runs every `FileCard` comparator. During an
import of *N* files that is *N* × rows × cards.

The docstring claims: *"Adding a file to one row cannot re-render the others, and
neither can editing a file's metadata: `groupOrder` is untouched by `setThumb`."*
The second clause is false. This is the fifth audit's class of fault —
a written rule the code does not uphold — in the file that exists to document
that exact rule.

**Fix.** Two options, and the second is better. Either give `setThumb` a
structurally-shared update so unchanged entries keep identity and the `useMemo`
short-circuits; or push the lookup into `FileCard` via a per-id subscription,
the way progress already works through `useMMKVNumber`
([FileCard.tsx:74](src/components/FileCard.tsx#L74)). The second removes the
dependency entirely and matches a pattern already proven in the same component.

**3.2 `usePdfsNeedingCovers` and `useFileCount` still scan every file on every
mutation** — carried from [AUDIT §2.2](AUDIT.md), unresolved.
[selectors.ts:103](src/store/selectors.ts#L103) and
[:84](src/store/selectors.ts#L84). `useShallow` suppresses the *re-render*, not
the *scan*; Zustand runs every subscriber's selector on every store update. The
docstring's defence of returning ids rather than entries remains correct and
load-bearing — it is the scan itself that went unexamined. Maintain the set
incrementally in the reducers: a PDF enters in `addFiles` and leaves in
`setThumb`/`removeFile`, so it only ever shrinks. O(1) per mutation, no scan.

**3.3 `prefetchAround` re-fires on every library mutation** — carried from
[AUDIT §2.3](AUDIT.md), unresolved.
[ReaderScreen.tsx:125-127](src/screens/ReaderScreen.tsx#L125-L127) depends on
`[files, index]`, and `files` is a `useMemo` over `filesById`, so any metadata
write produces a new identity. Compounds directly with §3.1. Depend on the three
neighbour ids instead.

**3.4 The thumbnail `attempted` set is session-scoped and never persisted.**
[thumbs.ts:23](src/storage/thumbs.ts#L23). A file that legitimately yields no
cover — an EPUB with no declared cover image, a comic whose first entry is not
an image — is retried on **every cold launch**, two at a time, each retry a full
unzip through the §1.2 boundary. On a library with many such files this is a
measurable and entirely wasted startup cost. Persist the negative results in
MMKV, keyed by id and invalidated through
[lifecycle.ts](src/storage/lifecycle.ts) like everything else.

**3.5 `PdfCoverFactory` still has no session budget** — carried from
[AUDIT §2.4](AUDIT.md), unresolved.
[LibraryScreen.tsx:744](src/screens/LibraryScreen.tsx#L744) mounts it with the
full list. One-at-a-time is correct; nothing bounds the queue. A 3,000-PDF
library is 3,000 sequential rasterise-and-capture cycles at `SETTLE_MS = 400`
each — over twenty minutes of continuous native PDF work competing with the
scrolling the user is doing. Cap per session and order by what is on screen.

**3.6 `comic` and `archive` ceilings are unreachable.**
[formats.ts:115-116](src/storage/formats.ts#L115-L116) permits 300 MB. With
§1.2's 4× amplification and §1.3's whole-archive materialisation, the process
dies long before that. A ceiling that cannot be hit is not a ceiling — it is a
comment. Drop both to ~40 MB now, and raise them deliberately once §1.2 and §1.3
have made a larger number mean something.

**3.7 `pruneOrphans` is still an unchunked full-directory walk** — carried from
[AUDIT §2.5](AUDIT.md), unresolved.
[files.ts:242-263](src/storage/files.ts#L242-L263). Correctly deferred and
throttled; still a multi-second JS-thread freeze at 10,000 entries, landing
*after* the user has started interacting. Chunk it in ~8 ms slices, the way the
image and chapter pumps in `WebViewRenderer` already yield.

**3.8 `sizeCache` is unbounded** — carried from [AUDIT §3.5](AUDIT.md).
[files.ts:111](src/storage/files.ts#L111). `forgetSize` and `clearSizeCache`
exist and are correctly wired into `lifecycle.ts`; nothing bounds ordinary
growth.

**3.9 Search results are silently capped at 50** — carried from
[AUDIT §3.3](AUDIT.md). [db.ts:338](src/storage/db.ts#L338). No affordance, no
count, no indication that a 51st match exists.

**3.10 Still no error boundary** — carried from [AUDIT §3.8](AUDIT.md). Verified
absent: no `componentDidCatch` or `getDerivedStateFromError` anywhere in the
tree. A render throw is a white screen with no recovery path, in an app whose
core loop is parsing files from arbitrary sources.

**3.11 Still no crash or error reporting** — carried from
[AUDIT §3.9](AUDIT.md), and it remains the sharpest single gap in the project.
Every failure path is `console.warn` or `console.error`, which is invisible on a
user's device. The defining incident of this project
([DETAIL.md §6.3](DETAIL.md)) was a **silent write failure**, and every fix that
followed makes failures loud in a console nobody reads.

**3.12 `versionCode` is still 1 with no bump automation** — carried from
[AUDIT §3.7](AUDIT.md). [app.json:12](app.json#L12).

**3.13 Dead code is still present** — carried from the fifth audit's Q0, which
never landed. `fileChanged` ([libraryDiff.ts:68](src/storage/libraryDiff.ts#L68))
and `groupChanged` ([:84](src/storage/libraryDiff.ts#L84)) have no callers, and
`hashFile`'s docstring still refers to `fileChanged` as though it were live —
the situation [DETAIL.md §6.12](DETAIL.md) describes as *"an active invitation to
reintroduce the bug."* `noUnusedLocals` / `noUnusedParameters` are still absent
from [tsconfig.json](tsconfig.json).

**3.14 The archive text-preview path is security-adjacent and untested.**
[prepare.ts:393-397](src/renderers/webview/prepare.ts#L393-L397) inlines entries
matching `TEXT_RE` — which includes `.js`, `.ts`, `.css`, `.html` — into a
`<pre><code>` block. It is safe **because** of the `escapeHtml` call, and
`IMAGE_RE`'s deliberate exclusion of SVG is documented at length in
[bytes.ts](src/renderers/webview/bytes.ts). The text path has no equivalent note
and no test. One refactor that swaps `escapeHtml` for a sanitiser "for
consistency" would turn a ZIP listing into an HTML injection vector. Add a test
that asserts a `<script>` inside a `.html` entry renders as literal text.

**3.15 `MAX_GHOSTS = 32` is still unexplained** — carried from
[AUDIT §3.6](AUDIT.md).
[prepareCache.ts](src/renderers/webview/prepareCache.ts). In a codebase whose
own [CLAUDE.md](CLAUDE.md) warns that *"a bare tuning constant with no rationale
will be 'cleaned up' by the next reader"*, this one is exposed.

---

## 4. What is measurable, and is not measured

This is not a finding so much as the reason the findings above survived five
audits, and it deserves its own section.

The comments in this project are exceptional at recording **why a fix was
made**. There is no instrument anywhere recording **how slow anything is**. Not
one timer, not one counter, not one long-task observer. The performance work has
therefore been reasoned rather than measured, which is why it is excellent at
scheduling — a property you can reason about — and blind to transport, which you
cannot.

Every finding in §1 and §2 would have been obvious within one session of having
these four log lines:

```
[startup] bundle-eval 000ms → store-hydrate 000ms → first-paint 000ms
[prepare] epub 8.2MB → read 000ms · cross 000ms · unzip 000ms · assemble 000ms
[viewer]  boot 000ms → ready 000ms → complete 000ms  (n batches, m images)
[longtask] measure() 000ms over n anchors
```

**And a note on the harness, because it may be doing real damage to everyone's
intuition here.** `npm run android` produces a debug build. Debug React Native
serves plain JavaScript from Metro for Hermes to parse at runtime instead of
precompiled bytecode, runs React in development mode with double-invoked
renders, and applies no R8. Cold start and module evaluation are routinely
3–8× slower than release. The §2.2 SheetJS finding in particular is far worse in
debug than in production.

Nothing in this document should be verified against a debug build.
`npm run apk:dev` produces a release APK that is not going to ship, which is
exactly the right instrument. That should be the only artefact anyone benchmarks.

---

## 5. Scaling limits, revised

Updated for what Q1–Q5 landed. The pager row is now resolved.

| Library size | What breaks |
|---|---|
| ~200 files | §3.1 — a single thumbnail landing re-renders every mounted row |
| ~500 | Cover-factory backlog (§3.5); `usePdfsNeedingCovers` scan becomes visible (§3.2) |
| ~2,000 | `pruneOrphans` freeze (§3.7); `persist()` flatten per mutation becomes visible (§2.4) |
| ~5,000 | MMKV loads every key at startup — 4 keys per file, ~20,000 keys |
| ~10,000 | Whole library resident; **restore impossible** (§1.1) |
| ~100 in one group | Fine — the pager windows to ±1 as of Q3-1 |

**Per-file limits are now the binding constraint, not per-library ones.** A
single 10 MB EPUB costs ~70 MB of peak heap through §1.2 before it renders. That
is the ceiling users will hit first, and it is the one they have already
reported.

**The architectural ceiling** remains `readLibrary()`
([db.ts:277](src/storage/db.ts#L277)) loading every row at startup. Its docstring
defends this well and is right at today's scale; the `files_by_group` index
already exists for the day it is not. Cursor-based per-group hydration is
deliberately **not** recommended yet — complexity bought against a scale nobody
is at.

---

## 6. What is genuinely well built

Stated explicitly, because six audits of findings is a distorted picture of a
codebase that is better than most.

- **`prepareCache`** — S3-FIFO with an explicit pinned window, ghost queue, and
  a byte budget that correctly counts image bytes separately from string length.
  The reasoning for why a plain LRU evicts exactly the wrong entries here is
  correct and non-obvious.
- **`libraryDiff` + the shadow copy** — hashes rather than a second library
  copy, updated only after a write succeeds so a failure retries instead of
  being silently skipped. This is a direct, correct response to
  [DETAIL.md §6.3](DETAIL.md).
- **Gesture arbitration** — the 24-vs-8 asymmetry, `.enabled()` at activation
  rather than a check in `onUpdate`, `Gesture.Simultaneous` over exclusive.
  Every line is scar tissue and every line is right.
- **`lifecycle.ts`** — one owner for the question of when a `file.id` stops
  being valid, with the rule written where it is enforced. §3.1 is a rule
  violation elsewhere; this module is the reason such violations are findable
  at all.
- **`store/scroll` as a non-React store** — the correct call, correctly argued,
  with a write mirror that avoids a JSI read to skip a JSI write.
- **`viewerHtml.test.ts`** — still the most valuable file in the suite. Parsing
  the emitted script is the only thing standing between a template-literal typo
  and a device.
- **The security posture** — an inert WebView, a regex pre-pass in front of a
  DOM pass with the asymmetry between them documented precisely, SheetJS from
  the vendor CDN because npm's copy is abandoned and vulnerable.

---

## 7. Recommended order of work

Sequenced so safety lands before speed and each phase is independently
shippable. Broken into tasks with files and verification steps in
[TASKS2.md](TASKS2.md), as the **R-series**.

### R0 — Instrument first

Four log lines (§4). Everything after this is verified against a number rather
than a feeling, and it takes under an hour. **Do not start R2–R5 without it.**

### R1 — Restore safety (highest priority, carried from P13)

Stream the restore unzip; unpack-then-swap (§1.1). Until this lands the app can
destroy the library it is recovering.

### R2 — Free wins

Lazy-import SheetJS and lazy-load the reader subtree (§2.2); move `toLibrary`
inside the debounce (§2.4); incremental `pdfsNeedingCovers` and `useFileCount`
(§3.2); key `prefetchAround` on ids (§3.3); persist thumbnail failures (§3.4);
drop the fictional size ceilings (§3.6). Half a day, no architectural risk.

### R3 — Transport

Incremental `measure()` (§2.3); first paint inside the document and
`injectJavaScript` for batches (§2.1); fix `useGroupFiles`' second subscription
(§3.1).

### R4 — The document pipeline

Two-phase EPUB via the fflate central-directory filter (§1.3), then move the
whole prepare across the worklet boundary and return a string (§1.2). This is
the decisive phase for the reported latency.

### R5 — Persistent WebView

One instance per reader session (§2.5). **Gated on R0's numbers** — build it
only if the measurement says the view lifecycle, and not the parse, is what
remains.

### R6 — Scale and housekeeping

Chunk `pruneOrphans` (§3.7); cap and prioritise the cover factory (§3.5); bound
`sizeCache` (§3.8); paginate search (§3.9); delete the dead code and turn on the
compiler flags (§3.13); test the archive text path (§3.14); explain
`MAX_GHOSTS` (§3.15).

### R7 — Ship readiness

Error boundary (§3.10); crash reporting (§3.11) — still the highest-leverage
single change in the project; `versionCode` automation (§3.12); commit hygiene;
a performance regression check at 1k / 5k / 10k files.

---

## 8. Process note

Six audits have now found, in order: **structural** → **frequency** →
**lifetime** → **unpropagated fixes** → **enforcement** → **boundary**.

The progression is not accidental. Each class is found by a different technique,
and each becomes reachable only once the previous one is cleared. Structural
faults are found by asking where a thing is mounted. Frequency faults, by asking
how often it runs. Lifetime faults, by grepping for callers of an invalidation
function. Unpropagated fixes, by holding two files side by side. Enforcement
faults, by reading a docstring against its own code.

**Boundary faults are not visible from the app's source at all.** Every line in
`offload.ts` is correct, well reasoned and does what its comment says. The cost
is in `Serializable.cpp`. Every line in `WebViewRenderer` is correct; the cost is
in `RNCWebViewManagerImpl.kt`. The only way to find this class is to read the
dependency's implementation of the primitive you are calling — and to notice
that "async" and "off-thread" describe *when* work happens while saying nothing
about what it costs to get the data there.

The durable version, alongside [DETAIL.md §6.10](DETAIL.md) and §6.12:

> **A boundary is an API and a cost. The API is documented; the cost is in the
> implementation.** For any call that moves unbounded data — across a runtime,
> a bridge, a process, or a parser — read the other side before assuming the
> move is free. Prefer to cross once with the answer over twice with the raw
> material.

There is a mechanical check available here that was not available for the
previous five classes, and it should be adopted: **any `runOnRuntimeAsync`,
`postMessage`, `injectJavaScript` or `source={{ html }}` whose payload is
unbounded in size is a review item.** There are five such call sites in this app
and four of them are findings in this document.

**The behavioural-test gap noted in three previous audits still stands**, and
§1.1 is still the property nothing asserts. 323 tests cover pure logic well.
Nothing asserts *"a restore interrupted halfway leaves the library intact."*
That has been true across three audits and the code it describes has not changed.

---

## Appendix A — the fifth audit, for the record

This document replaces the fifth audit, whose findings are now history. It found
**enforcement** faults — rules the codebase states in writing that the code does
not uphold — and its four material findings were:

1. A dead `memo()` on every group row: `GroupRow` was memoised and the call site
   defeated it with an unstable `renderItem`.
2. `lifecycle.ts`'s stated rule — *"every cache keyed by file id must be
   invalidated here"* — unenforced for two Zustand stores.
3. The pager mounting one file while laying out a view slot for every file in
   the group.
4. A synchronous FTS5 query on every keystroke.

**All four landed**, as Q1–Q5 in the previous `TASKS2.md`, along with fourteen
smaller findings. `Q0` — dead code and the two compiler flags — never landed and
is carried forward here as §3.13 and [TASKS2.md R6-5](TASKS2.md).

Two of its findings are worth preserving verbatim as *decisions not to act*,
because both are correct and both will otherwise be re-proposed:

- **`getItemLayout` on the board's `FlatList` is not safe here.** Nothing sets
  `allowFontScaling={false}` or `maxFontSizeMultiplier`, so row height varies
  with the system font size. A hardcoded height would misplace every row for
  users on large accessibility fonts — a correctness bug traded for a
  performance win, against exactly the users least able to work around it.
  Revisit only if row height becomes font-independent.
- **`evict()`'s repeated scans are fine.** `tailCount()` and `tailBytes()` both
  walk the Map inside the loop condition, but `MAX_TAIL_ENTRIES = 6` bounds it.
  Restructuring a correct S3-FIFO implementation to save six iterations is a bad
  trade. Revisit only if the tail budget grows.

---

## Appendix B — method

- Full read of [src/](src/) — 96 files — plus `App.tsx`, `index.ts`,
  `metro.config.js`, `app.json`, `tsconfig.json`, `package.json` and
  `scripts/`.
- **New in this pass:** the implementation of every boundary primitive the app
  calls. `react-native-worklets`' `Serializable.h` / `Serializable.cpp` for
  typed-array crossing semantics; `react-native-webview`'s
  `RNCWebViewManagerImpl.kt` for what `postMessage` compiles to on Android;
  `@expo/metro-config`'s `ExpoMetroConfig.js` for `inlineRequires`; `fflate`'s
  `UnzipOptions` for whether a filtered read is available.
- `npm run check` on the tree as read: typecheck clean, **323 / 323 tests
  passing**.
- Every carried finding from [AUDIT.md](AUDIT.md) re-verified against the
  current code rather than assumed still open. Those that landed via Q1–Q5 are
  not repeated; those that did not are restated with their current line numbers.
- Byte-traffic figures in §1.2 are **derived from the dependency's source**, not
  measured on a device. They are arithmetic over known copy semantics and should
  be treated as an order-of-magnitude claim until R0 produces real numbers.
- Not covered, and honestly out of scope for a static read: actual frame timings,
  real peak memory, and whether any of this *feels* different. Per
  [CLAUDE.md](CLAUDE.md), that has always been a device question.
