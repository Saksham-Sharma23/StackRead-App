# StackRead

An Android reader built around a **2-D board** instead of a file list.

- The **horizontal** axis is a *group* — a row of related files.
- The **vertical** axis is the stack of groups.
- Opening a file gives you **vertical scroll to read** and **horizontal swipe to
  move to the next file in the same group**.

That last part is the point. Reading a paper alongside its three references means
putting them in one group and swiping between them, rather than juggling four
windows.

```
                    ← one group: a row of related files →
   ┌────────────────────────────────────────────────────────────┐
 ↑ │  Thesis refs   [ paper.pdf ][ ref1.pdf ][ ref2.epub ][ + ] │
 │ ├────────────────────────────────────────────────────────────┤
 │ │  Comics        [ vol1.cbz  ][ vol2.cbz ][ + ]              │
 ↓ ├────────────────────────────────────────────────────────────┤
   │  Manuals       [ specs.docx ][ data.xlsx ][ + ]            │
   └────────────────────────────────────────────────────────────┘
```

A group is a **logical tag, never a folder** — moving a file between groups
changes one field and never touches disk.

This is a React Native port of a desktop (Electron) app of the same name. The
desktop source is not part of this repository; where a decision here follows or
deliberately departs from it, [DETAIL.md](DETAIL.md) records which and why.

---

## Features

**Library**
- Groups as rows, files as cards, in a scrollable 2-D board
- Import via the system picker; files are **copied into app storage**, so the
  library cannot break when the original is moved or deleted
- Full-text search over filenames (SQLite FTS5), with paging past the first page
- Long-press-drag a card to reorder it **within its own row**
- Move between groups from the card's 3-dot menu — always deliberate, never
  accidental
- Thumbnails for images, rasterised covers for PDFs, format badges otherwise
- Reading-progress bar on every card
- Delete with a 5-second undo
- Export / import the entire library as a single `.zip`

**Reader**
- Scroll to read, swipe to change file; pinch to zoom in PDFs, images and
  documents (paging locks out while zoomed, so panning never flips the page)
- Auto-hiding chrome — tap to bring it back
- **File** and **Group** dropdowns in the top bar
- Draggable scroll indicator for seeking to any page
- **Chapters** (☰) for books that declare a table of contents
- **Display** (Aa) — font size, line spacing, margins, and four themes
  (light / sepia / dark / black), remembered across sessions
- In-document search, including PDF text search via pdfium
- Position remembered per file

## Supported formats

| | |
|---|---|
| Documents | PDF, EPUB, DOCX, HTML, Markdown, TXT, LOG |
| Spreadsheets | XLSX, XLS, CSV, TSV — with column letters and row numbers |
| Images | PNG, JPG, GIF, WEBP, AVIF, BMP, HEIC, HEIF |
| Archives | CBZ (comics), ZIP (browsable listing) |

EPUB page numbers come from the **publisher's own page list** where the book
declares one, so a 145-page book reports 145. Only when a book declares nothing
does it fall back to the W3C convention of ~1,000 characters per page.

---

## Requirements

- **Node.js 24.x** (developed on 24.20.0)
- **Android SDK** with `platforms;android-36` and `build-tools;36.0.0`
- **JDK 17**
- A physical Android device with USB or wireless debugging enabled

> **Expo Go will not work.** This app uses five native modules that are not in
> the Expo Go binary — MMKV, PDF, WebView, Reanimated and gesture-handler. You
> need a custom dev client, which the steps below build.

---

## Getting started

```bash
npm install

# One-time: build and install the dev client on a connected device.
# ~4 minutes on a tuned setup; see the note below if it takes 20+.
npm run prebuild
npm run android
```

Then, for day-to-day work:

```bash
adb reverse tcp:8081 tcp:8081   # so the phone can reach Metro
npm start
```

