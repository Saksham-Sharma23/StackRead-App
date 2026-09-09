@AGENTS.md

# StackRead — Android

React Native port of a desktop (Electron) file reader. Full project history in
[DETAIL.md](DETAIL.md) · usage and build in [README.md](README.md) · platform
setup in [docs/RN_ANDROID_SETUP.md](docs/RN_ANDROID_SETUP.md) · audits in
[AUDIT.md](AUDIT.md), [AUDIT2.md](AUDIT2.md), [AUDIT3.md](AUDIT3.md) · the work
queue in [TASKS.md](TASKS.md) and [TASKS2.md](TASKS2.md).

This file is the **operational reference**: what the app is, how it is built,
the rules that cost real debugging time, and where each thing lives. It does not
repeat DETAIL.md's incident-by-incident record — it links to it.

---

## 1. What it is

A reader organised as a **2-D board** instead of a file list.

```
                    ← horizontal: one group (a row of related files) →
   ┌──────────────────────────────────────────────────────────────────┐
 ↑ │  Thesis refs   [ paper.pdf ][ ref1.pdf ][ ref2.epub ][ + ]       │
 │ ├──────────────────────────────────────────────────────────────────┤
 v │  Comics        [ vol1.cbz  ][ vol2.cbz ][ + ]                    │
 e ├──────────────────────────────────────────────────────────────────┤
 r │  Manuals       [ specs.docx ][ data.xlsx ][ + ]                  │
 t └──────────────────────────────────────────────────────────────────┘
```

Opening a file gives **vertical scroll to read** and **horizontal swipe to move
between files in the same group**. Reading a paper alongside its references
means putting them in one row and swiping, rather than juggling windows.

A **group is a logical tag, never a folder** (`FileEntry.groupId`). Moving a
file between groups is a one-field change and never touches disk. **Do not
introduce a directory-per-group anywhere** — a move must never be an operation
that can fail halfway.

---

## 2. Stack

Expo SDK 57.0.18 · RN 0.86.3 (New Architecture, cannot be disabled) · React
19.2.3 · TypeScript 6 (`strict`, `noUnusedLocals`, `noUnusedParameters`).

| Dependency | Role | Notes |
|---|---|---|
| `react-native-reanimated` 4.5.1 | animation | + `react-native-worklets` 0.10.1 |
| `react-native-gesture-handler` ~2.32 | gestures | pager, cards, sheets |
| `zustand` 5 | state | selectors must return stable refs — §5.1 |
| `react-native-mmkv` 4 (Nitro) | hot state | synchronous, JSI-backed |
| `expo-sqlite` | library index | WAL + FTS5 |
| `expo-file-system` 57 | files | `File`/`Directory`/`Paths` classes |
| `react-native-pdf` | PDF | pdfium; largest dependency (~9 MB) |
| `react-native-webview` 13.16 | all HTML-ish formats | deliberately inert — §5.4 |
| `fflate` | zip | streaming `Unzip` for restore, `unzipSync` in worklets |
| `fast-xml-parser` | EPUB OPF/NCX | **currently in the startup bundle** — AUDIT3 §3.1 |
| `mammoth` | DOCX → HTML | lazy-imported |
| `xlsx` (SheetJS) | spreadsheets | lazy-imported; CDN tarball, not npm |
| `thumbhash` | blurred placeholders | 18 KB |
| `modules/pdf-text` | local Expo module | pdfium text + search |

**Expo Go cannot run this app** — five native modules are absent from it.
Testing means a dev client on a physical device.

---

## 3. How it works

### 3.1 Two renderer families, not eleven renderers

```
 FileRenderer  ──┬── PdfRenderer      (native pdfium)
                 ├── ImageRenderer    (native)
                 └── WebViewRenderer  (everything else)
                          │
                          └── prepare.ts ── switch on format ──> { html, pages }
```

Adding a format is **one function in
[prepare.ts](src/renderers/webview/prepare.ts)**, added to the switch in
`prepareFile()`, plus an entry in [formats.ts](src/storage/formats.ts). No
native module, no renderer component, no change to the pager. Six of the eleven
formats were added this way.

