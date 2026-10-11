# StackRead

An Android reader that organises files on a **2-D board** instead of a list.

```
                 ← a group: a row of related files →
   ┌──────────────────────────────────────────────────────────┐
 ↑ │  Thesis refs   [ paper.pdf ][ ref1.pdf ][ ref2.epub ][ + ]│
 │ ├──────────────────────────────────────────────────────────┤
 │ │  Comics        [ vol1.cbz  ][ vol2.cbz ][ + ]            │
 ↓ ├──────────────────────────────────────────────────────────┤
   │  Manuals       [ specs.docx ][ data.xlsx ][ + ]          │
   └──────────────────────────────────────────────────────────┘
```

Open a file, **scroll down to read**, and **swipe sideways for the next file
in the same group**. Reading a paper next to its references means putting them
in one row and swiping between them.

## Features

- **Board:** groups as rows, files as cards, drag to reorder, search by name,
  reading progress on every card, delete with undo.
- **Import:** from the file picker, from other apps ("Open with" and "Share"),
  or a whole **folder or ZIP as a new group**. Files are copied into the app,
  so moving or deleting the original never breaks the library.
- **Reader:** pinch to zoom, table of contents, find in document (PDFs
  included), and text size, spacing, margins and 5 themes for text formats.
- **Fast PDFs:** large PDFs open instantly at the last-read spot.
- **Remembers your place** in every file.
- **Backup and restore** the whole library as one `.zip`.

## Formats

| | |
|---|---|
| Documents | PDF, EPUB, DOCX, HTML, Markdown, TXT |
| Spreadsheets | XLSX, XLS, CSV, TSV |
| Images | PNG, JPG, GIF, WEBP, AVIF, BMP, HEIC |
| Archives | CBZ comics, ZIP |

## Development

**Needs:** Node 24, JDK 17, the Android SDK (platform 36), and a physical
Android phone with USB or wireless debugging. Expo Go won't work: the app uses
native modules it doesn't include, so you build a dev client once.

```bash
npm install
npm run prebuild      # generate android/ with this project's build settings
npm run android       # build and install the dev client (first time ~5 min)
```

Day to day:

```bash
adb reverse tcp:8081 tcp:8081
npm start
```

JavaScript changes arrive instantly. Rebuild (`npm run android`) only after
changing native code, `app.config.js`/`app.json`, or `patches/`.

| Command | What it does |
|---|---|
| `npm run check` | Typecheck + all tests. **Run before every reload.** |
| `npm run prebuild` | Regenerate `android/` with the low-memory build settings |
| `npm run apk` | Signed release APK (refuses if signing isn't set up) |
| `npm run apk:dev` | Local release build for testing, not for shipping |

Tests use Node's built-in runner — no Jest. `npm run typecheck` alone isn't
enough: the WebView viewer is a large template string that only the tests
check.

## Releasing

Push a version tag; GitHub Actions builds the signed APK and attaches it to a
GitHub Release:

```bash
git tag v1.5.0
git push origin v1.5.0
```

- The **version name** comes from the tag.
- The **versionCode** is the git commit count, so every build installs as an
  update over the last. Never edit it by hand.
- A test build without a release: **Actions → Android release APK → Run
  workflow**.

Release builds are signed with `credentials/stackread-release.keystore`.
**Back it up** — without it, installed copies can never be updated. The APK is
about 120–160 MB (all CPU types); a Play Store bundle downloads at about
45–60 MB.

## Project layout

```
App.tsx              app root: splash, reader open/close, incoming files
src/
  screens/           LibraryScreen (the board), ReaderScreen
  components/        cards, pager, sheets
  renderers/         PDF, image, and one WebView host for everything else
  storage/           SQLite index, import, backup, caches
  store/             app state (Zustand; reading positions in MMKV)
  __tests__/         528 tests
modules/
  pdf-text/          PDF text and search (native)
  incoming-files/    "Open with" and "Share" (native)
patches/             fixes applied to react-native-pdf on install
scripts/             build tuning, signing, versioning
```

**Adding a format** means one function in
[src/renderers/webview/prepare.ts](src/renderers/webview/prepare.ts) plus an
entry in [src/storage/formats.ts](src/storage/formats.ts).

Deeper notes for contributors: [CLAUDE.md](CLAUDE.md). The roadmap:
[ROADMAP.md](ROADMAP.md).

## License

See [LICENSE](LICENSE).