Once the dev client is installed, **JS changes arrive over Fast Refresh** — no
rebuild needed. A native rebuild is required only when adding or removing a
native module, changing `app.json` plugins or the package name, or upgrading the
Expo SDK.

### Connecting a phone wirelessly

On the device: *Developer options → Wireless debugging → Pair device with pairing
code*.

```bash
adb pair 192.168.x.x:PAIRING_PORT     # port from the pairing dialog
adb connect 192.168.x.x:CONNECT_PORT  # a DIFFERENT port — see below
adb reverse tcp:8081 tcp:8081
```

The pairing port and the connect port are **not the same**. Find the connect port
with `adb mdns services` and look for `_adb-tls-connect._tcp`.

Full walkthrough: [docs/CONNECT_PHONE.md](docs/CONNECT_PHONE.md).

### If the build is slow or clang crashes

On a machine with limited free RAM, Gradle's defaults (four ABIs in parallel,
separate Kotlin daemons) exhaust memory and clang is killed mid-compile — a
~23-minute failure that reads like a broken toolchain.

`npm run prebuild` applies the fix automatically via
[scripts/tune-gradle.mjs](scripts/tune-gradle.mjs). To apply it to an existing
`android/` directory:

```bash
npm run tune-gradle
```

This builds `arm64-v8a` only, which is right for development and **wrong for a
release APK**. `npm run apk` restores all four ABIs; so does CI.

---

## Scripts

| | |
|---|---|
| `npm start` | Metro, dev-client mode |
| `npm run android` | Build, install and launch on a connected device |
| `npm run prebuild` | Regenerate `android/`, then re-apply the Gradle tuning |
| `npm run check` | **The gate before any reload** — typecheck plus tests |
| `npm run typecheck` | `tsc --noEmit` alone |
| `npm run test` | Node's own test runner, no Jest and no transform |
| `npm run apk` | Release APK, refusing to build if signing or config is wrong |
| `npm run apk:dev` | Local release build that is not going to ship |
| `npm run doctor` | `expo-doctor` |
| `npm run tune-gradle` | Re-apply low-memory Gradle settings on their own |

`npm run typecheck` alone is **not** sufficient. The WebView viewer is one large
template literal, so the type checker validates the *string* and cannot see a
syntax error in the JavaScript inside it —
[viewerHtml.test.ts](src/__tests__/viewerHtml.test.ts) parses the emitted script,
which is the only thing that catches that class of break before the device does.

The suite is **376 tests** on Node's own runner — no Jest, no transform, no
mocking framework. `tsconfig` runs with `strict`, `noUnusedLocals` and
`noUnusedParameters`.

### Dev tools

Not wired to npm scripts — they take an argument and are run directly.

```bash
# A test library covering every supported format, as real archives rather than
# stubs, so importing it exercises the actual parsers. Each file carries a
# unique marker token, so a search result maps to exactly one document.
node scripts/make-test-library.mjs ./testlib

# What the app's own parser sees in an EPUB: OPF path, manifest and spine
# counts, the NCX navMap, and how many `pageList` targets the book declares.
node scripts/inspect-epub.mjs "./testlib/Orbital Silence.epub"
```

`inspect-epub` answers the question that comes up whenever a book reports a
surprising page count: page counts come from content rather than layout, and the
first tier is the publisher's own page list — so the useful thing to know is
whether the book declares one at all.

### Measuring performance

`__DEV__`-gated instrumentation prints four lines to Metro:

```
[perf] startup   bundle-eval Xms · store-hydrate Yms → first-paint Zms
[perf] prepare   epub 4.2MB [user] → read · cross · unzip · assemble = Tms
[perf] viewer    boot Xms → ready Yms · N batches · M images
[perf] longtask  measure() Xms over N anchors
```

Read them from a **release** build (`npm run apk:dev`), never `npm run android`
— debug numbers are 3–8× off.

---

## Tech