### 3.2 The open path, end to end

```
tap a card
   │
   ├─ prepareCache (memory, S3-FIFO)            hit → straight to render
   ├─ diskCache    (Paths.cache, 120 MB)        hit → deserialize
   │
   └─ miss: prepareFile()
        ├─ read bytes           (JS thread — expo-file-system is native)
        ├─ cross to worklet     (SerializableArrayBuffer; copies — §6.3)
        ├─ unzip / parse        (worklet runtime, off the JS thread)
        ├─ sanitize             (native pass, then again in the viewer)
        └─ assemble HTML
                │
                └─ WebViewRenderer
                     ├─ JSON island   first payload, in the initial HTML
                     └─ injectJavaScript(__srAppend(b64))   later batches
```

**Two worklet lanes** ([offload.ts](src/renderers/webview/offload.ts)): `user`
and `prefetch`. A single runtime processes in order, so opening a file while a
30 MB comic prefetched queued the user's own document behind it. Two runtimes is
the smallest number that removes that head-of-line blocking.

### 3.3 Caching, three tiers

| Tier | Where | Bound | Evicts |
|---|---|---|---|
| `prepareCache` | memory | 24 MB / 6 unpinned entries | S3-FIFO + ghost queue (30) |
| `diskCache` | `Paths.cache` | 120 MB total, 12 MB/entry | oldest first; OS may clear |
| `prefetch` | drives the above | `RADIUS = 1` | — |

The **pinned window** is the current file and its immediate neighbours; pinned
entries are not budgeted. `RADIUS = 1`, the pager's mount window and the pinned
window all agree on ±1 — deliberately, so three subsystems share one number.

### 3.4 Storage layout

```
/data/data/com.stackread.app/
├── files/library/
│   ├── <nanoid>.pdf            the copied file — original name is metadata only
│   ├── <nanoid>.thumb.jpg      generated cover, flat beside its file
│   └── library.json            legacy index; read once on migration, never written
├── files/mmkv/stackread        scroll, progress, zoom, anchors
├── databases/stackread.db      the live index (WAL + FTS5)
└── cache/stackread-prepared/   diskCache; disposable
```

Files are **copied in**, not referenced — the library cannot break when the
original moves. The directory is **flat**: group membership is a column, not a
path. Filenames on disk are generated ids, so a hostile or duplicate original
name can never collide or escape the directory.

### 3.5 The index

SQLite with WAL. `groups` and `files` tables, `files_by_group` index, and an
**external-content FTS5 table** over `files.name` kept in sync by triggers —
not by remembering to update it at each write site, which is the bug class this
project has already been bitten by twice.

Writes are **debounced, diffed and journalled**:
[libraryDiff.ts](src/storage/libraryDiff.ts) hashes each row and emits only what
changed, so a rename does not rewrite the library.

---

## 4. Walkthrough

**Install.** Universal APK ~120–160 MB (all four ABIs, no split config); an AAB
gives users a ~45–60 MB download. pdfium and Hermes+RN dominate; the JS bundle
is a small fraction.

**Add files.** System picker (wildcard MIME — vendor pickers filter unevenly —
then filtered by extension). Each file is copied to `files/library/<id>.<ext>`
and a row is inserted. Covers are rasterised lazily by
[PdfCoverFactory](src/components/PdfCoverFactory.tsx), one at a time, capped at
40/session, prioritising groups on screen.

**Read.** Scroll to read, swipe for the next file in the row. Position is
written to MMKV on settle and to the index only on export.

**Export.** One `.zip`: `library.json` plus `files/`. Restore is
**additive-then-commit** — everything is written before `replaceLibrary`, so a
kill at any point leaves the previous library intact.

**Delete outside the app.** Not reachable without root — the data directory is
app-private and `READ/WRITE_EXTERNAL_STORAGE` are explicitly removed. If it
happens anyway, the card still renders from the index and only fails at open
time; nothing reconciles the index against disk. Known gap, AUDIT3.

---

## 5. Rules that cost real debugging time

### 5.1 Zustand selectors must return stable references

