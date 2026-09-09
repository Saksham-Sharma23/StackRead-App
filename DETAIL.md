# StackRead for Android — project record

A complete account of what this project is, what it currently does, how it is
built, and — in the most detail — **what went wrong along the way and what each
failure changed about the code**. The last section is the point of the document:
most of the design here is scar tissue, and the reasoning is worth more than the
diff.

Written 2026-08-29. Companion documents: [README.md](README.md) for using and
building the app, [docs/RN_ANDROID_SETUP.md](docs/RN_ANDROID_SETUP.md) for the
reusable Android/Expo setup playbook.

---

## 1. What the app is

StackRead is a port of a desktop (Electron) file reader to Android, keeping the
core idea intact.

**The idea is a 2-D board.**

- The **horizontal** axis is a *group* — a row of related files.
- The **vertical** axis is the stack of groups.
- Opening a file gives you **vertical scroll to read** and **horizontal swipe to
  move to the next file in the same group**.

That second sentence is the whole product. Reading a paper and its three
references means putting them in one group and swiping between them, instead of
juggling four windows.

**A group is a logical tag, never a folder.** `FileEntry.groupId` is a string
field ([src/types.ts:33](src/types.ts#L33)). Moving a file between groups is a
one-field change and never touches disk. This is what makes reorganizing free,
and it is why the drag interaction below could be constrained so aggressively
without losing anything.

### Deliberate deviations from desktop

| Desktop | Android | Why |
|---|---|---|
| `storedPath` — absolute path | `storedName` — basename only | An absolute Android path is not stable across devices or user profiles, and would break backup/restore. Resolved against the library dir at read time ([paths.ts:51](src/storage/paths.ts#L51)). |
| Two-pane ZIP browser | Single scrolling list with previews | A split view does not survive a phone-width screen. |
| Native file dialog with a MIME filter | Wildcard picker, filtered by extension afterwards | Android pickers filter unevenly across vendors; a strict MIME list silently *hides* openable files, e.g. a `.md` served as `application/octet-stream` ([files.ts:31-35](src/storage/files.ts#L31-L35)). |
| React Router | One conditional swap in `App.tsx` | Two destinations, one of which is a full-screen takeover. A nav library would be a dependency that buys nothing. |

---

## 2. Tech stack

Pinned versions, because on this platform they matter more than usual.

| Layer | Choice | Version | Note |
|---|---|---|---|
| Framework | Expo (bare workflow, prebuilt `android/`) | SDK 57.0.18 | |
| Runtime | React Native | 0.86.3 | New Architecture, **mandatory** since SDK 55 |
| UI | React | 19.2.3 | |
| Language | TypeScript | 6.0.3 | strict |
| Node | Node.js | 24.20.0 | |
| Animation | Reanimated + `react-native-worklets` | 4.5.1 / 0.10.1 | Worklets is a separate package in RN 0.86 |
| Gestures | `react-native-gesture-handler` | 2.32.0 | |
| State | Zustand | 5.0.15 | |
| Hot storage | `react-native-mmkv` | 4.3.2 | v4 is Nitro-based — different API from v2/v3 |
| Files | `expo-file-system` | 57.0.6 | SDK 57 `File`/`Directory`/`Paths` classes |
| PDF | `react-native-pdf` | 7.0.5 | native PdfRenderer |
| HTML host | `react-native-webview` | 13.16.1 | |
| Unzip | `fflate` | 0.8.3 | EPUB, CBZ, ZIP, and library export |
| DOCX | `mammoth` | 1.12.2 | lazily imported |
| Spreadsheets | `xlsx` (SheetJS) | 0.20.3 | **from the SheetJS CDN, not npm** — see §6.9 |

### Two decisions that shaped everything else

**1. Expo dev client, not Expo Go.** Five native modules — MMKV, PDF, WebView,
Reanimated, gesture-handler — are not in the Expo Go binary. Testing on a
physical phone therefore requires a custom dev build. Deciding this on day one
avoids discovering it after writing a lot of code. See
[RN_ANDROID_SETUP.md §9](docs/RN_ANDROID_SETUP.md).

**2. Two renderer families, not eleven renderers.**

- **Native fast path** — PDF ([PdfRenderer.tsx](src/renderers/PdfRenderer.tsx))
  and images ([ImageRenderer.tsx](src/renderers/ImageRenderer.tsx)), where the
  platform already does the hard work well.
- **One WebView host** ([WebViewRenderer.tsx](src/renderers/WebViewRenderer.tsx))
  for everything HTML-ish: EPUB, DOCX, XLSX, CSV, CBZ, ZIP, Markdown, HTML, text.

Every format in the second family converges on `prepareFile()`
([prepare.ts:286](src/renderers/webview/prepare.ts#L286)). **Adding a format is
one function in one file** — no native module, no renderer component, no change
to the pager. Six of the eleven supported formats were added this way, additively.

---

## 3. What the app currently does

### Library board
- Vertical list of groups (a plain `ScrollView`), each a horizontal row of
  file cards. FlashList was evaluated and dropped: the board is a handful of
  rows, not a feed, so virtualisation bought nothing and cost a dependency
- Add files via the system picker; **files are copied into app storage**, so the
  library cannot break when the user moves or deletes the original
- Inline group rename (tap the title), add/remove groups
- **Long-press-drag a card to reorder within its own row** — see §5.1
- Per-card 3-dot menu: move to another group, share, remove
- Thumbnails generated for images; a coloured format badge for everything
  else. PDF page-1 rendering is not implemented — `canThumbnail()` in
  [thumbs.ts](src/storage/thumbs.ts) is the single place that decides this
- Reading-progress bar on each card
- Delete with a 5-second undo window — nothing touches disk until it elapses
- Export/import the whole library as one `.zip`
  ([backup.ts](src/storage/backup.ts))

### Reader
- Vertical scroll reads; horizontal swipe changes file **within the group**
- Chrome (top bar, dots) auto-hides on tap so the document owns the screen
- **File** and **Group** dropdowns in the top bar, mirroring the desktop app
- **Draggable scroll indicator** — grab it and seek to any page, as in Drive
- **Chapters** (☰) sheet for books that declare a TOC
- **Display** (Aa) sheet — font size, line spacing, margins, and four themes
  (light / sepia / dark / black), persisted app-wide
- Page position remembered per file, restored on reopen
- Android back closes an open sheet first, then the reader

### Formats

| Format | Renderer | Page count from |
|---|---|---|
| PDF | native | real pages |
| PNG/JPG/GIF/WEBP/AVIF/BMP/HEIC | native | n/a |
| EPUB | WebView | publisher `page-list`, else ~1000 chars/page |
| DOCX | WebView (mammoth) | ~1800 chars/page |
| XLSX / XLS / CSV / TSV | WebView (SheetJS) | none — grid has no pages |
| CBZ | WebView | exact image count |
| Markdown / TXT / LOG / HTML | WebView | ~1000 chars/page |
| ZIP | WebView | listing |

---

## 4. Architecture

```
App.tsx                 two destinations, conditional swap
├── LibraryScreen       the board
│   └── GroupRow        one group = one horizontal ScrollView
│       └── DraggableCard → FileCard
└── ReaderScreen        full-screen takeover
    └── HorizontalPager  ← the gesture core
        └── FileRenderer  → PdfRenderer | ImageRenderer | WebViewRenderer
                                                             └── webview/
                                                                 prepare.ts   format → HTML
                                                                 epub.ts      EPUB unpacking
                                                                 pagination.ts page counting
                                                                 bookCss.ts   CSS normalization
                                                                 viewerHtml.ts the viewer shell
```

### State is split by update frequency

This is the single most important structural rule, carried over from desktop.

| Store | Holds | Backed by | Why separate |
|---|---|---|---|
| `store/library` | groups, files | `library.json` (debounced) | Cold. Re-renders the board — that is fine, it changes rarely. |
| `store/pageNav` | current page, TOC, jump requests | memory | Keyed **per fileId**, because the pager keeps three renderers mounted at once |
| `store/readerSettings` | font, spacing, margins, theme | MMKV | App-wide, not per file |
| `store/scroll` | scroll offset, zoom, progress | MMKV | **Not a React store at all** |
| `store/pendingRemoval` | ids inside the undo window | memory | |

`store/scroll` deserves the emphasis. It is written on *every scroll settle* and
read once when a renderer mounts. In Zustand that would re-render the pager on
every tick. As a plain module-level API over MMKV — synchronous, JSI-backed — it
is both simpler and faster ([scroll.ts:1-13](src/store/scroll.ts#L1-L13)).

### Zustand selectors must return stable references

Stated here because violating it cost real debugging time twice (§6.10):

> A selector that allocates on every call — `?? []`, `.filter(...)`, `.map(...)`
> — makes Zustand see a new value each render, which re-renders, which allocates
> again. React reports it as **"Maximum update depth exceeded"**, preceded by
> *"The result of getSnapshot should be cached to avoid an infinite loop"*.

Two correct escapes, both used in [store/selectors.ts](src/store/selectors.ts):

```ts
// Wrap the selector so it compares contents, not identity:
const groups = useLibrary(useShallow((s) => s.groups))

// Or select a raw slice and derive with useMemo:
const tocRaw = usePageNav((s) => (current ? s.toc[current.id] : undefined))
const toc = useMemo(() => tocRaw ?? EMPTY_TOC, [tocRaw])
```

### Security posture of the WebView

The viewer is deliberately inert
([WebViewRenderer.tsx:225-245](src/renderers/WebViewRenderer.tsx#L225-L245)):
`originWhitelist: ['about:blank']`, navigation refused via
`onShouldStartLoadWithRequest`, `allowFileAccess={false}`,
`allowFileAccessFromFileURLs={false}`,
`allowUniversalAccessFromFileURLs={false}`, `domStorageEnabled={false}`,
`setSupportMultipleWindows={false}`.

Content reaches it only through `postMessage`, and images are inlined as data
URIs. **File content can never reach the network.** This is the mobile analogue
of the desktop app's `will-navigate` guard. The cost of this choice, and the one
place it still binds, is §7.1.

---

## 5. The two hard parts

### 5.1 Gesture arbitration

Three gestures compete for one finger in the reader: **vertical drag scrolls**,
**horizontal drag changes file**, **pinch zooms**. On top of that a card on the
board must be long-press-draggable inside a row that is itself horizontally
scrollable, inside a vertically scrolling list.

Rules, all in [HorizontalPager.tsx](src/components/HorizontalPager.tsx):

```ts
.activeOffsetX([-24, 24])   // claim only decisive horizontal intent
.failOffsetY([-8, 8])       // yield the instant the drag looks vertical
.maxPointers(1)             // a second finger means pinch — not ours
.enabled(!isZoomed && !seeking)
```

The asymmetry between 24 and 8 is intentional: **scrolling is used far more often
than paging, so ambiguity must resolve in scrolling's favour.**

Three details that were each learned the hard way:

- **`Gesture.Simultaneous`, not exclusive.** An exclusive pager claims the touch
  and the PDF view's own scroll and pinch never fire — which is what made the
  document feel dead (§6.4).
- **`.enabled()` at activation, not a check in `onUpdate`.** By `onUpdate` the
  gesture has already *won* the touch; bailing out there leaves the pager holding
  a drag it refuses to act on, and the content underneath never receives it
  (§6.5).
- **Group isolation is arithmetic, not a rule.**
  `next = Math.max(0, Math.min(count - 1, next))`. There is no code path that can
  page out of a group. Past either end it rubber-bands at 0.28 resistance — the
  boundary should feel like a wall you can lean on, not a crash.

Card dragging is constrained the same way
([DraggableCard.tsx](src/components/DraggableCard.tsx)): the drag translates on
**X only** and the landing slot is clamped to `[0, count-1]` of that group.
Vertical finger movement is ignored outright, so a card cannot be dragged into
another row *even if the finger leaves it*. Cross-group moves exist solely behind
the 3-dot menu, which makes them always deliberate — this was an explicit product
requirement, to prevent accidental reorganization.

### 5.2 Page counts must come from content, never from layout

The original implementation computed:

```
total = ceil(contentHeight / (paperWidth × 1.414))
```

That is a function of screen width, font size and orientation — **not of the
book**. A 145-page EPUB reported 295, and the number changed when the phone was
rotated.

Research settled what it should be instead. The
[W3C EPUB 3.3 Locators](https://w3c.github.io/epub-specs/epub33/locators/) note
says a reading system should *"calculate one page number for every 1,000 unicode
code points of uncompressed visible-to-the-reader text"* when the publisher
supplies none; Adobe Digital Editions uses 1024 for the same purpose. Crucially,
EPUB can carry **real print page numbers**: EPUB 3 in a
`<nav epub:type="page-list">`, EPUB 2 in the NCX `<pageList>`. A book reporting
145 pages almost certainly declares them.

The resulting two-tier rule, in
[pagination.ts](src/renderers/webview/pagination.ts):

1. **The publisher's `page-list` wins.** Parsed during unpacking; each entry
   becomes an invisible `<span class="sr-pb" data-page="…">` anchor at the
   referenced position. The viewer reports the last anchor scrolled past, giving
   the book's true page number — including roman numerals in front matter, which
   is why `PagePosition` carries a `label` and not just a number.
2. **Otherwise, characters.** `ceil(chars / 1000)` for prose,
   `/1800` for DOCX (a Word page holds more text than a paperback page).

Counts are computed from *extracted text during parsing*, before anything
renders. So a page count cannot depend on screen size, font, or orientation —
and rotating the phone no longer changes the total.

---

## 6. Problems encountered, and what each one changed

The heart of this document. Each entry is a real failure with the fix that
followed and, where it matters, the general lesson.

### 6.1 The 23-minute build failure — clang killed on a low-memory machine

**Symptom.** `clang++: error: clang frontend command failed due to signal
(use -v to see invocation)`, after 23 minutes. Reads like a corrupt toolchain.

**Cause.** An 8 GB machine with ~2.5 GB actually free. Gradle's defaults compile
**four ABIs in parallel**, each spawning its own Kotlin daemon. Peak memory
exceeds what is available and the OS kills a compiler process mid-compile.

**Fix** — `android/gradle.properties`:

```properties
reactNativeArchitectures=arm64-v8a          # your phone only; ~4× less work
org.gradle.parallel=false                   # bound peak memory
org.gradle.jvmargs=-Xmx3072m -XX:MaxMetaspaceSize=768m
kotlin.compiler.execution.strategy=in-process
```

**Result: 23m13s FAILED → 3m47s SUCCESS.**

**Lesson.** A compiler crashing on a machine that builds other things fine is
almost always resource exhaustion, not a broken toolchain. Check free RAM first.

### 6.2 A masked exit code — I reported a build as successful when it had failed

**What happened.** I piped Gradle through `tail` to shorten output. In a pipeline
the shell reports the **last** command's status, so `tail` succeeding masked
Gradle failing. The harness showed exit 0 on a FAILED build, and I told the user
the build had succeeded.

**Fix.** Redirect to a file and check the real code:

```bash
./gradlew assembleDebug > build.log 2>&1; echo "EXIT: $?"
tail -40 build.log
```

**Lesson.** Never let a pipeline stand between you and an exit code you are about
to report on. This one is in the playbook as its own numbered section
([§10](docs/RN_ANDROID_SETUP.md)) because the failure mode is *reporting a false
success*, which is worse than any build error.

### 6.3 Files vanished after a force-quit — a silent persistence failure

**Symptom, as reported.** *"When I add files and close the app, remove it from
recent apps and reopen it, the files are gone."*

**Cause — and it is a nasty one.** The index write used the classic atomic
pattern: write a temp file, then `moveSync` it over the real one. On Android
`moveSync` throws `NoSuchFileException` **naming the destination** when that
destination does not yet exist — even with `overwrite: true`, and even after
explicitly calling `create()` on it.

So on a fresh install **the very first index save could never succeed**. Nothing
crashed; the exception was caught and logged. The library lived only in memory
and looked perfectly fine — until relaunch, when `pruneOrphans()` correctly
observed that no index referenced those files and **deleted them**. A safety
mechanism amplified a silent write failure into data loss.

**Fix** ([library.ts:69-88](src/storage/library.ts#L69-L88)) — write the real
index first, then a `.bak` copy:

```ts
try {
  if (!INDEX_FILE.exists) INDEX_FILE.create({ overwrite: true })
  INDEX_FILE.write(json)            // truncate-and-write in one call
} catch (err) { console.warn(...); return }

try {                                // best-effort second copy
  if (!INDEX_BACKUP.exists) INDEX_BACKUP.create({ overwrite: true })
  INDEX_BACKUP.write(json)
} catch { /* primary already landed; a missing backup is acceptable */ }
```

`loadLibrary` now *recovers* from `.bak` instead of overwriting it. A crash can
destroy at most one of the two copies.

**Lessons.** Two, both general:
- A caught-and-logged write failure is invisible on a phone. Persistence needs a
  test that actually kills the process.
- Cleanup routines are force multipliers for bugs upstream of them. `pruneOrphans`
  was correct and still caused the damage.

**Superseded — the index is a SQLite database now (P3-2).** The `.bak` copy and
the truncate-and-write above are gone; WAL gives real journalled, atomic commits
instead, which is what the `moveSync` pattern was reaching for and could not have
on this platform. The incident is kept here in full because the *lessons* are
what matter, and both were acted on rather than merely noted:

- The write path no longer swallows failures. `applyDiff` throws, `saveLibraryNow`
  logs it as an **error**, and — the part that actually protects the user — the
  shadow copy of what is on disk is left unchanged, so the next save retries the
  same rows instead of assuming they landed.
- `pruneOrphans` now refuses to run on an empty library. That is a direct guard
  against this exact incident recurring by a new route: a database that fails to
  open yields an empty library indistinguishable from a fresh install, and
  pruning against it would delete every file on disk. Skipping costs disk space
  that is already wasted; running costs the library.

### 6.4 The PDF was completely unresponsive

**Symptom.** *"When I open the PDF, it is not responsive and I cannot scroll."*

**Cause.** A `Pressable` wrapping the pager (there to toggle chrome on tap) was
swallowing every touch before the PDF view saw it.

**Fix.** Replace it with `Gesture.Tap().maxDuration(250).maxDistance(10)`,
composed via `Gesture.Simultaneous`. A tap gesture fires only on a *clean* tap,
so drags and scrolls still reach the renderer underneath.

**Lesson.** `Pressable` is a touch sink. Over anything scrollable, use a tap
gesture composed simultaneously instead.

### 6.5 A zoomed PDF could not be panned

**Symptom.** *"When I zoom in on a PDF page I am unable to move through the page
— it moves too little."*

**Cause.** `zoomed` was checked inside `onUpdate`. Too late: the pan gesture had
already won the touch, so returning early left the pager holding a drag it
refused to act on, and the PDF view never received it. The page felt nailed down.

**Fix.** Lock at *activation*: `.enabled(!isZoomed && !seeking)`. The gesture
never competes in the first place, so the PDF's own pan gets the touch cleanly.
This required mirroring zoom into React state as well as a shared value, because
`enabled()` is read when the gesture is constructed rather than per-frame on the
UI thread.

**Lesson.** In gesture-handler, *whether to compete* and *what to do once
competing* are different decisions made at different times. A predicate that
decides participation belongs in `.enabled()`.

### 6.6 Metro unreachable from the phone

**Symptom.** App installs, launches, then cannot download the JS bundle.

**Cause.** Metro advertised `192.168.56.1` — a **VirtualBox host-only adapter**,
not the real LAN address. The phone has no route to it.

**Fix.** Sidestep IP resolution entirely with a reverse tunnel over ADB:

```bash
adb reverse tcp:8081 tcp:8081
```

The phone then reaches Metro on its own `localhost`. This works over both USB and
Wi-Fi debugging, and is immune to whatever virtual adapters exist.

Related, from wireless ADB setup: **the pairing port and the connect port are
different**. `adb pair` uses the port shown in the phone's pairing dialog;
`adb connect` needs the other one, found via `adb mdns services` (look for
`_adb-tls-connect._tcp`).

### 6.7 `expo prebuild` silently discarded the Gradle tuning

**Symptom.** After a config change and a re-prebuild, builds were slow again and
then failed exactly as in §6.1.

**Cause.** `expo prebuild` regenerates `android/` from scratch. Hand edits to
`gradle.properties` are gone without a warning.

**Fix.** Make the tuning reproducible rather than remembered —
[scripts/tune-gradle.mjs](scripts/tune-gradle.mjs), wired into the npm script:

```json
"prebuild": "expo prebuild --platform android && node scripts/tune-gradle.mjs"
```

**Lesson.** Any hand edit inside a generated directory needs to be a script, or
it is a bug waiting for the next regeneration.

### 6.8 Missing `platforms;android-36`

The build needs that **exact** API level. Gradle downloaded it mid-build, but the
run still failed — the toolchain had already resolved paths without it. Re-running
succeeded. Worth pre-installing rather than diagnosing again.

### 6.9 A vulnerable spreadsheet parser that npm cannot fix

`xlsx@0.18.5` on npm is **abandoned** and carries a high-severity prototype
pollution advisory that triggers **when reading a file** — precisely this app's
use case, on files that arrive from outside.

npm has no fixed version. SheetJS moved distribution off npm entirely.

**Fix** — install from the vendor's own CDN:

```json
"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
```

**Lesson.** `npm audit` reporting "no fix available" can mean *npm* has no fix,
not that none exists. For a library that parses untrusted input, check upstream
directly.

### 6.10 The infinite render loop — the same trap, twice

**Symptom.** Opening any file produced *"The result of getSnapshot should be
cached to avoid an infinite loop"* followed by *"Maximum update depth exceeded"*.

**Cause.** One innocuous-looking selector in
[ReaderScreen.tsx](src/screens/ReaderScreen.tsx):

```ts
const toc = usePageNav((s) => (current ? (s.toc[current.id] ?? []) : []))
```

`?? []` allocates a **new array on every call**. Zustand compares by reference,
sees a different value each render, re-renders, allocates again.

**Fix** — a shared constant plus `useMemo`, so "no chapters" is always the same
reference:

```ts
const EMPTY_TOC: TocEntry[] = []
const tocRaw = usePageNav((s) => (current ? s.toc[current.id] : undefined))
const toc = useMemo(() => tocRaw ?? EMPTY_TOC, [tocRaw])
```

Every other selector was then audited; the only other candidate is in
`store/selectors.ts` and is safe because it is wrapped in `useShallow`.

**Lesson, and it is uncomfortable.** This exact gotcha is documented in the
desktop project's own notes, and I copied that warning into the plan for this
port at the start — then walked into it anyway. A written-down rule does not
enforce itself. The durable fix is structural: `EMPTY_TOC` exists so the empty
case *cannot* allocate, and `store/selectors.ts` now carries the rule as a module
docstring where the code lives, not only in a plan.

### 6.11 Smaller ones, each worth a minute

| Problem | Cause | Fix |
|---|---|---|
| Text overlapped the status bar | Reader drew to the full screen | `useSafeAreaInsets()` as margins on the renderer |
| Reanimated strict-mode warning | Shared value written inside a `setState` updater — React may re-run updaters during render | Moved into a `useEffect` |
| `TS1005` in `viewerHtml.ts` | A backtick inside a CSS comment terminated the template literal | Reworded the comment |
| 25 cascading parse errors | `*/*` inside a block comment closed it early | Reworded the comment |
| `fontWeight: '650'` rejected | Not a valid RN weight | `'600'` |
| Stack overflow on large images | `String.fromCharCode(...)` spread over a 32 KB chunk exceeds the argument limit | `CHUNK` 0x8000 → 0x2000 — see §6.12 |
| Dates showed as `45306` | Cells read with `raw: true` | `cellDates: true` + `raw: false` → `15/01/2024` |

### 6.12 A fix applied to one copy of duplicated code

**What happened.** The stack-overflow fix in §6.11 changed `CHUNK` from `0x8000`
to `0x2000` in `epub.ts` — but `toBase64` exists **twice**, and the copy in
`prepare.ts` kept the unsafe value. CBZ and ZIP previews run through that second
copy, so the crash was still reachable through a large comic page. It survived
undetected because the EPUB path was the one being tested at the time.

Found later while re-reading the source to write this document, and fixed then:
both copies are now `0x2000`, with a comment on each explaining *why* 8 KB, so
neither gets "optimized" back to a larger chunk by someone assuming bigger is
faster.

Two stale comments were corrected in the same pass — `paths.ts` and the module
docstring in `library.ts` both still described the temp-then-rename write that
§6.3 abandoned, which told the next reader the opposite of the truth.

**Lessons.**
- Duplicated logic means a bug fix is only ever *half* applied. `grep` for the
  function name, not just the file you were debugging in.
- A comment describing an abandoned approach is worse than no comment: it is an
  active invitation to reintroduce the bug. Deleting dead code without also
  fixing the prose around it leaves the trap in place.

**Follow-up: the duplication itself is now gone.** Syncing the two copies fixed
the symptom and left the cause, and they drifted again — `mimeForImage` was
duplicated alongside `toBase64`, and the two versions diverged: the EPUB copy
handled SVG but not AVIF, the archive copy AVIF but not SVG, so an AVIF cover in
an EPUB was served as `image/jpeg`. Both now live once in
[bytes.ts](src/renderers/webview/bytes.ts), with tests pinning the chunk size and
the type table. `IMAGE_RE` was deliberately *not* merged: it excludes SVG in the
archive path on purpose, and sharing it would have quietly widened what a CBZ
may contain.

---

### 6.13 A regex that typechecks and takes the viewer down

**What happened.** While adding a scheme check to the Markdown link renderer, the
regex was written the obvious way: `/^(javascript|vbscript|data:text\/html)/`.
`npx tsc --noEmit` passed. The emitted viewer was broken.

The viewer is one large template literal, so TypeScript processes the text before
the browser ever sees it and consumes every single backslash. The browser
received `/^(javascript|vbscript|data:text/html)/` — an unterminated regex
literal, a syntax error, and a viewer that renders nothing at all. The same pass
turned `/[ - ]/` into a literal character range.

This is invisible to every gate the project had. The type checker validates the
*string*; a string containing broken JavaScript is a perfectly good string. It
would have failed on device, silently, as a blank page.

**Fixed** by doubling every backslash — which is why existing code in that file
looks over-escaped (`/^\s*$/`, `/\r\n?/g`) — and, more usefully, by
making it catchable: `viewerHtml.test.ts` renders the viewer, extracts the
`<script>` block, and runs it through `new Function`. Reintroducing the single
backslash was confirmed to fail that test while `tsc` still passed.

**Lessons.**
- A template literal containing a program needs its own gate. Typecheck proves
  nothing about code inside a string.
- When a comment convention (backticks around identifiers) collides with the
  syntax of the file, the convention loses — backticks in that file terminate
  the literal outright.

---

## 7. Known gaps

Stated plainly, because they are the honest edges of the current build.

### 7.1 Large illustrated EPUBs — solved, but not the way this section planned

**The original plan here was wrong, and the way it was wrong is worth recording.**

The problem was real: an entire EPUB was assembled into one HTML string with
every image inlined as base64 and pushed across the bridge. A 2 MB image becomes
~2.7 MB of string, duplicated on both sides — roughly triple the underlying
size, which is what exhausted memory on a large illustrated book.

The approved plan was to extract to `cache/stackread-view/<fileId>/` and point
the WebView at a file, with `allowingReadAccessToURL` scoped to that one
directory. It was deliberately deferred as security-relevant, which was the
right instinct — and deferring it is what gave the platform check time to
happen.

**`allowingReadAccessToURL` is iOS and macOS only.** It appears on those prop
interfaces in `react-native-webview` and nowhere else. Android's only equivalent
is `allowFileAccess={true}`, which is **not scoped to anything**: it grants the
WebView read access to the whole app sandbox. For a viewer whose entire job is
rendering untrusted EPUB content, that is a much worse posture than §4
established, and it is emphatically not what the plan above was approved on.
`WebViewAssetLoader` (androidx.webkit) is the correct scoped Android mechanism,
but `react-native-webview` does not expose it, so it would mean patching or
forking the library's Java.

**What was implemented instead: blob URLs.** Markup carries an opaque token in
`data-sr-img`; the bytes travel separately and the viewer turns each into a
`blob:` URL. The browser then holds binary and decodes lazily, the HTML string
stays proportional to the *text*, and images are encoded one at a time only as
they are delivered — so a book closed after two pages never pays for
illustrations nobody reached.

Crucially, `allowFileAccess`, `allowFileAccessFromFileURLs` and
`allowUniversalAccessFromFileURLs` **all remain false**. The viewer still cannot
reach the filesystem at all, so §4's posture is untouched and
`isInsideLibrary()` correctly stays absent — there is no file access for it to
guard.

Applied to all three image paths, not just EPUB: books, CBZ comics (the most
image-heavy format the app opens) and ZIP previews.

**Two lessons.**

- *Verify a platform capability before building a plan on it.* This plan sat in
  this document as "approved" for a long time, and every reading of it assumed
  the mechanism existed. Checking cost one grep of a `.d.ts` file.
- *A near-miss worth recording:* `prepareCache.sizeOf()` measured
  `content.length`. With images moved out of `content`, a 20 MB illustrated book
  would have reported as a few hundred kilobytes — so the byte budget would have
  admitted several of them and reproduced the exact memory exhaustion this work
  set out to fix. Caught while wiring it up; pinned by three tests now. Moving
  data out of a structure silently breaks whatever was measuring that structure.

### 7.2 Others

- TIFF is mapped but unsupported; its cards show a "soon" pill. This is
  deliberate: the extension is *known* so an import is rejected with a real
  format name and badge, rather than falling through as an unrecognised file.
  `SUPPORTED_EXTENSIONS` therefore means "known", not "renderable" — a
  distinction pinned by a test, because it reads like a bug otherwise.

---

## 7.3 Release configuration

The dev build and the shippable build want opposite things, and for a long time
only the dev half existed. Both are now driven by scripts, because every one of
these failures is invisible in the artefact itself — a wrong build installs and
runs perfectly on the machine that made it.

- **ABIs and minification.** `scripts/tune-gradle.mjs` takes a `--release` flag:
  dev keeps `arm64-v8a` and no R8 (a low-memory machine cannot afford more —
  §6.1), release restores all four ABIs and turns on minification and resource
  shrinking. R8 keep rules for Reanimated, gesture-handler, pdfium, MMKV/Nitro
  and the WebView bridge are written unconditionally, since those libraries
  resolve classes from native code where R8 cannot see the reference.
- **Signing.** Passwords are read from the environment, never written to
  `android/gradle.properties`. That file is plaintext, must be readable by
  Gradle, and sits in a directory that is easy to commit — and a leaked signing
  password cannot be rotated, only replaced by a new key that orphans every
  installed copy. `credentials/` is gitignored apart from its README.
- **`versionCode` lives in `app.json`.** In generated `android/` it is reset to
  1 by every prebuild, which would make updates impossible to publish.
- **Permissions.** `SYSTEM_ALERT_WINDOW` (from React Native's *debug* manifest)
  and `READ`/`WRITE_EXTERNAL_STORAGE` (from `expo-file-system` and
  `react-native-blob-util`) are blocked via `android.blockedPermissions`, which
  emits `tools:node="remove"`. The app uses none of them: files arrive through
  SAF, which needs no permission. A file reader asking to draw over other apps
  reads as malware.
- **`allowBackup` is false.** The default would auto-upload the user's entire
  library to their Google Drive with no consent prompt.
- **`npm run apk` refuses to build** when any of this is wrong; `npm run apk:dev`
  is the escape hatch for a local build that is not going to ship.

---

## 7.4 Testing

There is now a small suite (`npm run check` = typecheck + `node --test`), run on
Node's own test runner with `--experimental-strip-types` — no Jest, no
transform, no new dependency. It covers only pure logic, which is the part that
needs no device: the sanitiser, pagination and TOC parsing, and the format
table.

The most valuable file in it is `viewerHtml.test.ts`, and the reason is §6.13:
`tsc` cannot see inside a template literal, so it will happily pass a viewer
whose JavaScript does not parse. That test renders the viewer and runs the
emitted script through `new Function`, which is the only cheap check that
catches it.

On-device testing is still required for everything else — and, per §6.3, a
persistence change is only verified by force-quitting from recents.

---

## 8. Build and memory notes

- `npm run check` is the gate before any reload: `tsc --noEmit` plus
  `node --test`. Typecheck alone misses a whole class of break in
  `viewerHtml.ts`, where the browser program is a template literal and every
  backslash must be doubled to survive TS — a single-escaped regex passes
  typecheck and takes the viewer down at runtime.
- **JS-only changes arrive over Fast Refresh** — no rebuild. Everything in §6
  after the native setup was delivered this way.
- A native rebuild is required only when adding/removing a native module,
  changing `app.json` plugins or the package name, or upgrading the SDK. See
  [RN_ANDROID_SETUP.md §16](docs/RN_ANDROID_SETUP.md).
- Memory discipline in the pager: **only the active file is mounted**, so
  memory stays flat regardless of group size
  ([HorizontalPager.tsx:201](src/components/HorizontalPager.tsx#L201)).
  Neighbours were mounted originally, for an instant page turn, and that proved
  untenable on a real device: three PDFs meant three pdfium documents and their
  render threads, and unmounting one mid-render crashed inside `FPDF_LoadPage`;
  three EPUBs meant parsing and base64-encoding three whole books at once. The
  pager's translation still animates, so the swipe is unchanged — only the
  incoming document now loads on arrival.