Expo SDK 57 · React Native 0.86 (New Architecture) · React 19 · TypeScript 6 ·
Reanimated 4 + worklets + gesture-handler · Zustand · MMKV · SQLite (WAL +
FTS5) · `react-native-pdf` · `react-native-webview` · fflate · mammoth ·
SheetJS.

Two renderer families, not eleven renderers: a **native fast path** for PDF and
images, and **one WebView host** for everything HTML-ish. Adding a format means
writing one function in
[src/renderers/webview/prepare.ts](src/renderers/webview/prepare.ts) — no native
module, no new component, no change to the pager. Six of the eleven formats were
added that way.

Byte-level work (unzip, base64) runs on **two worklet runtimes** off the JS
thread — one for the file you opened, one for speculative prefetching, so a
large prefetch cannot queue ahead of your own document.

## Project layout

```
src/
  components/   board cards, pager, sheets, scroll indicator
  screens/      LibraryScreen (the board) · ReaderScreen (full-screen)
  renderers/    PdfRenderer · ImageRenderer · WebViewRenderer
    webview/    prepare · epub · pagination · sanitize · viewerHtml
                offload (worklets) · prepareCache · diskCache · prefetch
  storage/      SQLite index, file import, paths, thumbnails, backup
  store/        Zustand stores + MMKV-backed hot state
  ui/           theme, motion, perf instrumentation
  __tests__/    pure-logic tests, run by Node's own runner
modules/
  pdf-text/     Expo module bridging pdfium's text and search API
scripts/        build tuning, release signing, dev tools
```

## Shipping an APK

**On GitHub Actions** (recommended — a four-ABI release build needs more memory
than most laptops have spare):

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The signed APK is attached to a GitHub Release. Setup and secrets:
[docs/CI_RELEASE.md](docs/CI_RELEASE.md).

**Locally:**

```bash
npm run apk
# -> android/app/build/outputs/apk/release/app-release.apk
```

That one file is the whole app — send it to anyone. Unlike the dev client, a
release build has the JavaScript bundled inside it and needs no computer running
Metro. Full guide, including what to tell people about Android's sideloading
warnings: [docs/BUILD_APK.md](docs/BUILD_APK.md).

Release builds are signed with `credentials/stackread-release.keystore`. **Back
that file up** — lose it and you can never update an installed copy. The keystore
currently in the repo uses a placeholder development password; replace it before
publishing anything, while `versionCode` is still 1.

### Download size

| | |
|---|---|
| Universal APK (all four ABIs) | ~120–160 MB |
| Play Store AAB — what a user downloads | ~45–60 MB |

pdfium and Hermes + React Native dominate; the JavaScript bundle is a small
fraction. The CI workflow can build either.

## Where your files go

Everything lives in app-private storage, which is **not reachable by a file
manager** without root:

```
/data/data/com.stackread.app/
├── files/library/<id>.<ext>       your file, copied in under a generated id
├── files/library/<id>.thumb.jpg   its cover
├── databases/stackread.db         the index (WAL + FTS5)
└── cache/stackread-prepared/      parsed-document cache; disposable
```

The directory is flat — a group is a column in the index, not a folder. Your
original filename is kept as display metadata only.

## Known gaps

- The library index is SQLite with WAL. `library.json` is still the portable
  format an export contains, and a pre-SQLite install is migrated once on first
  launch.
- Nothing reconciles the index against disk. If the files are removed
  out-of-band (which needs root), a card renders normally and only fails when
  opened.
- The test suite covers pure logic only. Anything involving a native module
  still needs on-device verification, and a persistence change is only verified
  by force-quitting from recents.
- TIFF is recognized but not yet renderable.
- DOCX, spreadsheets and ZIP archives show a format badge rather than a cover;
  reaching one would mean converting the whole document.
- No crash reporting yet — [TASKS2.md](TASKS2.md) R7.

Current audit findings: [AUDIT3.md](AUDIT3.md).

## License

See [LICENSE](LICENSE).