A selector that allocates on every call — `?? []`, `.filter()`, `.map()` — makes
Zustand see a new value each render and re-render forever. React reports it as
**"Maximum update depth exceeded"**, preceded by *"The result of getSnapshot
should be cached"*.

Hit **twice** on this project despite being written down. Both escapes are in
[src/store/selectors.ts](src/store/selectors.ts):

```ts
const groups = useLibrary(useShallow((s) => s.groups))   // compares contents

const raw = usePageNav((s) => s.toc[id])                  // or: raw slice
const toc = useMemo(() => raw ?? EMPTY_TOC, [raw])        // + shared constant
```

Never let the empty case allocate. Use a module-level `EMPTY_*` constant.

### 5.2 Gestures: decide participation in `.enabled()`, not `onUpdate`

By `onUpdate` the gesture has already won the touch. Bailing out there leaves it
holding a drag it refuses to act on, and the content underneath never receives
it — which is what made a zoomed PDF immovable.

In [HorizontalPager.tsx](src/components/HorizontalPager.tsx):
`.activeOffsetX([-24, 24])` · `.failOffsetY([-8, 8])` · `.maxPointers(1)` ·
`.enabled(!isZoomed && !seeking)`. The 24-vs-8 asymmetry is deliberate:
scrolling is used more than paging, so ambiguity must resolve toward scrolling.

Compose with `Gesture.Simultaneous`, never exclusively — an exclusive pager
starves the PDF view's own scroll and pinch.

Never wrap scrollable content in a `Pressable`; it is a touch sink. Use
`Gesture.Tap()` composed simultaneously.

### 5.3 Group isolation is arithmetic, not a rule

`next = Math.max(0, Math.min(count - 1, next))` in the pager; card drags are
X-only and clamped to `[0, count-1]` of their own group. There must be no code
path that pages or drags out of a group. Cross-group moves exist **only** behind
the 3-dot menu — a product requirement, to prevent accidental reorganization.

### 5.4 The WebView is deliberately inert

`originWhitelist: ['about:blank']`, navigation refused, `allowFileAccess={false}`,
`allowFileAccessFromFileURLs={false}`, `allowUniversalAccessFromFileURLs={false}`,
`domStorageEnabled={false}`, `setSupportMultipleWindows={false}`. Content
arrives only via the JSON island and `injectJavaScript`; images are `blob:` URLs
built inside the viewer.

**Do not relax any of these without saying so explicitly** — the one planned
exception (scoped `allowingReadAccessToURL` for EPUB extraction) is deferred
precisely so it gets its own review.

**Two sanitiser passes, and both are load-bearing.**
[sanitize.ts](src/renderers/webview/sanitize.ts) (regex, native side) runs
before the content crosses the bridge; `sanitize()` in
[viewerHtml.ts](src/renderers/webview/viewerHtml.ts) (DOM, inside the viewer) is
structurally stronger but runs next to the JS context. Their scope lists agree
deliberately — two sanitisers that disagree about their own scope are worse than
one, because the gap is invisible in both.

**`escapeHtml` on the archive-listing path is not cosmetic.** `TEXT_RE` matches
`.html`, `.js`, `.ts`, `.css` and inlines those entries. Swapping it for
`sanitizeHtml` "for consistency" — which is imported into the same file — turns a
ZIP listing into an injection vector. Pinned by
[archiveText.test.ts](src/__tests__/archiveText.test.ts).

### 5.5 Page counts come from content, never from layout

Deriving pages from rendered height makes the total a function of screen width,
font size and orientation — a 145-page EPUB reported 295 and changed on
rotation.

Two tiers, in [pagination.ts](src/renderers/webview/pagination.ts):

1. The publisher's page list wins — EPUB 3 `<nav epub:type="page-list">`, EPUB 2
   NCX `<pageList>`. Labels can be roman numerals, so `PagePosition` carries a
   `label`, not just a number.
2. Otherwise `ceil(chars / 1000)` (W3C EPUB 3.3 Locators), `/1800` for DOCX.

### 5.6 State is split by update frequency

