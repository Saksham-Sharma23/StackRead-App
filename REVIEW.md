# StackRead — code review, 2026-11-03

A full read of the project: bugs found, improvements, features to add, and an
assessment of the architecture.

**State at the time of review:** `npm run check` passes — typecheck clean,
553 / 553 tests. Last commit `eedd241` ("fixed text selection bug").

---

## 1. Bugs found (each verified in the code)

| # | Bug | Where | Severity |
|---|---|---|---|
| 1 | **Search can open the wrong file.** A file inside its 5-second undo window still appears in search results, because search reads SQLite and the row is only removed when the delete commits. Tapping it opens the reader, which filters hidden files out of the group, so `findIndex` returns -1, falls back to 0, and the **first file of the group** opens instead. Neither `LibrarySearch` nor the looks' search filters `hiddenIds`. | [LibraryScreen.tsx:352](src/screens/LibraryScreen.tsx#L352), [ReaderScreen.tsx:97-100](src/screens/ReaderScreen.tsx#L97-L100) | Medium |
| 2 | **Neighbour prefetch silently skipped after a fast swipe.** `if (mine !== generation \|\| busy) return` — if an older prefetch is still parsing, the new queue exits for good. Nothing retries it when `busy` clears, so the new neighbours are not warmed until the next page turn. | [prefetch.ts:128](src/renderers/webview/prefetch.ts#L128) | Medium |
| 3 | **Double parse of the same file.** Opening a file whose prefetch is mid-parse starts a second full `prepareFile` — there is no in-flight sharing. Two copies of a large EPUB or comic in memory at once, which is the exact pressure the project works to avoid. | [WebViewRenderer.tsx:622](src/renderers/WebViewRenderer.tsx#L622) | Medium |
| 4 | **Dark pages always declare `color-scheme: light`.** The check compares against `#0b0b0d`, but Classic dark is `#0b0c11` and the looks use other colours. Browser-drawn parts (scrollbars, form controls, default colours) render light on dark pages. | [viewerHtml.ts:132](src/renderers/webview/viewerHtml.ts#L132) | Low–Medium |
| 5 | **Many EPUB covers render blank.** Only `<img>` tags are rewritten to image tokens. The very common cover pattern `<svg><image xlink:href="cover.jpg"/></svg>` keeps a relative URL, which the CSP blocks. | [epub.ts:522](src/renderers/webview/epub.ts#L522) | Medium |
| 6 | **Picker import freezes the UI and leaves extra copies.** `copyToCacheDirectory: true` makes one copy, then `copySync` makes a second on the JS thread — the spinner freezes during a large PDF, and the cache copy is never deleted. The "Open with" path already copies on a native background thread (`modules/incoming-files` → `copyTo`). | [files.ts:40-44](src/storage/files.ts#L40-L44), [files.ts:93](src/storage/files.ts#L93) | Medium |

### Smaller ones

- **Spreadsheets have no row/cell cap.** A 40 MB CSV becomes millions of DOM
  nodes and will hang or kill the WebView. SheetJS and mammoth also run on the JS
  thread. — [prepare.ts:214](src/renderers/webview/prepare.ts#L214)
- **EPUB images embedded as `data:` URLs are dropped**, although the CSP allows
  `img-src data:`. — [epub.ts:525](src/renderers/webview/epub.ts#L525)
- **Stale `tap` message.** The tap effect re-runs whenever `active` or `rendered`
  changes and posts a tap for the old count. Tiny impact (marks the last touch as
  a phantom until the next touchstart). — [WebViewRenderer.tsx:970](src/renderers/WebViewRenderer.tsx#L970)
- **Navigation guard allows any `data:` URL** — wider than needed; tighten it. —
  [WebViewRenderer.tsx:195](src/renderers/WebViewRenderer.tsx#L195)
- **Search lags memory by up to 400 ms** (the save debounce), so a file just
  imported or moved can be missing or show its old group.

### Already-known open items (from the project's own docs)

- AUDIT4 fixes are **not yet verified on a device**; TASKS3 L1 native rebuild and
  the looks' device checklist are pending.
- Files deleted outside the app are never reconciled against the index.
- No crash reporting yet (hook exists in `ui/crashLog.ts`).
- `useFullscreen` uses `expo-navigation-bar` APIs deprecated in SDK 57 —
  immersive mode may break on the next SDK bump (Fix.md #5).
- `pageNav.report` ignores label-only changes, e.g. roman → arabic (Fix.md #4).
- `ScrollPageIndicator` hard-codes the top bar height (`+56`).
- `MAX_PREPARE_BYTES` limits were never measured on a device.
- Reading themes do not apply to PDFs.
- Universal APK is 120–160 MB.

---

## 2. Improvements

### Performance and robustness

- Picker imports: copy natively with the existing `copyTo` from
  `incoming-files`, and delete the picker's cache copy.
- Cap spreadsheet rows or virtualize the grid; move SheetJS / mammoth off the JS
  thread where possible.
- Add an in-flight `Map<fileId, Promise<Prepared>>` so a prefetch and an open
  share one parse (fixes bug 3); re-queue a skipped prefetch when `busy` clears
  (fixes bug 2).
- Ship an AAB with per-ABI splits (~45–60 MB downloads instead of 120–160 MB).

### Code health

- **Move the viewer out of the template literal.** 1,956 lines of JavaScript in
  a string. Keep it as a real `.js` file and inline it at build time, so it can
  be linted and typechecked — removes the double-backslash and backtick traps.
- **Split `WebViewRenderer`** (1,257 lines, ~10 refs coordinating an implicit
  state machine across effects). Most past reader bugs came from here. Use an
  explicit reducer / state machine, or 3–4 focused hooks: cache & payload,
  streaming, messages, renderer recovery.
- **Add ESLint with `eslint-plugin-react-hooks`.** The code has
  `eslint-disable` comments but ESLint is not installed, so they do nothing.
- **Trim comments.** Many files are mostly comments, and many describe history
  ("this used to…"). Keep the *why* in code; move history to DETAIL.md / audits.
- **Rewrite source-text tests.** Some tests (e.g. `perceivedSpeed.test.ts`)
  assert on the source's wording and break on harmless rewrites.

### Testing and release

- Automate the manual device checklists with **Maestro** (YAML flows) or Detox:
  open each format, force-quit and relaunch, restore a backup.
- Add crash reporting (e.g. Sentry) through `crashLog.ts`, which already scrubs
  paths.
- Run `npm run check` on every push / PR, not only on release tags.
- Consolidate the docs (4 audits, 3 task lists, plan, roadmap, TODO) —
  `TODO-repo-cleanup.md` already plans this.

---

## 3. Features to add

### Should add (highest value, fits the product)

1. **Side-by-side reading on tablets and foldables** — the natural next step for
   "a paper next to its references".
2. **Highlights, bookmarks and notes**, with export. Expected in a paid reader.
3. **Full-text search inside documents across the library** — FTS5 already
   indexes names; extend it to EPUB / PDF text.
4. **"Continue reading" row and a home-screen widget** — progress data already
   exists.
5. **PDF night mode** / reading themes for PDFs.
6. **Automatic scheduled backups** to a user-chosen folder (e.g. a Drive folder).

### Nice to have

- Read aloud (TTS), dictionary / translate on selection, page-turn mode for EPUB,
  reading time left.
- Library sort and filters, custom covers, storage usage screen, duplicate
  detection, a "missing file" repair flow.
- More formats: CBR/CB7, FB2, TIFF (already planned), ODT/RTF.
- Import from the desktop app's `library.json` — the data model maps one-to-one.

---

## 4. Architecture assessment

**Overall: about 8/10 on design, 6/10 on maintainability.**

### Strengths

- **Data safety is professional-grade:** SQLite with WAL, diffed row writes, a
  hash shadow that only advances on success, row-by-row retry, additive-then-
  commit restore, deletions that survive a process kill and finish on the next
  launch, and a prune that refuses to run on an empty library. Designed around
  force-quits, which most apps never test.
- **Security is defense in depth:** inert WebView (no navigation, network or
  file access), two sanitizers, a per-document CSP with a script nonce, external
  links behind a confirmation, `content://`-only incoming files with a
  canonical-path check on the destination.
- **Good structural choices:** two renderer families instead of eleven; state
  split by update frequency (MMKV for hot state, Zustand for the board);
  normalized store; one module owns all id-keyed cache invalidation
  (`storage/lifecycle.ts`); the "one pdfium document at a time" rule enforced in
  code (`pdfiumLease.ts`); lazy loading with a startup-bundle test.
- **Testable core:** pure logic (diffing, pagination, PDF lease, zip handling) is
  separated from device code and tested in plain Node.

### Weaknesses

- **Complexity is concentrated** in `WebViewRenderer` and the viewer string —
  they work, but they are fragile to change.
- **Lots of hidden global state** (module-level caches, timers, flags). Easy to
  unit-test, but correct behaviour depends on call order that is only written
  down in comments.
- **Little UI / end-to-end testing.** Confidence comes from unit tests plus
  manual device checks, and several critical fixes are still unverified on a
  device.
- **Rules live in comments.** Over-commenting and doc sprawl slow reading, and a
  rule restated in prose is the "written down rather than enforced" problem the
  project itself calls out.

### Verdict

Well above the norm for a solo project; a senior reviewer would be impressed by
the failure-mode thinking. The main asks would be: break up the two big reader
files, add lint and end-to-end tests, and finish device verification.

---

## 5. Compared with Google Drive, ReadEra and Obsidian

StackRead falls behind mainly in four areas: format coverage, PDF depth, library
automation, and anything beyond read-only viewing. It is ahead of all three in
the one thing none of them has: the board of groups with a swipe to the next
related file.

The comparison below is from general knowledge of those apps (apart from what
was read in this codebase), so details may have changed in their latest versions.

### vs Google Drive (opening files)

| Drive does | StackRead today |
|---|---|
| Opens files in place, with no copy | Copies every file into the app, so each file takes up storage twice on the phone |
| Opens Office files, slides, video, audio and dozens of other types | 11 formats; no PPTX, ODT, RTF, video or audio |
| No practical size limits | Hard limits: 6 MB for text, 40 MB for comics/ZIP/spreadsheets, 100 MB for EPUB |
| Lets you select and copy text in PDFs | `react-native-pdf` has no text selection, so you can't copy from a PDF. **This is the biggest PDF gap.** |
| Scanned PDFs are searchable, because Drive recognises their text | Search finds nothing in a scanned PDF |
| Comments, sharing, sync across devices | Backup ZIP only, no sync |
| Spreadsheets open fast and stay responsive | The whole grid is built at once, on the JS thread, with no row cap |

Where StackRead matches it: instant PDF reopen at the last position. The resume
frame is the same idea Drive uses.

### vs ReadEra (reading)

| ReadEra does | StackRead today |
|---|---|
| Finds every book on the phone automatically | Manual import only |
| DJVU, MOBI/AZW3, FB2, RTF, CBR and more | None of these |
| Reads the title, author, series and cover from each book | Shows the file name only (cleaned up in the looks) |
| Page-turn and scroll modes, two pages side by side in landscape | EPUB is one continuous scroll |
| Highlights, notes, bookmarks, quotes | None |
| Dark and sepia themes for PDFs, plus margin cropping | Themes don't apply to PDFs |
| Books keep their own fonts and styling | Inline `style` attributes are stripped, and the security policy blocks a book's embedded fonts (`url()` fonts aren't allowed). Styled books lose formatting. |
| Every image in the book shows | Images are capped at 24 MB per book, so heavily illustrated books lose pictures past that |
| Native rendering engines that handle 1,000-page books smoothly | The whole book becomes one giant web page, which can stutter on very long books |

### vs Obsidian (Markdown and notes)

Obsidian is a different kind of app (an editor, not a viewer), so most gaps are
by design:

- **No editing.** StackRead can only read Markdown.
- **No links between files**, no backlinks, no `[[wiki links]]`. A group is the
  only connection between files.
- **Simpler Markdown rendering.** The viewer has its own small renderer, so
  tables, callouts, math and embeds are likely missing or limited.
- **Files aren't kept as a plain folder.** Obsidian works directly on a folder
  you can open elsewhere; StackRead files live under generated names inside the
  app.
- **No full-text search across the whole library.** Obsidian searches inside
  every file; StackRead searches file names only.
- **No plugins**, and no sync.

### Where StackRead is ahead of all three

- **The board itself.** A row of related files plus a swipe to the next one
  exists in none of them. This is the product.
- **Data safety.** Undo on delete, crash-proof saves and a restore that can't
  half-fail are better than most readers.
- **Privacy and security.** Fully offline, no network access from documents, and
  hostile files are contained. Drive can't claim that.
- **Mixed formats in one row.** ReadEra separates books from documents; StackRead
  lets a PDF, an EPUB and a spreadsheet sit side by side.

### What to close first

In order of how often users would hit each gap:

1. **Text selection and copy in PDFs.** Users notice this within minutes. It
   probably means replacing or extending the PDF view, possibly with the app's
   own `pdf-text` module, since it already reads pdfium's text.
2. **Highlights and bookmarks.** The main reason people choose ReadEra.
3. **Keep the book's own styling and fonts.** Allow safe CSS: font data from the
   book itself, and a short allow-list of style properties.
4. **Higher size limits**, after measuring on a device, plus a row cap or
   virtual scrolling for spreadsheets.
5. **Book details:** title, author and cover from EPUB metadata. The file's
   metadata block is already parsed.
6. **More formats:** CBR, FB2 and DJVU first.

Copy ReadEra's reading depth; compete with Drive and Obsidian on the board idea,
not on feature count.

---

## 6. Fix order — every issue above, by priority

One list covering the bugs (§1), the open items, and the improvements (§2).
Ranked by user harm × how often it is hit: crashes and wrong behaviour first,
then visible quality, then housekeeping. Effort: **S** under an hour, **M** a
few hours, **L** a day or more. Features (§3, §5) are not in this list.

### P0 — before the next release

| # | Issue | Source | Effort |
|---|---|---|---|
| 1 | Verify the AUDIT4 fixes and the looks on a real device (native rebuild, then the existing checklists) | Open items | M |
| 2 | ✅ **Fixed 2026-11-07.** Large spreadsheets can hang or crash the reader: no row/cell cap, grid built on the JS thread | §1 smaller | S–M |
| 3 | ✅ **Fixed 2026-11-07.** The same file can be parsed twice at once (prefetch + open); add an in-flight map | Bug 3 | S |
| 4 | ✅ **Fixed 2026-11-07.** Search can open the wrong file for a file in its undo window | Bug 1 | S |
| 5 | ✅ **Fixed 2026-11-07.** Picker import freezes the UI and leaves duplicate cache copies; use the native `copyTo` | Bug 6 | M |

**What the 2026-11-07 fixes changed** (586 tests pass; not yet checked on a device):

- **#2** — new [sheetGrid.ts](src/renderers/webview/sheetGrid.ts): at most 5,000
  rows, 200 columns and 100,000 cells per workbook, with a note above a cut
  grid. SheetJS is told to stop reading at the row limit (`sheetRows`), reads
  at most one column past the limit, and no longer pads every row to a
  whole-row formatted range (which turned 3-column sheets into 16,384-wide
  ones). Parsing yields between sheets. Tests: `sheetGrid.test.ts`, on real
  CSV and XLSX output.
- **#3** — new [inflight.ts](src/renderers/webview/inflight.ts) and
  [prepareOnce.ts](src/renderers/webview/prepareOnce.ts): the renderer and the
  prefetch both parse through `prepareAndCache`, so whoever asks second joins
  the parse already running. A run forgotten by a removal or a restore
  (wired into `lifecycle.ts`) finishes but does not cache its stale result.
  Tests: `inflight.test.ts`.
- **#4** — new [searchTarget.ts](src/store/searchTarget.ts): search results are
  filtered against the undo window, and a tapped result opens as the store's
  own entry. The reader also opens a file into the group the store says it is
  in, so a stale entry can no longer land on another file. Tests:
  `searchTarget.test.ts`.
- **#5** — [files.ts](src/storage/files.ts): the picker returns the original
  `content://` URI and the native copier from "Open with" writes it straight
  into the library on a background thread. Old dev clients without that module
  fall back to an async copy and delete the cache copy afterwards. Tests:
  `pickerImport.test.ts`.

### P1 — visible quality

| # | Issue | Source | Effort |
|---|---|---|---|
| 6 | ✅ **Fixed 2026-11-07.** Many EPUB covers render blank (`<svg><image xlink:href>` not handled) | Bug 5 | S–M |
| 7 | ✅ **Fixed 2026-11-07** (as a sheet — see below). No text selection or copy in PDFs | §5 | L |
| 8 | ✅ **Fixed 2026-11-07.** Neighbour prefetch skipped after a fast swipe; re-queue when `busy` clears | Bug 2 | S |
| 9 | ✅ **Fixed 2026-11-07.** Deprecated `expo-navigation-bar` APIs in `useFullscreen` — immersive mode can break on the next SDK upgrade | Open items | S–M |
| 10 | ✅ **Fixed 2026-11-07** (user-sent, not Sentry — see below). No crash reporting | Open items, §2 | M |
| 11 | ✅ **Fixed 2026-11-07.** Books lose their own fonts and styling (inline `style` stripped, `url()` fonts blocked) | §5 | M |
| 12 | ✅ **Fixed 2026-11-07.** Dark pages declare `color-scheme: light` | Bug 4 | S |

**What the P1 fixes changed** (617 tests pass; not yet checked on a device):

- **#6** — [epub.ts](src/renderers/webview/epub.ts) rewrites SVG `<image>` to a
  token like `<img>`, and the viewer fills it via `href`; SVGs with a viewBox
  scale to the page width.
- **#7** — PDFs gain **⋯ → Select text**: the page's text in a sheet
  ([PdfTextSheet.tsx](src/components/PdfTextSheet.tsx)), selectable with the
  system copy toolbar, page by page, plus "Share page text". It uses the
  existing `pdf-text` module, so no rebuild. *Not* long-press selection on the
  page itself — `react-native-pdf` draws pages as images with no text layer;
  that would need a native overlay.
- **#8** — new [latestQueue.ts](src/renderers/webview/latestQueue.ts): one
  prefetch at a time, and the newest request runs when the current parse ends
  instead of being dropped.
- **#9** — [useFullscreen.ts](src/ui/useFullscreen.ts) uses
  `NavigationBar.setHidden` and `StatusBar.setHidden`; the native calls
  underneath are the same, so behaviour is unchanged.
- **#10** — after a crash, the next launch offers to **email** a scrubbed
  report ([crashReport.ts](src/ui/crashReport.ts), [crashPrompt.ts](src/ui/crashPrompt.ts)).
  Not Sentry: PRIVACY.md promises no crash reporting that sends data off the
  device. PRIVACY.md now describes the prompt (dated 7 November 2026) and needs
  re-publishing wherever it is hosted.
- **#11** — the real cause was that the book's stylesheet travelled as a
  `<style>` inside the content, which the viewer's sanitiser deletes — so no
  book's CSS ever applied. It now travels as `Prepared.css` and the viewer
  installs it. [bookCss.ts](src/renderers/webview/bookCss.ts) was rewritten to
  scope rules nested in `@media` (the old one let them through unscoped) and to
  keep quoted `data:` URLs (a regex bug dropped them). Book fonts are inlined as
  `data:` URIs within a 4 MB budget, skipping obfuscated ones
  ([bookFonts.ts](src/renderers/webview/bookFonts.ts)). Inline `style` keeps
  typography and spacing in both sanitisers, held equal by a test. Colours and
  line height stay the reader's; a reading font the user picks still wins.
- **#12** — `color-scheme` is computed from the colour's luminance, on load and
  whenever the page theme changes.

### P2 — small or rare

| # | Issue | Source | Effort |
|---|---|---|---|
| 13 | Large DOCX files convert (mammoth) on the JS thread and freeze the UI | §1 smaller, §2 | M |
| 14 | EPUB images embedded as `data:` URLs are dropped | §1 smaller | S |
| 15 | Per-format size limits never measured on a device (6 / 40 / 100 MB) | Open items | M |
| 16 | Reading themes don't apply to PDFs | Open items | M–L |
| 17 | Files deleted outside the app are never reconciled with the index (rare: storage is app-private) | Open items | M |
| 18 | Search lags up to 400 ms behind just-imported or moved files | §1 smaller | S |
| 19 | `pageNav.report` ignores label-only changes (roman → arabic) | Open items | S |
| 20 | Navigation guard allows any `data:` URL; tighten it | §1 smaller | S |
| 21 | Stale "tap" message after a swipe or a reload | §1 smaller | S |
| 22 | Scroll indicator hard-codes the top bar height (`+56`) | Open items | S |
| 23 | APK is 120–160 MB; ship an AAB with per-ABI splits | Open items, §2 | S–M |

### P3 — engineering health (no user-visible change)

| # | Issue | Source | Effort |
|---|---|---|---|
| 24 | Add ESLint with `eslint-plugin-react-hooks` (existing `eslint-disable` comments do nothing) | §2 | S |
| 25 | Run `npm run check` on every push / PR, not only on release tags | §2 | S |
| 26 | Automate the device checklists with Maestro or Detox | §2 | L |
| 27 | Split `WebViewRenderer` into focused hooks or an explicit state machine | §2 | L |
| 28 | Move the viewer program out of its template literal into a real `.js` file inlined at build time | §2 | M–L |
| 29 | Rewrite tests that assert on source wording (e.g. `perceivedSpeed.test.ts`) to assert behaviour | §2 | M |
| 30 | Trim history out of code comments | §2 | M |
| 31 | Consolidate the docs (4 audits, 3 task lists, plan, roadmap, TODO) per `TODO-repo-cleanup.md` | §2 | M |

### Suggested first batch

#3, #4, #8 and #12 — small, JS-only, arrive over Fast Refresh. Then #2 and #5,
then the native rebuild for #1.