`store/scroll` is **not a React store** — it is a module-level API over MMKV,
because it is written on every scroll settle. Putting hot state in Zustand
re-renders the pager on every tick.

`store/pageNav` is keyed **per fileId** because the pager keeps several
renderers mounted; a renderer must `forget()` on unmount.

The library store is **normalized** (`filesById` + `groupOrder`), with
`fileCount` and `pdfsNeedingCovers` maintained incrementally — recomputing them
walked every file on every keystroke of a rename.

### 5.7 Persistence must be verified against a process kill

`moveSync` on Android throws `NoSuchFileException` **on the destination** when it
does not exist, even with `overwrite: true` and even after `create()`. The
temp-then-rename pattern is unusable here.

The original failure was silent: writes were caught and logged, the library
looked fine in memory, and `pruneOrphans()` deleted the files on next launch.
If you touch persistence, **test by force-quitting from recents** — not by
reloading. Full account in [DETAIL.md §6.3](DETAIL.md).

`pruneOrphans` **never runs on an empty library.** "The index says no files" and
"the index failed to load" are indistinguishable, and pruning on the second
deletes everything. The walk is chunked at 8 ms and re-checks that interlock
*every slice*, because it yields and the library can empty mid-walk.

### 5.8 The splash hands off to a window, not to React

Three colours have to agree or launch flashes. `expo-splash-screen` paints
`windowSplashScreenBackground`; when it hides, the activity shows `AppTheme`'s
`android:windowBackground`; only then does React paint.

`Theme.AppCompat.DayNight` defaults that middle layer to **white**, so a
dark-themed app flashes white between the splash and the first frame — and
holding the splash longer makes it *more* visible. The fix is
`android.backgroundColor` in [app.json](app.json), which becomes
`@color/activityBackground`. All three are `#0e1a3b`, sampled from the logo's
own tile because the artwork is not transparent.

`App.tsx` holds the splash until `useLibrary.loaded`, with a 4s failsafe: that
store's `load()` has no rejection path, so gating on the flag alone would turn a
recoverable read error into a launch screen that never leaves.

---

## 6. Problems faced, and what each one changed

Condensed. Each links to the full account.

| Problem | Cause | Fix |
|---|---|---|
| **23-minute build failure** ([§6.1](DETAIL.md)) | 4 ABIs + parallel Kotlin daemons exhausted RAM; clang OOM-killed | [tune-gradle.mjs](scripts/tune-gradle.mjs), dev vs release modes |
| **Reported a failed build as successful** ([§6.2](DETAIL.md)) | piped Gradle through `tail`; shell reports the *last* command's status | **Never pipe a build.** Redirect to a file, `echo $?` |
| **Files vanished after force-quit** ([§6.3](DETAIL.md)) | silent write failure; `pruneOrphans` then deleted the unreferenced files | throw from `applyDiff`, `.bak` copy, empty-library interlock |
| **PDF completely unresponsive** ([§6.4](DETAIL.md)) | `Pressable` wrapping scrollable content — a touch sink | `Gesture.Tap()` composed simultaneously |
| **Zoomed PDF could not be panned** ([§6.5](DETAIL.md)) | pager bailed in `onUpdate`, after already winning the touch | decide in `.enabled()` — §5.2 |
| **`prebuild` discarded Gradle tuning** ([§6.7](DETAIL.md)) | `android/` is generated; hand edits are destroyed | re-apply from scripts, every time |
| **Infinite render loop, twice** ([§6.10](DETAIL.md)) | allocating Zustand selector | `useShallow` + `EMPTY_*` constants — §5.1 |
| **Fix applied to one copy of duplicated code** ([§6.12](DETAIL.md)) | two sanitisers with drifting scope | scope lists made to agree, and said so in both |
| **A regex that typechecks and takes the viewer down** ([§6.13](DETAIL.md)) | the viewer is a template literal; `tsc` validates the *string* | [viewerHtml.test.ts](src/__tests__/viewerHtml.test.ts) parses the emitted script |
| **145-page EPUB reported 295** ([§5.2](DETAIL.md)) | pages derived from rendered height | content-based pagination — §5.5 |
| **Restore could destroy the library** (AUDIT2 §1.1) | delete-then-write, whole archive in memory | streaming, additive-then-commit |
| **Neighbour wrote another file's position** (R5) | warm-cached neighbour reports like any renderer | `activeRef` guard on the three persistence calls |
| **Prune scheduled before the store loaded** (R6) | interlock read an empty `filesById` | schedule after `set()`; pinned by test |

---

## 7. Where things live

```
App.tsx              splash gate, lazy ReaderScreen, root providers
src/
  components/        board cards, pager, sheets, scroll indicator
  screens/           LibraryScreen (board) · ReaderScreen (full-screen)
  renderers/         PdfRenderer · ImageRenderer · WebViewRenderer
    webview/         prepare · epub · pagination · sanitize · viewerHtml
                     offload (worklets) · prepareCache · diskCache · prefetch
  storage/           db (SQLite+FTS5) · files · paths · thumbs · backup
                     library · libraryDiff · lifecycle · formats
  store/             Zustand stores; scroll is MMKV, not React
  ui/                theme · motion · perf · openTransition
  __tests__/         pure logic, Node's own runner — 376 tests
modules/pdf-text/    Expo module bridging pdfium text + search
scripts/             tune-gradle · setup-signing · release-check · dev tools
.github/workflows/   android-release.yml — CI release build
```

**[lifecycle.ts](src/storage/lifecycle.ts) is the one place that knows when a
`file.id` stops being valid.** Every id-keyed cache is cleared through it. If
you add a cache keyed by file id, wire it there — a missing call is invisible
until the id is reused.

---

## 8. Working practice

- **`npm run check` before any reload** — typecheck plus tests. `npx tsc
  --noEmit` alone is not sufficient: the viewer is a template literal, so the
  type checker validates the *string* and cannot see a syntax error in the
  JavaScript inside it.
- JS changes arrive over **Fast Refresh**. A native rebuild is needed only for a
  new native module, an `app.json` plugin/package change, or an SDK upgrade.
- **Never pipe a build through `tail`** — the shell reports the last command's
  status, which once masked a FAILED Gradle build as exit 0. Redirect to a file
  and `echo $?`.
- Comments explain **why**, especially where a fix looks arbitrary. A bare
  tuning constant with no rationale will be "cleaned up" by the next reader.
  Prefer deriving a constant from another (`MAX_GHOSTS = 5 * MAX_TAIL_ENTRIES`)
  over a hand-picked number.
- **Repair tests, don't delete them.** Several pinned *spelling* rather than
  behaviour and broke on a rename; each was rewritten to assert the property it
  was actually guarding, with a note saying why the looser match is right.
- Only `arm64-v8a` is built for development. That is wrong for a release APK —
  [the CI workflow](.github/workflows/android-release.yml) builds all four.

### Measuring

`__DEV__`-gated instrumentation in [src/ui/perf.ts](src/ui/perf.ts) emits four
lines:

```
[perf] startup   bundle-eval Xms · store-hydrate Yms → first-paint Zms
[perf] prepare   epub 4.2MB [user] → read Xms · cross Yms · unzip Zms · assemble Wms = Tms
[perf] viewer    boot Xms → ready Yms · N batches · M images
[perf] longtask  measure() Xms over N anchors
```

**Read them from a release build** (`npm run apk:dev`), never `npm run android`
— debug numbers are 3–8× off and will lie about the size of a win.

### Current state

R0–R6 of [TASKS2.md](TASKS2.md) are complete; **R7 (ship readiness) is open** —
crash reporting, root error boundary, `versionCode` automation. 376 tests pass.

[AUDIT3.md](AUDIT3.md) lists the open findings. The two that matter:

1. **`fast-xml-parser` is in the startup bundle** — `lifecycle.ts` statically
   imports `prefetch.ts`, which drags `prepare → epub → fast-xml-parser` past
   the `lazy(ReaderScreen)` boundary. ~1.4 MB evaluated on every cold start.
2. **The restore path validates shape, not contents** — a hostile
   `library.json` supplies `storedName` values that become filesystem paths.
