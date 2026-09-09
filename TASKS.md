# StackRead — task list

Actionable work derived from [AUDIT.md](AUDIT.md). Each task carries the files it
touches, the change itself, and **how to know it worked** — several of these are
bugs that on-device testing surfaces only by chance, so the verification step is
not optional.

Phases are ordered so each is independently shippable and the risky work lands
after the cheap safety fixes. Task ids are stable; the audit section each one
resolves is linked.

**Status: P0–P12 and P18 are implemented.** P13–P17 — the fourth audit's
backlog, and the only phase there that risks user data (P13, restore safety) —
remain open. `npm run check` passes — **291 tests, up from 188**. Everything
awaits on-device verification.

**P18 (motion and UI polish) is done and is the newest work.** It is the first
phase here not derived from an audit: a shared-element reader transition, an
empty state that teaches the 2-D board, chrome that hides itself, text previews
for the formats that showed only a badge, and a move sheet that looks like the
board it describes. Its retrospective is at the end of this file.

**P13 is still the highest priority in the backlog.** P18 changed how the app
feels; P13 is the phase that stops a restore from destroying the library it is
recovering.

**A native rebuild is required for P10-2** — `modules/pdf-text` is a new Expo
module, so the dev client on the device is invalid until:

```bash
npm run prebuild && npm run android
```

Both have been run here and the build is verified end to end:

- autolinking discovers the module (`expo-modules-autolinking search`)
- `:pdf-text:compileDebugKotlin` succeeds
- `assembleDebug` succeeds — **BUILD SUCCESSFUL in 22m 54s**, exit code checked
  on its own line rather than through a pipe ([DETAIL.md §6.2](DETAIL.md))
- `PdfTextModule` is present in `classes2.dex`
- the APK carries **one** copy of `libpdfium.so` and `libpdfiumandroid.so`,
  which is the version pin doing its job — a mismatch would have shipped two

What remains is running it on a phone: `npm run android`.

**P6 was added after a second-pass re-audit** ([AUDIT.md §6](AUDIT.md)), which
re-verified every P0-P5 finding against the code and then found four new ones —
all on the per-frame path, all JS-only. It is where the page-dots pill and the
scroll smoothness were addressed.

**P8–P12 come from a third-pass audit**, which re-verified every P0–P7 finding
against the code (all confirmed landed) and then found a new class of fault:
**lifetime**. The app has five caches keyed by `file.id`, and nothing owns the
question of when an id stops being valid — two of the five have an invalidation
function that is never called from anywhere, and restore from backup calls none
of them. **P8–P11 are now done** — P8 was the only phase that lost user data or displayed
the wrong document; P9 closed the perceived-speed gap; P10 and P11 landed
together because both needed the same thing (a document position that is not a
pixel offset), and doing them apart would have built it twice. P12 is the — perceived speed, find-in-document, position
anchors that survive rotation, and the scale limits.

None of P8–P12 needs a native rebuild. All of it is JS-only except P12-1
(`fast-xml-parser`) and T-2 (`knip`), which are pure-JS dev/runtime packages
needing only an `npm install`.

**A native rebuild is required** — for `react-native-view-shot` (P5-1) and
`expo-sqlite` (P3-2). One rebuild covers both:

```bash
npm run prebuild && npm run android
```

Both are new native modules, so the dev client currently on the device is
invalid until this runs. `expo-sqlite` also registers a config plugin, which is
why `prebuild` is not optional here. Everything else — P0, P1, P2, P4, P6 and
P7 — is JS-only and arrives over Fast Refresh.

**P4-1 did not need the rebuild it was scheduled for.** Its plan was built on
`allowingReadAccessToURL`, which turns out to be iOS-only; the Android
alternative would have opened the WebView to the whole app sandbox. It was
implemented with blob URLs instead — same memory win, no weakening of the
security posture, no native code. See the P4 section for the full reasoning.

**P3-2 (SQLite) is now done**, which cleared the first two audits' backlog
entirely. What remains is T-1 (behavioural lifecycle tests, never scheduled) and
everything the third audit opened: P8 through P12, plus T-2 and T-3.

Gate before any reload: `npm run check` (typecheck + tests).
Persistence changes are verified by **force-quitting from recents**, never by a
reload — see [DETAIL.md §6.3](DETAIL.md).

---

## P0 — Lifecycle correctness — ✅ complete

Highest value-to-effort ratio in the list. Nothing else here risks user data.
All four are small, independent, and shippable in one pass.

### ☑ P0-1 — Move `AppState` handling to the app root

Resolves [AUDIT §1.1](AUDIT.md) and [§1.2](AUDIT.md). **Do this one first** — it
fixes three symptoms at once.

**Files:** [App.tsx](App.tsx), [src/screens/LibraryScreen.tsx](src/screens/LibraryScreen.tsx)

- [x] Cut the `AppState` effect out of `LibraryScreen`
- [x] Added [useAppLifecycle.ts](src/ui/useAppLifecycle.ts), calling
      `commitAll()`, `flushLibrarySave()` and `clearPrepared()` on
      `background` / `inactive`
- [x] Mounted in `Root()` in [App.tsx](App.tsx), above the screen swap, so it
      lives for the process rather than for one screen
- [x] Kept `resumeInterrupted()` in `LibraryScreen` — correctly gated on
      `loaded`, and it needs the library in memory to act on
- [x] Removed the four now-unused imports/bindings from `LibraryScreen`

**Two details worth knowing:**

*Ordering is load-bearing.* `commitAll()` runs **before** `flushLibrarySave()`,
because committing mutates the library — it drops removed entries from the
index. Flushing first would persist a library still containing files the user
deleted, losing the removal.

*It subscribes via `getState()`, not a hook.* `usePendingRemoval.getState()`
inside the listener means the effect has an empty dependency array and never
re-subscribes when the pending list changes — a hook-bound version would tear
down and re-register the listener on every queued removal.

**Why it broke:** `LibraryScreen` unmounts while the reader is open, so
`open a file → Home → process killed` ran none of the shutdown path.

**Verify:**
1. Open a file, press Home, force-quit from recents, reopen → position and
   library intact.
2. Remove a file, immediately press Home (inside the 5s window), force-quit,
   reopen → the file stays removed and does not reappear.
3. Open a large EPUB, press Home → confirm memory drops in Android Studio's
   profiler (the cache was released).

### ☑ P0-2 — `cancelPrefetch()` must clear the pins

Resolves [AUDIT §1.3](AUDIT.md).

**Files:** [src/renderers/webview/prefetch.ts](src/renderers/webview/prefetch.ts)

- [x] `cancelPrefetch()` now calls `setPinned([])` alongside the generation bump
- [x] Documented *why*: pins are exempt from the tail budget by design, so that
      exemption is only safe while something releases it — nothing else calls
      `setPinned` once the reader has closed
- [x] Test added to [prepareCache.test.ts](src/__tests__/prepareCache.test.ts):
      pin three, confirm they survive pressure, clear pins, confirm they are
      then reclaimed

**Note:** the entries are *demoted, not discarded* — each becomes an ordinary
tail entry, so reopening the file you just closed is still a cache hit.

**Verify:** `prepareCacheStats().pinned === 0` after leaving the reader.

### ☑ P0-3 — Card progress bars must subscribe, not read

Resolves [AUDIT §1.4](AUDIT.md).

**Files:** [src/components/GroupRow.tsx](src/components/GroupRow.tsx),
[src/components/FileCard.tsx](src/components/FileCard.tsx),
[src/storage/mmkv.ts](src/storage/mmkv.ts)

- [x] Dropped `progress={getProgress(file.id)}` from `GroupRow` — a synchronous
      MMKV read during render that nothing re-rendered on
- [x] `FileCard` subscribes to its own key instead:
      ```ts
      const [stored] = useMMKVNumber(progressKey(file.id), storage)
      ```
- [x] `progress` removed from the `FileCard` memo comparator — it is internal
      state now, not a prop
- [x] `progress` prop threading removed from `DraggableCard` as well, which was
      only relaying it

**The instance argument is required.** This app uses a *named* MMKV
(`createMMKV({ id: 'stackread' })`), so omitting the second argument would
silently subscribe to the default shared instance, which nothing ever writes —
a bar that stays at zero forever. Verified `useMMKVNumber` exists in
`react-native-mmkv@4.3.2` (`lib/hooks/useMMKVNumber.d.ts`) rather than assumed
from the v3 API, since v4 is Nitro-based and differs.

**Verify:** Read a few pages, back out to the board → the bar updates
immediately, with no other interaction.

### ☑ P0-4 — Correct three stale comments

Resolves [AUDIT §1.5](AUDIT.md). Cheap, and
[DETAIL.md §6.12](DETAIL.md) explains why a comment describing an abandoned
approach is worse than none: it invites reintroducing the bug.

- [x] [pageNav.ts](src/store/pageNav.ts) — "and its two neighbours" removed, and
      the docstring now gives the two reasons per-`fileId` keying is *still*
      required: renderers overlap briefly during a swipe, and the prepared-
      document cache means a position can be known for an off-screen file
- [x] [GroupRow.tsx](src/components/GroupRow.tsx) — now accurately describes the
      split: the vertical axis is virtualized (P3-4), these rows are not, and
      that is what avoids nesting virtualized lists
- [x] [LibraryScreen.tsx](src/screens/LibraryScreen.tsx) — its own module
      docstring updated too; it described the `ScrollView` that P3-4 replaced
- [x] [README.md](README.md) — "No automated test suite" replaced with what the
      suite actually covers and what still needs a device; Scripts table gained
      `check`, `test`, `apk` and `apk:dev`, with a note on why `typecheck` alone
      is insufficient

---

## P1 — Perceived speed — ✅ complete (PDF covers split to P5-1)

Nothing structural. This is the phase that makes it *feel* like Drive.

> Shipped and passing `npm run check` (109 tests). **Not yet verified on
> device** — that is the outstanding step for every item below.

### ☑ P1-1 — Real cover thumbnails for EPUB and CBZ

Resolves [AUDIT §3.2](AUDIT.md). `canThumbnail()` returned true only for images,
so the actual library for most users was a wall of coloured badges.

**Files:** [src/storage/covers.ts](src/storage/covers.ts) (new),
[src/storage/thumbs.ts](src/storage/thumbs.ts)

- [x] Widened `canThumbnail()` to `image | epub | comic` — still the single
      place that decides it
- [x] **CBZ** — first page by `naturalCompare`, matching the reader's own order
- [x] **EPUB** — all three conventions: the EPUB 3 `cover-image` property, the
      EPUB 2 `<meta name="cover">` (both attribute orders), and a fallback to
      the first image in the first spine item
- [x] Cover extraction lives in its own module rather than in `prepare.ts`:
      a thumbnail needs one image, not a parsed book
- [x] Kept `MAX_CONCURRENT = 2` and the `attempted` set
- [x] Routed through the worklet runtime (P2-1) — covers are generated while the
      board scrolls, so this must not compete with it
- [x] Tests: [covers.test.ts](src/__tests__/covers.test.ts) pins all three EPUB
      conventions, OPF-relative path resolution, and the SVG exclusion

> **⚠ PDF covers are NOT done — deferred, with reason.** `react-native-pdf`
> exposes no page-to-image API: `onLoadComplete` returns the path of the PDF
> itself, which `ImageManipulator` cannot decode. Rasterising a page needs a new
> native module (a view-snapshot library or a pdfium binding) plus a rebuild,
> which is outside a phase whose premise is "nothing structural".
> `captureFirstPage()` in [thumbs.ts](src/storage/thumbs.ts) is the seam,
> written and documented but not yet called. See P5-1 below.

**Verify:** Import an EPUB and a CBZ → real covers appear. PDFs still show a
badge, as expected.

### ☑ P1-2 — ThumbHash placeholders

Resolves [AUDIT §3.2](AUDIT.md). Highest visual-polish-per-byte change available.

**Files:** [src/storage/thumbhash.ts](src/storage/thumbhash.ts) (new),
[src/types.ts](src/types.ts), [src/storage/thumbs.ts](src/storage/thumbs.ts),
[src/components/FileCard.tsx](src/components/FileCard.tsx),
[src/store/library.ts](src/store/library.ts)

- [x] `thumbhash?: string` on `FileEntry` — optional like `size`, so existing
      libraries need no migration
- [x] Computed from the stored thumbnail, so the placeholder matches the image
      it stands in for
- [x] Passed to `expo-image`'s `placeholder` prop — decoded natively, no decode
      dependency
- [x] A card with a hash but no image yet still renders the blur, which covers
      the window between the index loading and generation finishing
- [x] `setThumb` preserves an existing hash when regeneration yields none, so a
      transient failure cannot strip a working placeholder
- [x] `thumbhash` added to the `FileCard` memo comparator — without it the card
      would not re-render when the hash arrives
- [x] Tests: [thumbhash.test.ts](src/__tests__/thumbhash.test.ts) covers the PNG
      decoder (all four scanline filters), the round-trip colour property, and
      the size budget

**One dependency added:** `thumbhash` (~2KB, zero transitive deps). Encoding
needs raw RGBA, which nothing in the Expo image stack exposes — so
[thumbhash.ts](src/storage/thumbhash.ts) decodes the small PNG that
`ImageManipulator` emits, using `fflate`'s `unzlibSync` (already a dependency).
That decoder is deliberately partial: 8-bit, non-interlaced, RGB or RGBA only,
and it refuses anything else rather than guessing.

**Verify:** Cold start with a full library → no empty grey rectangles.

### ☑ P1-3 — Progressive EPUB chapter streaming

Resolves [AUDIT §3.1](AUDIT.md). Turns a multi-second wait on a large book into
a first paint as soon as the opening chapters are assembled.

**Files:** [src/renderers/webview/epub.ts](src/renderers/webview/epub.ts),
[src/renderers/webview/viewerHtml.ts](src/renderers/webview/viewerHtml.ts),
[src/renderers/WebViewRenderer.tsx](src/renderers/WebViewRenderer.tsx),
[src/renderers/webview/prepare.ts](src/renderers/webview/prepare.ts)

- [x] `loadEpubAsHtml` splits its output: `html` for the first paint, `rest[]`
      for the batches after it
- [x] Packed **by accumulated size, not chapter count** (120KB first paint,
      250KB batches) — chapter length varies enormously, and "the first chapter"
      would render an almost-empty screen for a book opening on a title page
- [x] A chapter is **never split across batches**: `.sr-chapter` boundaries are
      what `seekToHref` resolves against, so half a chapter is a dead TOC link
- [x] Viewer `append` handler uses `insertAdjacentHTML('beforeend', …)`, which
      appends without re-parsing the document or discarding decoded images
- [x] Batches posted one per macrotask after `ready` — a loop would hand the
      WebView megabytes in one turn and freeze it mid-read
- [x] **Page counts stay content-derived**: `totalPages` is computed over the
      whole book's extracted text at parse time and is untouched by appending
      ([DETAIL.md §5.2](DETAIL.md))
- [x] `pendingScroll` / `pendingHref` park a restore or TOC jump whose target
      has not arrived, retried as batches land — this branch was unreachable
      before streaming, which is why `seekToHref` simply returned
- [x] Tests: [streaming.test.ts](src/__tests__/streaming.test.ts) pins the split
      arithmetic, chapter integrity across batches, the oversized-first-chapter
      case, and that appending re-measures without recounting pages

**Note:** the template-literal trap ([DETAIL.md §6.13](DETAIL.md)) bit once
during this work — a backtick in a new comment terminated the literal and broke
the build with `TS1005`. Caught by `npm run check` before any reload, as
designed.

### ☑ P1-4 — Binary search in `currentPage()`

Resolves [AUDIT §3.4](AUDIT.md).

**Files:** [src/renderers/webview/viewerHtml.ts](src/renderers/webview/viewerHtml.ts)

- [x] `anchorIndexAt()` replaces the linear scan — 1,200 comparisons per frame
      on a long book become ~11
- [x] `activeAnchors()` extracted so `currentPage` and `seekToPage` cannot
      disagree about which array they address; they are inverse operations over
      the same index, and a mismatch lands a seek one page off
- [x] Tests: differential against the linear implementation across an irregular
      array **including equal-valued neighbours** — the case a naive bisection
      gets wrong — plus the degenerate arrays (single anchor, exact boundary
      hits, scrolled past the end)

---

## P2 — Off-thread parsing — ✅ complete

### ☑ P2-1 — Move document parsing off the JS thread

Resolves [AUDIT §2.5](AUDIT.md). Removes the last source of scroll jank.

**Files:** [src/renderers/webview/offload.ts](src/renderers/webview/offload.ts)
(new), [epub.ts](src/renderers/webview/epub.ts),
[prepare.ts](src/renderers/webview/prepare.ts),
[covers.ts](src/storage/covers.ts),
[prefetch.ts](src/renderers/webview/prefetch.ts)

- [x] `createWorkletRuntime` + `runOnRuntimeAsync` from
      `react-native-worklets` — a real second JS runtime on its own thread.
      Already a dependency; no new native module, no rebuild.
- [x] `unzipOffThread` and `toBase64OffThread` wrap the two hot loops
- [x] Wired into all four callers: EPUB unzip, EPUB image inlining, CBZ, ZIP,
      and cover extraction
- [x] One lazily-created runtime app-wide, not one per parse — creating a
      runtime spins up a JS context, far more than most parses cost
- [x] **Falls back to synchronous work** whenever `canOffload()` is false or a
      worklet throws, so an offload failure can never become a failure to open a
      file. Behaviour is identical; only the thread differs.
- [x] Kept the single `busy` flag, and documented what it now does and does not
      cover: it serialises prefetches against each other, but a user-initiated
      open deliberately is not blocked behind a speculative parse
- [x] `CHUNK = 0x2000` preserved, with its reasoning, in both the worklet body
      and the shared fallback
- [x] Tests: [offload.test.ts](src/__tests__/offload.test.ts) pins the worklet
      copy against the shared encoder byte-for-byte, and asserts binary zip
      entries survive the serialisation boundary intact

> **`fflate`'s async API was evaluated and rejected.** It looked like the
> smaller change, but its concurrency comes from Web Workers in the browser and
> `worker_threads` under Node — React Native has neither, so `unzip` degrades to
> the same blocking code behind a callback. That is worse than the synchronous
> version, because it *looks* asynchronous. Verified against
> `node_modules/fflate/package.json` rather than assumed.

**One deduplication done along the way:** `toBase64` existed in three copies
(`bytes.ts`, `offload.ts`, `thumbhash.ts`). Now one, imported — the exact shape
of the half-applied fix in [DETAIL.md §6.12](DETAIL.md). The worklet body still
inlines its own loop, because a worklet is compiled in isolation and cannot
reach an ordinary import; the fallback path calls the shared function, so the
two cannot silently diverge.

**Verify:** Scroll a group continuously while a large EPUB or CBZ prefetches →
no dropped frames.

---

## P3 — Storage rearchitecture — ✅ complete

Do this **before** the library grows — migration gets harder with every user.

> P3-1, P3-3, P3-4 and P3-5 are JS-only and arrive over Fast Refresh. **P3-2
> replaces the index with SQLite and needs a native rebuild** — see below.

### ☑ P3-1 — Normalize the library store

Resolves [AUDIT §2.1](AUDIT.md). Currently O(groups × files) per mutation.

**Files:** [src/store/library.ts](src/store/library.ts),
[src/store/selectors.ts](src/store/selectors.ts)

- [x] `files: FileEntry[]` replaced with `filesById` + `groupOrder`
- [x] `useGroupFiles` selects one id array — no allocation in the selector, so
      the reference changes only when *that* row's membership changes
- [x] Every `reindexGroup` full-array rebuild is gone: a reorder rewrites one
      array, and `orderInGroup` is derived on the way out
- [x] Selectors still return stable references — `useShallow` / `useMemo` kept,
      plus a module-level `EMPTY_IDS` so a group with no files never allocates
      ([CLAUDE.md](CLAUDE.md), [DETAIL.md §6.10](DETAIL.md))
- [x] **`library.json`'s on-disk shape is unchanged.** `toLibrary()` flattens
      back to `{ groups, files }` on save, so existing libraries load, exports
      round-trip, and no migration is needed
- [x] Added `useGroupCounts()` / `useFileCount()` — both screens were doing
      `files.filter(...)` per group for menu counts, which was the same
      O(groups × files) pattern in a second place
- [x] `pendingRemoval.resumeInterrupted()` updated to the map lookup
- [x] Tests: [normalizedStore.test.ts](src/__tests__/normalizedStore.test.ts)
      pins the round trip, that `normalize` sorts by `orderInGroup` rather than
      array position, that flattening renumbers from position (so a stale field
      cannot be persisted), and that a file whose group was deleted is dropped

**The hazard this introduces, and why it is tested:** two shapes now describe
the same data. An `orderInGroup` that drifted from its position in `groupOrder`
would silently reorder a user's row — but only after a restart, which is the
worst way to find out. `groupOrder` is authoritative at runtime and the field is
derived in exactly one place.

**Verify:** 30 groups × 2,000 files → renaming a group stays at 60 fps.

### ☑ P3-2 — Move the index to SQLite

Resolves [AUDIT §2.2](AUDIT.md). The last outstanding P3 item.

**Files:** [src/storage/db.ts](src/storage/db.ts) (new),
[src/storage/libraryDiff.ts](src/storage/libraryDiff.ts) (new),
[src/storage/library.ts](src/storage/library.ts),
[src/storage/paths.ts](src/storage/paths.ts),
[src/storage/files.ts](src/storage/files.ts),
[src/storage/backup.ts](src/storage/backup.ts)

- [x] `expo-sqlite@~57.0.2`, installed with `npx expo install` so it is the
      version pinned to this SDK rather than latest
- [x] Row-level writes replace stringifying the whole index twice per debounce
- [x] **WAL replaces the hand-rolled `.bak`** — real journalled, atomic commits,
      which retires the `moveSync` workaround entirely
      ([DETAIL.md §6.3](DETAIL.md), now marked superseded there)
- [x] One-time migration from `library.json`, with the `.bak` as fallback
- [x] `library.json` stays the **portable** format: it is still what an export
      contains and what an import reads. A zip a user carries between devices
      should not be a database file with a schema version in it.
- [x] **Requires a native rebuild** — new native module, and it registers a
      config plugin. `npx expo config --type prebuild` verified clean.

**The public API did not change.** `loadLibrary()` still returns a `Library` and
`saveLibraryNow()` still takes one, so the store, the exporter and the restore
path needed no edits. What changed is underneath.

#### How row-level writes were reached without rewriting every reducer

The store hands down a whole library, not a list of edits — which is the right
shape for a store, and the wrong shape for a row-level write. So
[libraryDiff.ts](src/storage/libraryDiff.ts) works out what actually changed,
and it is **pure and dependency-free**: `expo-sqlite` cannot load under Node, so
putting the decisions there means the half that decides what to *delete* is the
half that can be tested. The SQL layer holds no policy at all.

A **shadow copy** of what was last written is what the diff compares against.
Two rules make it safe, and both are load-bearing:

- it is **copied, never aliased** to a live store object — an alias would track
  the very changes it exists to detect, every diff would come back empty, and
  nothing would ever be written again while looking perfectly correct in memory;
- it is updated **only after a write succeeds**, so a failed write is retried
  rather than assumed to have landed.

#### Two things in the plan that turned out to be wrong

**"`pruneOrphans` becomes a query rather than a directory walk" is not
achievable.** Finding an orphan means finding a file *on disk* that no entry
references — SQLite knows nothing about the disk, so the walk is irreducible.
The keep-set was already O(entries) and a `SELECT storedName, thumb` is the same
work by another name. Left as it is, deferred and throttled by P3-3.

**A per-group query API was written and then removed.** The whole library is
read once at startup into a normalized store whose membership lookup is already
O(1) from P3-1, so `SELECT ... WHERE groupId = ?` would cross into native code
to answer what a map in memory answers for free. Shipping it unused would have
been dead code in the most dangerous file in the project. The composite index
stays — it serves the ordering of the one full read.

#### The safety hole this opened, and closed

Worth recording because it is [§6.3](DETAIL.md) reachable by a brand-new route.

A database that **fails to open** yields an empty library — indistinguishable
from a fresh install. `load()` passes that straight to `schedulePruneOrphans()`,
which would have observed that nothing referenced any file on disk and **deleted
the user's entire library**.

Closed at both ends:

- `schedulePruneOrphans` now returns immediately on an empty library. Skipping
  costs disk space that is already wasted; running costs everything.
- `loadLibrary` catches an open failure, logs it as an error and returns empty
  rather than throwing — nothing upstream catches it, so a throw would leave the
  board permanently blank. The empty **shadow** means the next save computes
  inserts rather than deletes, so a recovered database is repopulated instead of
  being emptied to match a library that failed to load.

These two rules are a pair and neither should be changed without the other; both
say so in the source.

**Tests:** [libraryDiff.test.ts](src/__tests__/libraryDiff.test.ts) — 15 tests.
An unchanged library writes nothing; a rename touches one row and no files; a
cross-group move is an update and never a delete-plus-insert (a crash between
those halves would lose the file *and* leave its bytes to be collected as an
orphan); **every persisted field is compared**, which is the one that matters —
a field missing from the comparison is a field whose changes never reach disk,
invisible until a process kill; clearing an optional field is a change; a
snapshot does not alias its source; and a 5,000-file library with one edit
writes exactly one row.

**Verify on device — this is the part tests cannot cover:**
1. Upgrade over an existing install → the library is intact and complete.
2. Add files, force-quit from recents, reopen → everything is still there.
3. Delete every file, force-quit, reopen → they stay deleted and are **not**
   resurrected from the old `library.json`.
4. Export, then import on a clean install → round-trips.
5. Force-quit repeatedly while dragging cards → no corruption, no loss.

### ☑ P3-3 — Defer and throttle `pruneOrphans`

Resolves [AUDIT §2.3](AUDIT.md).

**Files:** [src/storage/files.ts](src/storage/files.ts),
[src/store/library.ts](src/store/library.ts)

- [x] New `schedulePruneOrphans()` wraps it in
      `InteractionManager.runAfterInteractions`
- [x] Throttled to once per day via `LAST_PRUNE_KEY` in MMKV
- [x] The timestamp is recorded **only on success**, so a failed pass retries
      next launch rather than being skipped for a day
- [x] `pruneOrphans()` itself is unchanged and still exported, with a docstring
      pointing callers at the scheduled version
- [x] **Kept running.** It is the safety net for a crash between "copy
      succeeded" and "index saved". The [DETAIL.md §6.3](DETAIL.md) incident was
      caused by a silent *write* failure upstream — this routine behaved
      correctly on a bad index, and the docstring now says so, so nobody deletes
      it on a misreading of that history.

**Verify:** Cold start with 5,000 files → board paints without the startup stall.

### ☑ P3-4 — Virtualize the vertical axis only

Resolves [AUDIT §2.6](AUDIT.md).

**Files:** [src/screens/LibraryScreen.tsx](src/screens/LibraryScreen.tsx)

- [x] Outer `ScrollView` → `FlatList` with `windowSize={3}`,
      `removeClippedSubviews`, `maxToRenderPerBatch={4}`, `initialNumToRender={4}`
- [x] **Not FlashList** — zero new dependencies, as required
- [x] Horizontal rows stay plain `ScrollView`s, so no nested virtualization
- [x] Header and "+ New group" moved to `ListHeaderComponent` /
      `ListFooterComponent` rather than being dropped
- [x] `LayoutAnimationConfig skipEntering` **now wraps the list**, not the rows.
      With virtualization the rows mount and unmount as they scroll, so wrapping
      each row would replay its entering animation on every remount — a bug the
      unvirtualized version could not have.

### ☑ P3-5 — Stream the backup export

Resolves [AUDIT §3.4](AUDIT.md).

**Files:** [src/storage/backup.ts](src/storage/backup.ts)

- [x] Streams with `fflate`'s `Zip` + `ZipPassThrough`, writing through
      `File.writableStream()` — each file is read, pushed and released before
      the next is touched, so peak memory is roughly the largest single file
- [x] `MAX_EXPORT_BYTES` removed, with a comment explaining why the cap existed
      and why nothing replaces it
- [x] `ZipPassThrough` (stored, not deflated) preserves the previous `level: 0`
      — the payload is already-compressed PDFs, images and EPUBs
- [x] Errors from fflate's callback are captured and re-thrown on the main path
      rather than escaping as unhandled; the writer is closed in `finally`
- [x] Path-traversal guard in `importLibraryArchive` untouched
- [x] Tests: [backup.test.ts](src/__tests__/backup.test.ts) round-trips a
      streamed archive through `unzipSync` — every entry present, binary content
      byte-identical (including NUL and invalid-UTF-8 bytes), 60 entries intact,
      empty library valid, and entries confirmed stored rather than deflated

**Why the round-trip test matters here:** this is the one feature a user may
depend on to recover everything they own. The streaming API fails in ways that
produce a *plausible* file — a missing `end()`, an entry pushed without its
final flag — which would surface only on restore, when the original is gone.

---

## P4 — Large-EPUB memory — ✅ complete (via blob URLs, not file access)

### ☑ P4-1 — Stream images as blobs instead of inlining base64

Resolves [AUDIT §2.4](AUDIT.md). The deferred item from
[DETAIL.md §7.1](DETAIL.md).

> **This is a security-relevant change and gets its own review.** It re-enables
> file access that [§4 of DETAIL.md](DETAIL.md) switched off on purpose. Do not
> land it at the end of a feature batch.

**Files:** [src/renderers/webview/epub.ts](src/renderers/webview/epub.ts),
[src/renderers/WebViewRenderer.tsx](src/renderers/WebViewRenderer.tsx),
[src/storage/paths.ts](src/storage/paths.ts)

> ### ⚠ The original plan was not implementable on Android
>
> This task specified `allowingReadAccessToURL` scoped to one directory. **That
> prop is iOS/macOS only** — verified in
> `react-native-webview/lib/WebViewTypes.d.ts`, where it appears solely on the
> iOS and macOS prop interfaces.
>
> Android's only equivalent is `allowFileAccess={true}`, which is **not scoped**:
> it grants the WebView read access to the entire app sandbox, not one folder.
> For a viewer rendering untrusted EPUB content that is materially worse than
> the posture [DETAIL.md §4](DETAIL.md) deliberately established, and it is not
> what this task was approved on.
>
> `WebViewAssetLoader` (androidx.webkit) *is* the correct scoped Android answer
> and the dependency is already present — but `react-native-webview` does not
> expose it, so using it means patching or forking the library's Java.
>
> **Implemented with blob URLs instead**, which solves the memory problem with
> **no weakening of the security posture at all** — and needed no rebuild.

**Implemented:**

- [x] Images are no longer embedded as `data:` URIs. The markup carries an
      opaque token in `data-sr-img`; the bytes travel separately and the viewer
      turns each into a `blob:` URL via `URL.createObjectURL`
- [x] `allowFileAccess`, `allowFileAccessFromFileURLs` and
      `allowUniversalAccessFromFileURLs` **all remain false** — the viewer still
      cannot reach the filesystem at all
- [x] `originWhitelist`, the `onShouldStartLoadWithRequest` guard,
      `domStorageEnabled={false}` and `setSupportMultipleWindows={false}`
      unchanged
- [x] Applied to **all three image paths**, not just EPUB: books, CBZ comics
      (the most image-heavy format the app opens) and ZIP previews
- [x] Images are encoded lazily, one at a time, on the worklet runtime as they
      are delivered — so a book closed after two pages never pays to encode
      illustrations the reader never reached
- [x] Blob URLs are revoked on `pagehide`; a live blob reference stops the
      browser reclaiming its bytes
- [x] Image arrival triggers a **coalesced** re-measure — an image shifts every
      page anchor below it, but measuring per image would be O(images) full
      passes
- [x] Budgets now count **raw bytes** rather than base64, since that is what is
      actually held
- [x] Sanitisation unchanged and verified: both the native pass and the viewer's
      DOM pass preserve `data-sr-img` while still stripping handlers from the
      same element
- [x] Tests: [blobImages.test.ts](src/__tests__/blobImages.test.ts)

**`isInsideLibrary()` is deliberately still absent.** It was recorded as absent
so it would return *with* file access. No file access was granted, so there is
nothing for it to guard — restoring it would reintroduce exactly the problem
[paths.ts](src/storage/paths.ts) documents: a comment asserting a security
posture the code does not have.

### The bug this nearly introduced

`prepareCache.sizeOf()` measured `content.length` only. With images moved out of
`content`, a 20MB illustrated book would have reported as a few hundred
kilobytes of text — so the byte budget would have admitted several of them and
reproduced the exact memory exhaustion this task exists to fix. Fixed, and
pinned by three tests in
[prepareCache.test.ts](src/__tests__/prepareCache.test.ts).

**Verify:** A heavily illustrated EPUB and a 40-page CBZ both open without
memory pressure; images fade in shortly after the text.

---

## P5 — Deferred from P1 — ✅ complete

### ☑ P5-1 — PDF cover thumbnails

Split out of P1-1, which shipped covers for every format that has one *stored*.
A PDF page is drawn rather than stored, so it is the one case that needs
rasterising — and `react-native-pdf` exposes no page-to-image API.

**Files:** [src/storage/thumbs.ts](src/storage/thumbs.ts) (seam exists),
[src/renderers/PdfRenderer.tsx](src/renderers/PdfRenderer.tsx)

- [x] `react-native-view-shot@5.1.0` (Expo-pinned) captures the mounted PDF view
- [x] Calls the existing `captureFirstPage(entry, uri)`, so a PDF cover gets the
      same downscale, ThumbHash and destination as every other thumbnail
- [x] **Rides the document the reader already has open** — no off-screen PDF
      view is ever mounted, so the three-live-pdfium-documents crash
      ([DETAIL.md §8](DETAIL.md)) cannot recur
- [x] `canThumbnail()` still returns false for PDF, deliberately: the generic
      generator has no image to extract, and returning true would make it try
      and fail on every PDF card

**Three guards, so a capture never disturbs reading:**

- only for the file the user is actually looking at (`active`);
- only once per file, and only when the entry has no thumbnail yet;
- **only when the restored page is 1** — reopening a book at page 40 must not
  overwrite its cover with a picture of page 40.

**Two implementation details that would otherwise bite:**

*`collapsable={false}` is required* on the captured view. React Native flattens
view hierarchies on Android, and a collapsed view has no native handle — the
capture fails with an unhelpful error rather than a blank image.

*A short settle before capturing.* `onLoadComplete` fires when the document is
*parsed*, not when the page has finished rendering; capturing immediately yields
a blank or half-drawn sheet. The capture is deferred past interactions plus a
400 ms settle, which also keeps the rasterise off the critical path of opening a
file.

**⚠ Needs a native rebuild** — `react-native-view-shot` is a new native module.
No `app.json` change was needed (autolinking, no config plugin).

---

## P6 — Frame-rate consistency — ✅ complete

From the [second-pass re-audit](AUDIT.md). Every P0–P5 finding was re-verified
against the code first; these are new, and they are a different *kind* of
problem from the first audit's.

The first pass found structural faults — work in the wrong scope, data in the
wrong shape. These are **frequency** faults: cheap operations sitting on a path
that runs sixty times a second. That is why none of them appeared in the first
read, and why they show up on device as "smooth when still, not quite smooth
when moving" rather than as a stall.

> All four are JS-only and arrive over Fast Refresh. `npm run check` passes —
> **135 tests, up from 132.**

### ☑ P6-1 — Stop posting scroll frames that changed nothing

Resolves [AUDIT §6.1](AUDIT.md). The busiest path in the app.

**Files:** [src/renderers/webview/viewerHtml.ts](src/renderers/webview/viewerHtml.ts)

- [x] The viewer remembers the last position it posted and returns early when
      page, total, rounded percent and whole-pixel `scrollY` all match
- [x] **`scrollY` compared as a rounded integer** — momentum scrolling produces
      sub-pixel offsets, so comparing the float would differ every frame and the
      check would never fire. This is the difference between the optimization
      existing in the source and existing in effect.
- [x] Seeks, resizes and re-measures pass `force`: landing where you already
      were must still confirm arrival, or a jump is never acknowledged
- [x] Tests execute the **real emitted function** against stubbed geometry —
      unchanged frames post nothing, sub-pixel drift is absorbed, a page change
      always reports, and `force` bypasses the check

**What it removes per skipped frame:** one JSON serialize, one bridge crossing,
one JSON parse, three MMKV reads, up to three MMKV writes, one Zustand `set`.

**Verify:** Flick through a long EPUB. The page indicator should track exactly
as before — this changes what is *sent*, never what is *shown*.

### ☑ P6-2 — Drop the read-before-write in the scroll store

Resolves [AUDIT §6.2](AUDIT.md).

**Files:** [src/store/scroll.ts](src/store/scroll.ts)

- [x] A module-level mirror of the last value written replaces
      `storage.getNumber(key) === value`. This module is the only writer, so
      what it last wrote is what is stored.
- [x] `getScroll`/`getZoom`/`getProgress` warm the mirror, so restoring a
      position does not immediately rewrite the value it just loaded
- [x] **`forgetFile` deletes the mirror entry too** — the cache-invalidation bug
      this pattern invites. Without it, re-importing a file and writing the same
      progress would be skipped as "unchanged" while the key stayed deleted.
- [x] Documented on `setProgress` *why* the rounding is load-bearing rather than
      cosmetic: every card subscribes to that key via `useMMKVNumber`, so an
      unrounded value would re-render the board continuously behind the reader

### ☑ P6-3 — Animate the page-dots window slide

Resolves [AUDIT §6.3](AUDIT.md). This is the specific thing that prompted the
re-audit: the pill changing position without feeling like it moved.

**Files:** [src/components/PageDots.tsx](src/components/PageDots.tsx)

- [x] New `SlidingRow` translates the strip by the distance its content jumped,
      then springs that offset back to zero with `Spring.snappy`
- [x] The dot animations are **untouched** — this cancels a discontinuity they
      were already fighting rather than adding a competing animation
- [x] Applied in an effect, not a `useDerivedValue`: a derived value re-runs on
      the shared values it *reads*, and `start` is a plain prop. Same trap
      already documented on `Dot`, and it would have produced the same bug.
- [x] Dots stay keyed by slot, so their springs continue across the shift

**Why it was only visible sometimes:** in a group of 12 or fewer the window
never slides and the capsule was always correct. Past 12 the capsule springs
forward while every dot shifts back instantly, so it appears to lurch and land
short — worst in exactly the large groups the sliding window exists for.

**Verify:** A group of 20+ files. Swipe past the middle, where the window starts
sliding — the strip should move as one piece.

### ☑ P6-4 — Stop re-registering the thumbnail effect on every card

Resolves [AUDIT §6.4](AUDIT.md).

**Files:** [src/components/useThumbnail.ts](src/components/useThumbnail.ts)

- [x] Keyed on `file.id` plus "does this still need a thumbnail", instead of on
      the whole `FileEntry`
- [x] The entry is read through a ref assigned during render, so
      `ensureThumbnail` still receives current data without it being a dependency
- [x] No behaviour change — the guard already prevented duplicate work; this
      removes the effect teardown/re-register churn around it

**Why it was invisible:** `setThumb` replaces the entry object, so completing a
thumbnail re-triggered the effect that produced it. The existing guard caught it
before any work ran, so nothing was ever *wrong* — there was just a burst of
effect churn across the whole board every time one landed, during import, while
the board is being scrolled.

---

## Ongoing — testing

### ☐ T-1 — Behavioural tests for lifecycle

Resolves [AUDIT §5](AUDIT.md).

Every P0 finding is a lifecycle or staleness bug that on-device testing surfaces
only by chance. The existing suite covers pure logic well; the gap is
**behavioural**.

- [ ] Add `@testing-library/react-native` with mocked MMKV and `expo-file-system`
- [ ] Assert *"backgrounding flushes the index"* as a test rather than a habit
- [ ] Assert *"leaving the reader clears the pins"* (pairs with P0-2)
- [ ] Assert *"a removal interrupted by a kill stays removed"*
- [ ] Keep the existing Node-runner suite — it needs no transform and costs
      nothing; this is additive
- [ ] Wire into `npm run check`

This is the durable version of the [DETAIL.md §6.10](DETAIL.md) lesson: a
written-down rule does not enforce itself.

---

## Not doing (and why)

Recorded so they are not re-proposed:

- **FlashList for the board.** Removed deliberately — an unused native module is
  real weight in the APK. `FlatList` on the vertical axis only (P3-4) gets the
  benefit without the dependency.
- **Mounting pager neighbours for instant page turns.** Crashed pdfium inside
  `FPDF_LoadPage` and hung on multiple EPUBs. The prepared-document cache is the
  replacement and it works ([DETAIL.md §8](DETAIL.md)).
- **Raising `CHUNK` in `toBase64` "for speed".** It is the fix for a stack
  overflow on large comic pages, not a tuning knob
  ([bytes.ts](src/renderers/webview/bytes.ts)).
- **Sharing `IMAGE_RE` between the EPUB and archive paths.** They want different
  sets on purpose; merging quietly widens what a CBZ may contain.
- **Relaxing any WebView flag outside P4-1.** The one planned exception is scoped
  and reviewed on its own.
- **Cross-group drag on the board.** A product requirement, not an oversight —
  moves live behind the 3-dot menu so they are always deliberate.

---


---

## P7 — The droplet marker — ✅ complete

Not from the audit. A direct request: the page-dots pill should move like a
water droplet rather than appearing at its destination.

**Files:** [src/components/PageDots.tsx](src/components/PageDots.tsx),
[src/components/pageDotsGeometry.ts](src/components/pageDotsGeometry.ts) (new),
[src/components/HorizontalPager.tsx](src/components/HorizontalPager.tsx),
[src/screens/ReaderScreen.tsx](src/screens/ReaderScreen.tsx)

### ☑ P7-1 — Make the marker a travelling body

The pill **never actually moved**. Each dot animated its own `active` flag, so
the outgoing dot shrank while the incoming one grew — a crossfade. Nothing
crossed the gap, which is why no amount of tuning the springs would have made it
feel like motion.

- [x] Dots are now inert: they only ramp at the window edges
- [x] One capsule is drawn over them, translating between slot centres
- [x] Removes the animated layout width the previous version paid for per frame —
      slots are now a fixed size, so the row no longer re-lays-out mid-animation

### ☑ P7-2 — Follow the finger, not the committed index

- [x] `HorizontalPager` publishes its live position as a float file index,
      derived from `translateX` with `useAnimatedReaction` so it covers the drag,
      the settle spring *and* external index changes with one definition
- [x] `ReaderScreen` owns the shared value; the pager writes it, the dots read it
- [x] It stays on the UI thread end to end — following the finger costs **no
      re-renders**, and the JS thread still sees only a committed index change
- [x] The rubber-band at a group's ends is included, so the drop leans against
      the boundary and springs back rather than stopping dead

### ☑ P7-3 — Deform like a droplet

Modelled rather than keyframed: a **leading edge** that tracks the swipe exactly
and a **trailing edge** that lags behind it on a slower spring. The body is
drawn between the two, so it elongates while travelling and rounds up on
arrival. The stretch *emerges from* the movement instead of being a separate
animation that could fall out of sync with it.

- [x] Volume roughly conserved — it thins as it stretches, capped so a fast
      flick cannot reduce it to a hairline
- [x] `borderRadius` tracks half the height at every moment, so the caps stay
      semicircular however far it is stretched
- [x] The trailing spring is deliberately **local, not a `ui/motion` token**: it
      has to stay slower than whatever moves the head, because the gap between
      them is the effect. A shared token would be tuned for arrival speed, and
      making it snappier would silently flatten the droplet.
- [x] Degrades correctly under "remove animations": with springs instant, head
      and tail coincide and it becomes a plain capsule — no special-casing

### ☑ P7-4 — Marker outside the sliding row

A bug caught while wiring it, worth recording because it is not obvious.

`SlidingRow` translates the dots to absorb the jump when the window moves. The
marker must **not** be inside it: once the window is sliding, the active file
keeps the same slot, so the marker should hold still while the dots stream past.
Carried along by the row's correction it would swing a slot sideways and back on
every turn — worse than the jump that correction exists to remove.

### ☑ P7-5 — Geometry extracted and tested for real

- [x] `pageDotsGeometry.ts` holds the window/edge/centre maths, free of React
      and Reanimated
- [x] [pageDots.test.ts](src/__tests__/pageDots.test.ts) now imports the real
      functions. It previously kept its own copy plus a regex drift-check,
      because the component cannot load outside a device runtime — that
      duplication is gone.
- [x] New coverage: centres strictly increasing (a flat pair would stall the
      marker mid-swipe), centres inside their own slot, and the droplet's shape —
      resting capsule, symmetric stretch in both directions, capped thinning,
      semicircular caps at every span

**Still device-unverified.** The shape maths and geometry are pinned by tests,
but nothing here proves how it *feels* — that needs a physical device. The two
numbers to adjust are `TRAIL` (more lag, more stretch) and `MAX_SQUASH`.

---

## P8 — File-id lifetime — ✅ complete

From the third-pass audit ([AUDIT §1](AUDIT.md)). **Do this phase first** — it is
the only one on this list that loses user data or shows the wrong document, and
it is a few hours of work.

The five tasks below share one root cause, so they are one piece of work rather
than five. The app has grown **five caches and side tables keyed by `file.id`** —
`prepareCache`, `thumbs.attempted`, `prefetch.failed`, `files.sizeCache` and the
`scroll.ts` mirror. Each was added with a correct local justification. Nothing
owns the question of *when a file id stops being valid*, so two of the five have
an invalidation function that is never called, and the one operation that
invalidates all of them at once — restore from backup — calls none of them.

The previous two audits found **structural** faults (work in the wrong scope) and
**frequency** faults (cheap work on a hot path). These are **lifetime** faults,
and they were only findable by grepping for callers: `forgetFile` is a
well-written, well-commented, correct function, which is exactly why nothing
about it looks wrong in place.

### ☑ P8-1 — One owner for file-id invalidation

Resolves [AUDIT §1.2](AUDIT.md), [§1.3](AUDIT.md) and [§2.5](AUDIT.md). Do this
before P8-2 and P8-3 — both of them call into it.

**Files:** `src/storage/lifecycle.ts` (new),
[src/store/scroll.ts](src/store/scroll.ts),
[src/storage/files.ts](src/storage/files.ts),
[src/storage/thumbs.ts](src/storage/thumbs.ts),
[src/renderers/webview/prefetch.ts](src/renderers/webview/prefetch.ts),
[src/renderers/webview/prepareCache.ts](src/renderers/webview/prepareCache.ts)

- [x] New module exporting `forgetFileEverywhere(fileId)`, which calls
      `forgetPrepared`, `forgetFile`, `resetThumbnailAttempt`, and clears the
      `failed` and `sizeCache` entries for that id
- [x] Export `resetAllCaches()` alongside it, for the wholesale case
- [x] Add `forgetSize(fileId)` to [files.ts](src/storage/files.ts) —
      `sizeCache` currently has no invalidation of any kind
- [x] Add `forgetPrefetchFailure(fileId)` next to the existing
      `resetPrefetchFailures()`
- [x] Call `forgetFileEverywhere` from `pendingRemoval.commit` and
      `resumeInterrupted`, replacing the bare `forgetPrepared` calls there
- [x] Call `resetAllCaches()` from `useLibrary.reload()`

**Why a new module rather than a function in one of them.** It has to import
from `store/`, `storage/` and `renderers/`, so it belongs to none of them —
putting it in any one creates an import cycle. It is also the natural home for
the rule itself as a docstring, which is what stops the sixth cache being added
without one.

**Verify:**
1. Delete a file, then check MMKV no longer holds `scroll:<id>`, `zoom:<id>` or
   `progress:<id>` — log the keys, or read them back through `getScroll` and
   confirm 0.
2. Export a backup, delete a file from the library, restore that backup, open
   the restored file → it opens its own content, not the previously-parsed
   document, and generates a fresh thumbnail.
3. Re-import a file that previously failed to prepare → it is retried rather
   than being remembered as broken.

### ☑ P8-2 — Deleting a group must delete its files

Resolves [AUDIT §1.1](AUDIT.md). The largest deletion path in the app, and the
only one with no undo.

**Files:** [src/store/library.ts](src/store/library.ts),
[src/screens/LibraryScreen.tsx](src/screens/LibraryScreen.tsx),
[src/store/pendingRemoval.ts](src/store/pendingRemoval.ts)

[library.ts:196](src/store/library.ts#L196) drops every file of a removed group
from the index, under the comment `// Files in a removed group go with it;
callers delete the bytes`. There is exactly one caller
([LibraryScreen.tsx:259](src/screens/LibraryScreen.tsx#L259)) and it is
`onPress: () => removeGroup(group.id)`. Nothing deletes the bytes, and nothing
invalidates the caches.

The user is told plainly this is happening — the button reads *"Delete group and
12 file(s)"* and the dialog confirms it. The bytes then survive until
`pruneOrphans` runs, which is **at most once per day** and **refuses on an empty
library**, so deleting your last group strands them until you import something
and wait a day.

- [x] Route group deletion through `usePendingRemoval.queue` per file, so it
      inherits the undo window, the durable MMKV record and P8-1 invalidation
- [x] Then remove the group itself once its files are queued
- [x] One toast for the group rather than twelve — extend `UndoToast` to accept
      a count, or queue the group as a single undoable unit
- [x] Delete the `// callers delete the bytes` comment; if any obligation
      remains on the caller, name the caller in the comment

**Why route through the undo path rather than calling `deleteFromLibrary` in a
loop.** Deleting twelve files at once is precisely where an undo matters most,
and that path already solves the durable-record and cache-invalidation problems
correctly. Reimplementing half of it beside it is how the two drift.

**Verify:**
1. Create a group, add three files, note the library dir size, delete the group,
   wait past the undo window → the three files are gone from disk immediately,
   not a day later.
2. Delete a group and undo inside the window → all files come back, in the same
   group, in the same order.
3. Delete a group, force-quit inside the undo window, reopen → the files stay
   deleted (`resumeInterrupted` finishes the job).

### ☑ P8-3 — Size ceilings before the read, not after

Resolves [AUDIT §1.6](AUDIT.md).

**Files:** [src/renderers/webview/prepare.ts](src/renderers/webview/prepare.ts),
[src/storage/formats.ts](src/storage/formats.ts)

`prepareFile` checks `MAX_BYTES` (6 MB) only in the `default` branch — markdown,
text and HTML. DOCX, XLSX, CBZ and ZIP each call `await target.bytes()`
unguarded, so the whole file is materialised and then unzipped before any of the
existing image budgets apply. A 500 MB ZIP is read whole, expanded whole, and
copied across the worklet boundary.

EPUB is already safe: `loadEpubAsHtml` streams chapter by chapter.

- [x] Per-format ceiling in [formats.ts](src/storage/formats.ts), beside the
      rest of the format table
- [x] Check it in `prepareFile` **before** `await target.bytes()`, using
      `entry.size` which import already records
- [x] Fall back to `target.size` for entries imported before that field existed
- [x] Refuse with a real message naming the limit, the way the `default` branch
      already does

**Verify:** open a deliberately huge CBZ or ZIP → a clear refusal, not an OOM
kill. Confirm a normal comic still opens.

### ☑ P8-4 — Delete `lastScroll`, or give it a writer

Resolves [AUDIT §1.4](AUDIT.md).

**Files:** [src/types.ts](src/types.ts), [src/storage/db.ts](src/storage/db.ts),
[src/storage/libraryDiff.ts](src/storage/libraryDiff.ts)

`lastScroll` is declared, documented as *"the persisted copy"* of the reading
position, carried through the SQLite column, both INSERT statements, `toEntry`
and the `fileChanged` comparator. **Nothing assigns it.** Scroll position lives
entirely in MMKV.

Resolve it in whichever direction P8-5 goes: if backups carry positions, this
field gets a real writer and a real purpose; if not, it should go.

**Decided: kept, with a writer** — because P8-5 needed exactly this field. The
two really were one decision, and resolving P8-5 first settled it.

- [x] Decided with P8-5 — kept, not deleted
- [x] Writer added: `withPositions()` in [backup.ts](src/storage/backup.ts)
      stamps it from MMKV at export time
- [x] `lastProgress` added alongside it — progress comes from the renderer's own
      geometry, so nothing on the receiving device can re-derive it from a
      scroll offset without laying the whole document out first
- [x] Both compared in `fileChanged`, so a changed position actually persists
- [x] `SCHEMA_VERSION` bumped to 2, with an additive `ALTER TABLE` guarded by a
      `PRAGMA table_info` check — an existing library keeps its rows, and a
      fresh install gets the column from `CREATE TABLE` instead

**Not written on every scroll settle, deliberately.** That would put a row write
on the scroll path and undo the split `store/scroll` exists to maintain. MMKV
stays the live source of truth; this is a transport copy, written at the one
moment the value has to leave MMKV.

**Why not just delete it.** It was a standing invitation to "restore from
`lastScroll`", which would have read `undefined` every time. The comparator
docstring warns that a field missing from `fileChanged` never persists — a field
nothing writes is the mirror image, and equally misleading.

### ☑ P8-5 — Reading positions must survive a backup

Resolves [AUDIT §1.5](AUDIT.md).

**Files:** [src/storage/backup.ts](src/storage/backup.ts),
[src/store/scroll.ts](src/store/scroll.ts), [src/types.ts](src/types.ts)

The archive carries `library.json` and the file bytes. Reading positions, zoom
and progress live in MMKV, which is **not** in the archive. Restore on a new
phone and every book opens at page one with every card at 0%.

The export presents itself as *"everything — the index and every stored file —
round-trips through one archive"*. For a reading app, where you are in a book is
arguably the most valuable thing after the files themselves.

- [x] Read the three MMKV values per file when building the export
- [x] Write them into the exported `library.json` — as fields on each entry
      (which gives P8-4 field its writer) or as a sidecar object
- [x] On restore, write them back into MMKV **before** `replaceLibrary`, so the
      first render already has them
- [x] Tolerate their absence: an older archive must still restore

**Verify:** read into the middle of three files, export, wipe the app data,
restore → all three reopen at their saved positions and their cards show the
right progress.

### What the plan did not anticipate

Three things came out of building it, all worth recording.

**A group deletion needs to restore the *group*, not just its files.** The plan
said "route through `usePendingRemoval.queue`", which handles files and knows
nothing about rows. Undoing would have brought twelve files back into a group
that no longer existed. So `queueGroup` takes an `onUndo` closure and the store
gained `restoreGroup` — which keeps the group's **id**, because every restored
file's `groupId` still points at it, and `addGroup` mints a new one.

**A batch needs one timer, not twelve.** Twelve `setTimeout`s firing within a
millisecond of each other each run a `set`, so the board would re-render twelve
times for one action. One timer on the first item commits the whole batch, and
`clearTimeout(undefined)` is a spec no-op, so the other items carrying no timer
are safe.

**Two counts disagreed, and the dialog was using the wrong one.** `groupCounts`
deliberately includes files inside their own undo window — right for "how big is
this row", wrong for "how many will this delete". A file already being removed
individually is skipped by the delete (including it would let undoing the
*group* resurrect a file the user deleted on purpose), so the dialog now counts
the same set the action acts on. This is [AUDIT §1.7](AUDIT.md)'s lesson landing
a second time: the promise and the behaviour have to match.

**One thing the tests caught immediately.** Two of the first-draft structural
tests failed against correct code — they matched prose inside the new comments
explaining what had been fixed. A test that cannot tell an explanation from the
thing it explains punishes documenting the fix, so both now match code
(a full-line regex, and the actual read expressions) rather than substrings.

---

## P9 — Perceived speed, second pass — ✅ complete

Resolves [AUDIT §3.1](AUDIT.md) and [§3.4](AUDIT.md). Nothing structural; this
is what closes the remaining distance to Drive on *feel*.

### ☑ P9-1 — ThumbHash as the reader loading state

**Files:** [src/renderers/WebViewRenderer.tsx](src/renderers/WebViewRenderer.tsx),
[src/renderers/PdfRenderer.tsx](src/renderers/PdfRenderer.tsx),
[src/storage/thumbhash.ts](src/storage/thumbhash.ts)

Every card already carries a ThumbHash (~25 bytes, in the index, decodes in
under a millisecond) — P1-2 put it there. The **reader** still shows a bare
`ActivityIndicator` on a grey field
([WebViewRenderer.tsx:492](src/renderers/WebViewRenderer.tsx#L492)).

Drive never shows nothing. It shows something structurally correct immediately
and refines in place.

- [x] Decode `file.thumbhash` and paint it full-bleed behind the spinner,
      blurred and dimmed
- [x] Cross-fade to the document on `ready` rather than cutting
- [x] Fall back to the current plain background when a file has no hash

**Why this is worth doing before anything harder.** It costs no parsing work at
all and changes what the wait *reads* as: the document arriving rather than the
app thinking.

### ☑ P9-2 — Persist prepared HTML to disk

**Files:** [src/renderers/webview/prepareCache.ts](src/renderers/webview/prepareCache.ts),
`src/renderers/webview/diskCache.ts` (new)

`prepareCache` is memory-only and is cleared wholesale on backgrounding — right
for memory pressure, but it means **every cold open reparses from scratch**:
unzip, assemble, re-derive the page list.

- [x] Write the prepared string beside the file, keyed by `id` **and** file
      mtime/size, so a replaced file invalidates its own cache
- [x] Read it on a miss in the memory cache, before falling back to `prepareFile`
- [x] Budget the directory and evict oldest-first; this is disk, so the budget
      can be far larger than the 24 MB memory tail
- [x] Do **not** cache images this way — they already stream as blobs, and
      writing them back out would undo P4-1
- [x] Hook into P8-1 invalidation

**Verify:** open a large EPUB, force-quit, reopen → measurably faster the second
time. Replace the file bytes and confirm the cache is bypassed.

### ☑ P9-3 — PDF covers at import, not first open

Resolves [AUDIT §3.4](AUDIT.md).

**Files:** [src/storage/thumbs.ts](src/storage/thumbs.ts),
[src/screens/LibraryScreen.tsx](src/screens/LibraryScreen.tsx)

P5-1 captures page 1 the first time a PDF is opened, which is correct as far as
it goes — but it means a PDF shows a coloured badge until you have read it. That
is exactly backwards: the board first impression is of the files you have
**not** got to yet.

- [x] Mount a headless `Pdf` off-screen during import and capture page 1 through
      the existing `captureFirstPage` path
- [x] One at a time, behind `InteractionManager`, reusing the `MAX_CONCURRENT`
      gate already in [thumbs.ts](src/storage/thumbs.ts)
- [x] Leave the first-open capture in place as the fallback for existing
      libraries

**Watch for:** the pdfium lifecycle. DETAIL §8 records that unmounting a PDF
mid-render crashed inside `FPDF_LoadPage`. Capture must complete before unmount,
and imports must not run two documents at once.

### ☑ P9-4 — Cache `scrollHeight` in the viewer

**Files:** [src/renderers/webview/viewerHtml.ts](src/renderers/webview/viewerHtml.ts)

Small and immediate. `progress()` reads `document.body.scrollHeight` on every
scroll frame, which forces a synchronous layout. It changes only when `measure()`
runs.

- [x] Cache it in `measure()`, read the cached value in `progress()`
- [x] Invalidate on `appendChunk` and `onImageSettled` — both already call
      `measure()`, so this is free
- [x] Extend `viewerHtml.test.ts` to pin that a resize updates it

**Why it survived P6.** P6-1 stopped *posting* unchanged frames, which removed
the bridge crossing. The layout read happens before that check, so it still runs
sixty times a second.

### What the plan did not anticipate

**The loading cover has to be held until `rendered`, not `payload`.** The
obvious wiring replaces the existing `!payload` spinner in place — and that
uncovers the moment the document has been *posted*, which is several frames
before it is in the DOM and measured. The result is a flash of blank white page:
the exact thing the cover exists to prevent, reintroduced by the fix for it.
Pinned by a test that fails on the `payload` version.

**Images are why the disk cache is narrower than it sounds.** `Prepared.images`
holds raw `Uint8Array`s, which do not survive JSON — and writing them out would
store a second copy of bytes already in the file, inflating every entry to the
size of the book and undoing the blob-streaming work of P4-1. So `writePrepared`
declines any document carrying images, and a hit is by construction a document
that needs none. That covers exactly the cases where the parse is expensive and
the output is text — DOCX, spreadsheets, un-illustrated EPUBs, large Markdown —
and leaves illustrated books reparsing, which is the honest trade.

**The cache key needs size and mtime, not just the id.** Ids are reused by
design: an export preserves them, and a re-import writes new bytes under an
existing id. A key of `id` alone would serve the previous document's parse. With
`id-size-mtime` a replaced file simply cannot name a stale entry, so that case
needs no explicit invalidation at all — `forgetPreparedOnDisk` exists to reclaim
space, not to prevent staleness.

**A disk hit must be promoted into memory.** Otherwise a file swiped away from
and back to reads the disk every time, and the pinned window — which exists to
make precisely that free — never holds it.

**The PDF cover factory cannot be headless.** `captureRef` photographs a live
native view: a `display: none`, zero-sized or transparent view has no pixels and
returns a blank. It has to be genuinely laid out at a real size, just off-screen
(`left: -10000`), with `collapsable={false}` so Android does not flatten away
the handle. One document at a time, because three live pdfium documents is the
crash that made the pager single-mount in the first place.

**The factory is driven by ids, not entries.** Its whole job is to call
`setThumb`; a selector returning entries would see each of those writes and
re-drive the effect that produced them — the same churn shape the second audit
found in `useThumbnail`. Returning ids means the list only ever gets shorter.

**And the file bit back once more.** P9-4's first draft put backticks in a
comment inside `viewerHtml.ts`, which terminated the template literal and
produced three `TS1005`/`TS1443` errors pointing at unrelated lines. This is
[DETAIL.md §6.11](DETAIL.md) and the [CLAUDE.md](CLAUDE.md) rule, hit again by
someone who had read both. The comment now says so in place.

### How P9 was verified

`npm run check` passes — **188 tests, up from 168**. The 20 new ones are in
[perceivedSpeed.test.ts](src/__tests__/perceivedSpeed.test.ts), and they are not
all the same strength, which is worth being explicit about:

- **P9-4 is tested by execution.** The real `progress()` is sliced out of the
  emitted viewer and run against a stubbed DOM whose `scrollHeight` getter
  *counts reads*. The assertion is that 120 scroll frames produce **zero** — the
  property the change exists to create — plus its arithmetic, its clamping, and
  the short-document case.
- **P9-2's decision logic is tested directly**; its file I/O needs
  `expo-file-system` and cannot run under Node.
- **P9-1 and P9-3 are checked structurally only.** They are React components
  over native views, so these tests assert the wiring, not that anything paints.

Each assertion was mutation-checked rather than assumed: reverting P9-4 fails 5
tests, removing the disk-cache line from `lifecycle` fails 1, and changing the
cover gate from `rendered` back to `payload` fails 1. A test that passes both
before and after the change it describes is not evidence of anything.

**Still device-unverified**, and these are the parts that need it: whether the
blurred cover actually reads as a document arriving rather than as a broken
image; whether the 400ms pdfium settle is long enough on a slow device; and
whether the disk cache measurably shortens a cold open on a real EPUB.

---

## P10 — Find-in-document — ✅ complete

Resolves [AUDIT §3.2](AUDIT.md). **The largest genuine feature gap** — the thing
a reader is most likely to reach for that this app cannot do at all.

### ☑ P10-0 — One hit shape, defined before either half

**Do this first.** It is fifteen lines and it decides whether P10 is one feature
or two.

**Files:** `src/search/types.ts` (new)

ReadEra — five rendering engines, twenty formats — implements search **once**,
in `orebridge/StSearchUtils.cpp`, over a common `Hitbox` (rect plus character
range) that every engine emits. They did not build PDF search and EPUB search;
they built one search over a normalised positioned-text representation.

The same split threatens here: PDF search returns `{page, rects}` in page
coordinates, WebView search returns DOM ranges in CSS pixels. Left alone that is
two features, two UIs and two sets of edge cases forever.

- [x] `SearchHit { fileId, charOffset, length, context, page?, rects? }`
- [x] `charOffset` is into the document's **extracted text**, which is the one
      thing both engines can agree on — and is the same coordinate P11's anchors
      and P12-5's FTS5 index use
- [x] `rects` optional: the WebView highlights with `<mark>` and needs none
- [x] Pure types plus helpers only — no imports, so it is testable in Node

**This is the reason to do P10 and P11 together.** Both need "a position in the
document that is not a pixel offset", and defining it once is what makes P11 a
consumer of P10's work rather than a parallel implementation of it.

### ☑ P10-1 — Search in the WebView formats

**Files:** [src/renderers/webview/viewerHtml.ts](src/renderers/webview/viewerHtml.ts),
[src/renderers/WebViewRenderer.tsx](src/renderers/WebViewRenderer.tsx),
[src/screens/ReaderScreen.tsx](src/screens/ReaderScreen.tsx),
`src/components/SearchBar.tsx` (new)

Nine of the eleven formats live in the viewer, so one implementation covers
almost everything.

- [x] Walk text nodes once per document into a flat `{node, start, end}` array —
      the same shape `visibleTextLength` already derives
- [x] Match over the concatenated text; `indexOf` in a loop is native and fast
      enough for a book, with Boyer–Moore–Horspool available if it is not
- [x] Wrap hits with `<mark>` via `Range.surroundContents`
- [x] Reuse the existing `seek` channel to move between hits
- [x] Report `{current, total}` back over the bridge, beside the page badge
- [x] Rebuild the index on `appendChunk`, so streaming content becomes
      searchable as it lands
- [x] Search bar in the reader chrome, dismissed by the same back-button
      priority the sheets use

**Not `window.find()`.** It cannot report a match count, cannot be styled, and
does not survive the DOM mutations that streaming appends cause.

### ☑ P10-2 — PDF search, via the engine already in the build

**Decided: a thin native module over `io.legere:pdfiumandroid`.** This task read
"deferred, deliberately" because `react-native-pdf` exposes no text layer —
true of its *JS API*, and not true of what it links against.

`react-native-pdf` depends on `io.legere:pdfiumandroid:1.0.32`, which is
compiled into the APK today. Reading the AAR in the Gradle cache, it wraps
pdfium's full text engine:

| Class | What it gives |
|---|---|
| `PdfTextPage` | `textPageGetText`, `textPageCountChars`, `textPageGetCharIndexAtPos`, `textPageGetRectsForRanges`, `textPageGetBoundedText` |
| `FindResult` | `findNext`, `findPrev`, `getSchResultIndex`, `getSchCount` |
| `FindFlags` | `MatchCase`, `MatchWholeWord`, `Consecutive` |
| `WordRangeRect` | `getRect`, `getRangeStart`, `getRangeLength` |

Plus a `suspend/` package of coroutine variants, and `getPageCharCounts` for
whole-document counts in one native call. **The capability is on the device; it
is simply not wired to JavaScript.**

**Files:** `modules/pdf-text/` (new Expo module),
[src/renderers/PdfRenderer.tsx](src/renderers/PdfRenderer.tsx)

- [x] Expo module exposing `search(uri, query, opts)`, `extractText(uri)` and
      `pageText(uri, page)`, all returning the P10-0 hit shape
- [x] Use the `suspend` wrappers so bulk work never touches the main thread
- [x] Open the document independently of the rendering view — no shared handle,
      so a search can never unmount a page mid-render (the `FPDF_LoadPage`
      crash in [DETAIL.md §8](DETAIL.md))
- [x] Highlight via `WordRangeRect` rects, in PDF page coordinates
- [x] Seek through the existing `pageNav` jump channel, exactly as the scrollbar
      does

**Why not the alternatives** (full matrix in the conversation record):
`react-native-pdf-jsi` does this out of the box but is a one-year-old,
60-star, single-maintainer project whose changelog shows regressions in
pinch-zoom and page-restore — the two behaviours that cost the most debugging
here. `pdf.js` is the healthiest project of all and needs no rebuild, but means
pushing whole PDFs across the bridge, which is the memory profile P4-1 removed,
and it contradicts the inert-viewer posture of [DETAIL.md §4](DETAIL.md). MuPDF
(what ReadEra uses) is AGPL, which an RN app cannot isolate the way ReadEra does
with separate processes. Commercial SDKs are lock-in for a capability already
shipped.

**Also considered and deferred: `expo-pdf-text-extract`.** Clean API, but on
Android it is strictly redundant with the above — and a *second* engine (PDFBox)
would extract text that disagrees with pdfium's on spacing, ligatures and
multi-column reading order, so a search offset from one would not line up with
indexed text from the other. One engine, one text representation. It becomes the
right call the day iOS lands, as the cheapest path to extraction parity.

**iOS is not covered by this task.** PDFKit's `PDFDocument.findString` is the
equivalent and is separate work; until then the affordance is disabled on iOS
rather than silently finding nothing.

---

---

## P11 — Position anchors — ✅ complete

Resolves [AUDIT §3.3](AUDIT.md).

### ☑ P11-1 — Store a CFI-like anchor instead of a pixel offset

**Files:** [src/renderers/webview/viewerHtml.ts](src/renderers/webview/viewerHtml.ts),
[src/renderers/WebViewRenderer.tsx](src/renderers/WebViewRenderer.tsx),
[src/store/scroll.ts](src/store/scroll.ts),
[src/storage/mmkv.ts](src/storage/mmkv.ts)

Page **counts** are correctly content-derived and survive rotation — that was
hard won ([DETAIL.md §5.2](DETAIL.md)). Position is not: the WebView path stores
`scrollY` in pixels
([WebViewRenderer.tsx:441](src/renderers/WebViewRenderer.tsx#L441)), so rotating
the phone or changing the font size moves the reader.

- [x] Report position as *nearest block element index + character offset into
      it*, alongside the existing `scrollY`
- [x] Restore by locating the element and advancing by the offset, falling back
      to `scrollY` when the anchor cannot be found
- [x] Store it under `locationKey`, which
      [mmkv.ts:20](src/storage/mmkv.ts#L20) already defines for exactly this —
      *"for formats that locate by something other than px (EPUB CFI)"* — and
      which currently has no callers
- [x] Keep `scrollY` as the fallback rather than replacing it; a malformed
      document with no stable elements still needs to restore somewhere

**The infrastructure is already there.** `measure()` builds the element list,
and `anchorIndexAt` already maps a scroll position to an anchor index. This is
mostly wiring, not new machinery.

**Verify:** open an EPUB, read to the middle, rotate → the same paragraph is on
screen. Change the font size → same paragraph. Both currently fail.

### P10-2 as built

**Files:** `modules/pdf-text/` (new Expo module, Android only),
[src/renderers/usePdfSearch.ts](src/renderers/usePdfSearch.ts),
[src/renderers/PdfRenderer.tsx](src/renderers/PdfRenderer.tsx)

Three exported functions — `search`, `extractText`, `pageText` — over
`io.legere:pdfiumandroid`, pinned to **the exact version `react-native-pdf`
already resolves** so Gradle reuses one copy of the native binary rather than
resolving two. A test asserts those two versions stay equal.

**It opens its own document, per call.** Reusing the rendering view's handle
would reintroduce the crash the pager was redesigned around — three live pdfium
documents, one unmounted mid-render, dead inside `FPDF_LoadPage`. A handle
opened and closed inside a single call cannot be invalidated by the renderer,
and cannot invalidate it. The cost is re-opening the document each time, which
is cheap because pdfium's open reads the cross-reference table rather than the
pages.

**It uses pdfium's own `FPDF_TextSearch`, not string matching over extracted
text.** That is a correctness argument before a speed one: pdfium knows where a
word is hyphenated across a line, which glyphs are ligatures, and how a
multi-column page reads. None of that survives naive matching.

**The JS half is a hook, not viewer code**, because a PDF has no DOM to hold
matches in — the hits come back as data, so something on the JS side must own
them. It reports into the same `useSearch` store the viewer does, so the search
bar sees one feature. Navigation moves to the match's page; the per-match rects
are carried on the hits so a highlight overlay can be added later without
changing any of this.

**Two things the compiler caught that reading would not have.**
`findStart` returns a **nullable** `FindResult?` — pdfium builds no search
handle for a page with no usable text index, which is a normal page in a real
document (an image-only scan) rather than an error. It is now skipped so the
search continues through the rest of the document. And `requireOptionalNativeModule`
is load-bearing: this module is imported by the reader, and a JS bundle
routinely outruns the native binary during development, so the non-optional form
would turn "PDF search unavailable" into "the reader will not load" — the same
failure the deferred view-shot import already guards against.

### What P10 and P11 taught, and how they were verified

**They are one feature, and doing them together proved it.** Both needed "a
position in the document that is not a pixel offset". The search index — a flat
array of text nodes plus one concatenated string — *is* the anchor mechanism:
`anchorAtTop()` and `scrollToAnchor()` are ten lines each on top of the
`buildTextIndex`/`nodeAt` pair that search already needed. Built separately they
would have been two walkers, two coordinate systems and two sets of drift bugs.
This is the ReadEra lesson landing in practice rather than as a note.

**Highlights must be painted last-match-first.** Wrapping a match in `<mark>`
mutates the DOM and invalidates every offset after it, so painting forwards
corrupts the position of every subsequent match — highlights drift further wrong
the further down the page they are, which reads as a rendering bug rather than
an ordering one.

**Clearing highlights must `normalize()`.** Wrapping splits one text node into
three. Without rejoining them, a second search sees a document fragmented by the
first, and character offsets stop being comparable between searches — the same
query would produce different anchors depending on what had been searched
before.

**The anchor cannot be computed per frame.** It measures a `Range` per
binary-search probe, each forcing layout. `reportPosition` is the app's busiest
path — P6-1 already had to rescue it once — so the anchor is debounced 250ms and
`reportPosition` only *schedules* it.

**Store and restore must share the same 15% bias**, or the position creeps by a
fifth of a screen on every reopen. This one is worth recording because the
obvious test does not catch it: re-reading the offset after a restore passes,
since with coarse line spacing both the correct and the drifted position resolve
to the same text node. Asserting the resulting *scroll position* is what catches
it.

**And the file bit back twice more** — raw backticks in comments inside
`viewerHtml.ts`, once per phase, each producing `TS1005` at an unrelated line.
Third and fourth time in this project ([DETAIL.md §6.11](DETAIL.md)).

### How they were verified

`npm run check` passes — **230 tests, up from 188**. Two new files:

- [search.test.ts](src/__tests__/search.test.ts) — 21 tests over the shared hit
  shape, all pure: case folding, whole-word boundaries **in Cyrillic and
  Greek** (`` is ASCII-only and would behave differently per script),
  overlapping matches, empty queries, context clamping at both document ends,
  and rect merging across mixed glyph sizes.
- [viewerSearch.test.ts](src/__tests__/viewerSearch.test.ts) — 20 tests that
  **execute** the real emitted viewer functions against a stubbed DOM, the
  technique `viewerHtml.test.ts` established. The strongest of these lays the
  same document out at a different line height and asserts the anchor still
  names the same text *while the pixel offset that produced it does not* — the
  bug P11 exists to fix, demonstrated rather than asserted.

Every assertion was mutation-checked. Six deliberate breakages were introduced
one at a time; **two initially survived** and both tests were strengthened until
they failed:

| Mutation | Caught by |
|---|---|
| Paint highlights forwards | highlight order test |
| Drop the restore bias | round-trip test — *after* it was rewritten to assert scroll position rather than the offset |
| Inline the anchor per frame | debounce test — *after* it was scoped to `reportPosition`'s own body |
| Advance the cursor after the whole-word skip | infinite-loop guard |
| Drop `normalize()` on clear | index-fragmentation test |
| Disable the anchor branch | restore-priority test — *after* it stopped checking source order alone |

The two that survived are the useful part of the exercise: both tests passed
against correct code *and* against broken code, which is the definition of a
test that proves nothing.

**Still device-unverified**: whether the highlight colours read well against all
four themes, whether 180ms is the right typing debounce on a real keyboard, and
whether the anchor restores correctly on a genuinely long EPUB where content
arrives progressively.

---

## P12 — Robustness and scale — ✅ complete

Resolves [AUDIT §2](AUDIT.md) and [§3.5](AUDIT.md). None of these is urgent at
today library sizes; all of them get harder to retrofit later.

### ☑ P12-1 — `fast-xml-parser` for EPUB

Carried forward from the first audit, still not done.

**Files:** [src/renderers/webview/epub.ts](src/renderers/webview/epub.ts)

The OPF, NCX and nav parsing is around a dozen hand-written regexes
(`/<item\b[^>]*>/g`, then per-attribute extraction). They work on well-formed
books and fail **silently** on namespaced `opf:` prefixes, unusual attribute
order, or CDATA titles — the book opens with no TOC and no page list rather than
erroring, so nobody reports it as a bug.

- [x] Add `fast-xml-parser` (~30 KB, dependency-free, pure JS — so it is also
      legal inside the worklet runtime)
- [x] Replace the OPF, NCX and nav parsing
- [x] Keep the two-tier page rule exactly as it is; this changes *how the
      page-list is found*, never how pages are counted
- [x] Add a test with a namespaced OPF and a CDATA title — both currently parse
      to nothing

### ☑ P12-2 — Hash-based shadow instead of a deep copy

Resolves [AUDIT §2.1](AUDIT.md).

**Files:** [src/storage/libraryDiff.ts](src/storage/libraryDiff.ts)

`snapshot()` deep-copies every group and file so the next diff has something to
compare against — which **doubles** the library memory, and the diff then
compares ten fields per entry.

- [x] Replace the copy with a `Map<id, hash>` over the same fields
      `fileChanged` compares
- [x] Diff becomes one string compare per entry
- [x] Keep the field list explicit and in one place — the current comparator
      docstring is right that a forgotten field is a silent write failure, and
      that risk is unchanged by this

### ☑ P12-3 — Window long group rows

Resolves [AUDIT §2.3](AUDIT.md).

**Files:** [src/components/GroupRow.tsx](src/components/GroupRow.tsx)

P3-4 virtualized the vertical axis, correctly. The rows inside stay plain
`ScrollView`s, so a row with 400 files mounts 400 cards — each an `expo-image`,
a `useMMKVNumber` subscription and two shared values — as soon as that row
scrolls into view. The comment says groups hold *"tens of files, not
thousands"*, which is a product assumption nothing enforces.

- [x] Render `files.slice(0, N)` plus a "+340 more" tile that raises `N`
- [x] Keep the plain `ScrollView` and the existing drag behaviour — this must
      not become a nested virtualized list, for the reasons P3-4 records
- [x] Reset `N` when the group changes

### ☑ P12-4 — S3-FIFO for the cache tail

**Files:** [src/renderers/webview/prepareCache.ts](src/renderers/webview/prepareCache.ts)

The pinned window is right and stays. The tail behind it is pure recency (`Map`
insertion order), so a file opened once and abandoned evicts a file returned to
repeatedly — the opposite of what someone working through a group wants.

- [x] Small FIFO for one-hit wonders, main FIFO for the rest, ghost queue of
      evicted ids
- [x] ~30 lines, no timestamps
- [x] Keep the byte budget and the pin exemption exactly as they are — this
      changes *which* tail entry is evicted, nothing else
- [x] Extend `prepareCache.test.ts`: an entry read twice must outlive an entry
      read once, at equal size

### ☑ P12-5 — FTS5 search over the library

**Files:** [src/storage/db.ts](src/storage/db.ts),
[src/screens/LibraryScreen.tsx](src/screens/LibraryScreen.tsx)

There is no way to find a file by name today beyond scrolling the board. The
index is already SQLite, so this is nearly free.

- [x] `CREATE VIRTUAL TABLE files_fts USING fts5(name, content=files)`
- [x] Keep it in sync from `applyDiff`, inside the existing transaction
- [x] Search field in the board header; results as a flat list, not a board
- [x] Bump `SCHEMA_VERSION` and write the migration

### ☑ P12-6 — A second worklet runtime for user work

Resolves [AUDIT §2.4](AUDIT.md).

**Files:** [src/renderers/webview/offload.ts](src/renderers/webview/offload.ts)

`busy` bounds background parses to one at a time, and a user-initiated open
deliberately bypasses it — both correct. But the **worklet runtime** is a single
shared instance ([offload.ts:55](src/renderers/webview/offload.ts#L55)) that
processes in order, so opening a file while a 30 MB comic prefetches queues the
user own document behind it. The module comment is right that this is safe for
correctness; it is not safe for latency.

- [x] Second runtime, used by user-initiated preparation
- [x] Keep prefetch on the existing one
- [x] Costs one JS context, created lazily like the first

### ☑ P12-7 — `IntersectionObserver` — measured, and not done

**Files:** none — this task closes on evidence rather than a change.

The task itself said: *"Do this **after** P9-4; if that is enough, this may not
be worth the churn."* It was enough.

P9-4 cached `scrollHeight`, which was the layout-forcing read in the per-frame
path. What remains in `reportPosition` is now **pure arithmetic**: an ~11-step
binary search over an array of numbers and a division. Verified by extracting
every function reachable per scroll frame and grepping the code (comments
stripped) for `document.*`, `getBoundingClientRect`, `offsetTop`,
`querySelector*` and `scrollHeight` — **none reachable**.

So the change would replace a handful of integer comparisons with observer
registration on every `.sr-pb` anchor — thousands of them on a long book —
plus the machinery to keep those registrations in step with streamed appends
and re-measures. That is more moving parts and more memory to remove work that
is no longer being done.

- [x] Measured the per-frame path after P9-4 rather than assuming
- [x] Confirmed zero DOM or layout reads remain in it
- [x] Closed as not-doing, with the measurement recorded

**Recorded here rather than in "Not doing"** because the reasoning is
conditional on P9-4 and would be wrong to apply generally: if anything ever
reintroduces a layout read into that path, this becomes worth doing again.

### ☑ P12-8 — Align the two `pendingRemoval` loops

Resolves [AUDIT §2.2](AUDIT.md). Not a live bug — flagged because it is one
refactor from becoming one.

**Files:** [src/store/pendingRemoval.ts](src/store/pendingRemoval.ts)

`resumeInterrupted` reads `filesById` **once**
([pendingRemoval.ts:137](src/store/pendingRemoval.ts#L137)) then calls
`removeFile` in a loop, each of which replaces store state. It works only
because the loop reads entries captured up front. `commitAll`, twelve lines
away, re-reads `get().pending` per iteration precisely because the author knew
this — two loops, opposite conventions, in the subsystem that has already caused
one data-loss incident.

- [x] Re-read state per iteration in `resumeInterrupted`, matching `commitAll`
- [x] Comment why, so the convention is not "cleaned up" back

---

### What P12 taught

**`fast-xml-parser` was not "dependency-free, ~30 KB".** The plan said so; it
actually pulls **six** transitive packages. Checked before committing: none
carries an advisory, and the parser handles namespaced elements and CDATA that
the regexes silently failed on — so it still earns its place, but the plan's
premise was wrong and the supply-chain surface is real.

**The conversion was proven against the old code, not just asserted.** The new
tests were run against the *previous* regex implementation, which returns 0
marks for a namespaced NCX where the parser returns 1. A test that passes before
and after a change proves nothing, and two of the new ones would have.

**One import needs its `.ts` extension.** `pagination.ts` is loaded directly by
`node --test`, where Node's own ESM resolver applies and does not guess
extensions — so the sibling import of `xml.ts` must carry it. Metro resolves
either form, so it is harmless on device and load-bearing off it.

**NCX parsing had to accept fragments.** The existing tests pass a bare
`<pageList>` with no `<ncx>` root. Real files have the root; the tests do not,
and being strict broke them. Accepting either is one lookup and removes a class
of "the book has no chapters" that is really "shaped slightly differently".

**S3-FIFO's first tests were worthless, and mutation testing is what showed it.**
Both mutations — reverting to pure LRU, and disabling the ghost queue — passed.
The reason is instructive: the test read an entry and *then* inserted newer
ones, so LRU's promotion saved it too. The policies only diverge when the
re-read entry is **older** than the one-hit wonder, and the rewritten tests put
it at the front of the queue. Both mutations now fail.

**FTS5 is maintained by triggers, not by call sites.** Updating the index at
every write site is the same shape as the bug class this project has been bitten
by twice: a rule written down rather than enforced. In the database it cannot
drift, including through the `INSERT OR REPLACE` that `applyDiff` uses.

**P12-7 was closed by measuring rather than building.** The task said to do it
only if P9-4 was not enough. It was: the per-frame path now contains zero DOM or
layout reads, verified by grepping every reachable function with comments
stripped. Building it would have added observer registrations on thousands of
anchors to remove work that no longer happens.

### How P12 was verified

`npm run check` passes — **258 tests, up from 236**. New coverage: the hash
shadow (field sensitivity, separator ambiguity, non-aliasing), S3-FIFO
(divergence from LRU, bounded second chances, the ghost queue, pinned exemption,
non-promoting probes), row windowing (prefix invariant, drag bounds, reset), and
XML parsing (namespaces, CDATA, attribute order, nesting depth, single-child
shape, malformed input, numeric-looking titles).

Mutation-checked: pure LRU fails the divergence test, no ghost queue fails the
return test, and the old regex parser fails the namespace test.

**Still device-unverified**: whether FTS5 search feels instant on a real
library, whether the "+N more" tile reads as an affordance rather than a card,
and whether the second worklet runtime measurably removes the head-of-line
stall it was built for.

---

## Ongoing — tooling

### ☐ T-2 — Fail the build on exported functions with no callers

Resolves [AUDIT §5](AUDIT.md).

The third audit findings were **not** catchable by reading code. `forgetFile` is
well-written, well-commented and correct — which is exactly why nothing about it
looks wrong in place. It was found by grepping for callers.

That is mechanically checkable, and `tsc` will not do it: the functions are
exported, so they count as used.

- [ ] Add `knip` (or `ts-prune`) to `npm run check`
- [ ] Allowlist the genuinely-public surface so the signal stays real
- [ ] Confirm it flags all three of the functions this audit found by hand:
      `forgetFile`, `resetPrefetchFailures`, `locationKey`

**The rule, stated once:** an exported function with no callers is either dead
code or a missing call, and both are bugs. `locationKey` is the interesting
case — it is not dead code at all, it is a feature that was designed, named, and
never built (P11-1).

### ☐ T-3 — A test that holds the deletion claims

Extends T-1 into the P8 findings, which have the same property: nothing in the
suite asserts them, and on-device testing surfaces them only by chance.

- [ ] Assert *"deleting a group leaves no bytes on disk"*
- [ ] Assert *"deleting a file clears its MMKV keys"*
- [ ] Assert *"restore invalidates every id-keyed cache"*
- [ ] Assert *"a backup round-trips reading positions"* (pairs with P8-5)

---

## P13 — Restore safety — ☐ not started

Resolves [AUDIT §1.1](AUDIT.md) and [§1.2](AUDIT.md). **This phase is the
highest priority in the backlog**, and it is the only one where doing nothing
risks the thing the feature exists to protect.

The two findings are one piece of work. Restore is the last line of defence for
a user's library, and it currently has both an unbounded memory profile *and* no
rollback — so the likely failure is an OOM kill partway through, after the old
library has already been deleted.

Note the numbering: the fourth audit's own draft ordering called these P12–P16,
which collides with the completed P12 above. They are P13–P17 here, and
[AUDIT.md §6](AUDIT.md) has been corrected to match.

### ☐ P13-1 — Stream the restore unzip

**Files:** [src/storage/backup.ts](src/storage/backup.ts),
[src/renderers/webview/offload.ts](src/renderers/webview/offload.ts)

[backup.ts:196](src/storage/backup.ts#L196) is `unzipSync(await archive.bytes())`
— the whole archive decompressed into memory at once, on the JS thread. Peak is
`archive + fully decompressed library`, roughly **twice the library size** for a
stored-not-deflated archive of PDFs.

P3-5 already fixed the mirror image of this on the export side, and its comment
([backup.ts:18-31](src/storage/backup.ts#L18-L31)) explains why the 400 MB cap
could then be removed. Nothing re-imposed a ceiling on import, so **a library
that exports successfully cannot necessarily be restored on the device that made
it** — and the recovery path is the worst possible place to discover that.

This is also the only `unzipSync` left on the JS thread; `prepare.ts` and
`epub.ts` both route through `unzipOffThread` (P2-1).

- [ ] Replace `unzipSync` with fflate's streaming `Unzip`, entry by entry
- [ ] Run it on the `prefetch` lane, not `user` — a restore is long and the UI
      must stay alive; this is exactly the separation P12-6 built
- [ ] Write each entry out and release it before the next is read, so peak is
      one file rather than the library
- [ ] Keep the path-traversal guard exactly as it is — `name.includes('/')`,
      `'\\'`, `'..'` — and apply it per entry as they stream
- [ ] Read `library.json` first and validate its shape before any file is
      written, preserving the existing "prove the archive is readable" ordering

**Verify:** export a library larger than device RAM, then restore it. The
current code cannot complete this; the streamed version must. Watch peak memory
in Android Studio's profiler — it should stay flat rather than tracking archive
size.

### ☐ P13-2 — Unpack-then-swap, so a kill cannot strand the library

**Files:** [src/storage/backup.ts](src/storage/backup.ts)

[backup.ts:212-214](src/storage/backup.ts#L212-L214) deletes the library
directory, then writes the archive's files into a fresh one, then calls
`replaceLibrary` last. The comment says *"Clear the existing library only once
the archive has proven readable"* — which is true and is not enough: a parsed
index proves the JSON is well-formed, not that the writes that follow will
complete.

A kill between the delete and `replaceLibrary` leaves the old directory gone,
the new one partially populated, and the SQLite index still describing the
library that no longer exists. `pruneOrphans` cannot repair that and is not
meant to: it removes bytes with no row, not rows with no bytes.

Every other destructive path in this app has an interlock — `saveLibraryNow`
leaves its shadow untouched so a failed write retries (P8), and
`schedulePruneOrphans` refuses to run on an empty library
([files.ts:219](src/storage/files.ts#L219)). Restore is the one that has none.

- [ ] Unpack into a sibling directory (`library.incoming/`), not over the live one
- [ ] Swap only once every entry has landed **and** `library.json` has been
      validated
- [ ] Write the rows in the same commit as the swap where possible, so the index
      and the bytes cannot disagree
- [ ] Delete a stale `library.incoming/` on startup — an interrupted restore
      must not leak a second copy of the library forever
- [ ] Keep positions being written to MMKV **before** `replaceLibrary`, per P8-5
      — the board must not paint 0% and then jump

**Verify by force-quitting from recents mid-restore**, not by a reload — per
[DETAIL.md §6.3](DETAIL.md), this is the only way this class of bug shows up.
The library must be either fully the old one or fully the new one, never a mix.

### ☐ P13-3 — One streaming-zip helper for both directions

**Files:** [src/storage/backup.ts](src/storage/backup.ts)

The reason P13-1 exists at all is that export learned to stream and import did
not. Fixing import without removing that asymmetry leaves the next change to
either half free to drift again.

- [ ] Extract the streaming read and write behind one small module, so "how this
      app handles a zip" has a single answer
- [ ] Keep `ZipPassThrough` (store, not deflate) and the reasoning for it — the
      payload is PDFs, images and already-compressed EPUBs
- [ ] This is the same move `bytes.ts` made for `toBase64`
      ([DETAIL.md §6.12](DETAIL.md)), applied to the decision rather than the
      duplicated function

---

## P14 — Make failures visible — ☐ not started

Resolves [AUDIT §3.8](AUDIT.md) and [§3.9](AUDIT.md).

The defining incident of this project ([DETAIL.md §6.3](DETAIL.md)) was **a
silent write failure**. The fixes that followed were all correct — `applyDiff`
throws, `saveLibraryNow` logs an error, the shadow is preserved so the write
retries — and every one of them reports into a console **nobody is reading**.
On a user's device the next silent failure is exactly as invisible as the last.

### ☐ P14-1 — Crash and error reporting

**Files:** app root, [src/storage/library.ts](src/storage/library.ts),
[src/storage/db.ts](src/storage/db.ts),
[src/renderers/webview/prepare.ts](src/renderers/webview/prepare.ts)

- [ ] Add a reporter (Sentry or equivalent) initialised at the app root
- [ ] Report the paths that are already correctly loud but locally invisible:
      a failed `applyDiff`, a database that will not open, a prepare that throws
- [ ] Include format and file size on a prepare failure, never the file name or
      its contents — the WebView posture ([DETAIL.md §4](DETAIL.md)) is that
      file content never reaches the network, and telemetry must not be the
      exception that quietly breaks it
- [ ] Confirm the reporter is a no-op in debug builds, so development noise does
      not train anyone to ignore it

**This is the single highest-leverage change in the fourth audit.** Everything
else on this list is a bug someone can find; this is the thing that makes the
*next* bug findable.

### ☐ P14-2 — A root error boundary

**Files:** [App.tsx](App.tsx)

A render throw anywhere is currently a white screen with no way forward. Given
how many code paths parse untrusted files, this is reachable.

- [ ] Error boundary around `Root`, above the screen swap
- [ ] Offer the two recoveries the app can actually perform: clear the prepared
      caches (`resetAllCaches`) and return to the board
- [ ] Never offer anything that touches the library index — a crash is not
      evidence the user's files are wrong, and P8's whole lesson is that cleanup
      routines amplify upstream bugs
- [ ] Report the boundary catch through P14-1

---

## P15 — Hot paths — ☐ not started

Resolves [AUDIT §2.1](AUDIT.md) through [§2.3](AUDIT.md), plus
[§3.2](AUDIT.md) and [§3.3](AUDIT.md).

### ☐ P15-1 — Window the pager

**Files:** [src/components/HorizontalPager.tsx](src/components/HorizontalPager.tsx)

P12-3 windowed `GroupRow` for exactly this reason and named the assumption:
*"groups hold tens of files, not thousands"* is a product assumption nothing
enforces. The pager makes the same assumption and was not given the same fix.

Only the active file's *renderer* mounts — that part is right and its reasoning
(three pdfium documents crashing inside `FPDF_LoadPage`) must be preserved. But
the track is `width * count` and there is a `<View>` per file regardless, so a
400-file group builds 400 native views and a track 400 screens wide.

- [ ] Render `index - 1 … index + 1` with a translate offset, so the view count
      is constant
- [ ] Keep the group-isolation arithmetic byte for byte —
      `Math.max(0, Math.min(count - 1, next))` is the only thing preventing a
      page out of a group, and it is a product requirement, not an optimization
- [ ] Keep the rubber-band at 0.28 and the `activeOffsetX`/`failOffsetY`
      asymmetry untouched; this changes what is mounted, never what is felt
- [ ] Ideally share the windowing primitive with `GroupRow` (per P13-3's
      reasoning) rather than writing a second one

**Verify:** a group of 300 files pages as smoothly as a group of 3, and the
swipe animation is unchanged. Check the Android view count in Layout Inspector
before and after.

### ☐ P15-2 — Incremental `pdfsNeedingCovers`

**Files:** [src/store/selectors.ts](src/store/selectors.ts),
[src/store/library.ts](src/store/library.ts)

[selectors.ts:100-112](src/store/selectors.ts#L100-L112) walks all of
`filesById` inside a `useShallow` selector. Zustand runs every subscriber's
selector on **every** store update, so each `setThumb`, each rename keystroke,
each import scans the whole library and allocates an array to compare.

This is the O(n)-per-mutation shape P3-1 normalized the store to eliminate,
reintroduced one file over. The docstring's defence of returning *ids rather
than entries* is correct and must stay — a selector returning entries would see
every `setThumb` and re-drive the effect that produced it. It is the scan that
went unexamined.

- [ ] Maintain the set in the reducers: a PDF enters in `addFiles`, leaves in
      `setThumb` and `removeFile`
- [ ] Keep returning ids, for the reason already documented
- [ ] Fix `useFileCount` in the same pass —
      `Object.keys(s.filesById).length` allocates a full key array to read a
      number (it returns a primitive, so it cannot loop, but it is on the same
      path)
- [ ] Extend `normalizedStore.test.ts`: the set shrinks as covers land, and a
      metadata write that is not a cover change does not touch it

### ☐ P15-3 — Key `prefetchAround` on ids, not the array

**Files:** [src/screens/ReaderScreen.tsx](src/screens/ReaderScreen.tsx)

[ReaderScreen.tsx:113-115](src/screens/ReaderScreen.tsx#L113-L115) depends on
`files`, which is a `useMemo` over `filesById` — so **any** file's metadata
changing (a thumbnail landing, a progress write) produces a new array identity
and reschedules prefetching. `InteractionManager` and the `busy` flag absorb
most of the damage, but the work is being rescheduled for reasons unrelated to
which file is being read.

- [ ] Depend on `[files[index - 1]?.id, files[index]?.id, files[index + 1]?.id]`
- [ ] Leave `cancelPrefetch` on unmount exactly as it is (P0-2)

### ☐ P15-4 — Debounce library search and paginate its results

**Files:** [src/screens/LibraryScreen.tsx](src/screens/LibraryScreen.tsx),
[src/storage/db.ts](src/storage/db.ts)

P12-5 landed FTS5 and it is fast, but
[LibraryScreen.tsx:133-136](src/screens/LibraryScreen.tsx#L133-L136) runs it
synchronously on every keystroke — a JSI call plus a `setState` per character.
And `searchFiles` defaults to `LIMIT 50` ([db.ts:338](src/storage/db.ts#L338))
with no affordance, so on a large library the 51st match is unreachable and the
user is never told it exists.

- [ ] Debounce to ~120 ms, and cancel in flight on a new keystroke
- [ ] Either raise the limit with a "showing 50 of N" line, or paginate
- [ ] Keep the term-quoting exactly as it is — it is what stops a filename with
      a hyphen becoming an FTS5 syntax error

---

## P16 — Scale and housekeeping — ☐ not started

Resolves [AUDIT §2.4](AUDIT.md), [§2.5](AUDIT.md), [§1.3](AUDIT.md),
[§3.1](AUDIT.md) and [§3.5](AUDIT.md). None is urgent at today's library sizes;
all get harder to retrofit later.

### ☐ P16-1 — Chunk `pruneOrphans` across frames

**Files:** [src/storage/files.ts](src/storage/files.ts)

P3-3 deferred it behind `runAfterInteractions` and throttled it to once a day,
and both are right. Neither addresses that the walk itself
([files.ts:242-263](src/storage/files.ts#L242-L263)) is synchronous — at 10,000
entries it is a multi-second JS-thread freeze, and because it is *deferred* it
lands after the user has started interacting, which is the worst moment for it.

- [ ] Chunk the enumeration with an explicit frame budget (~8 ms slices), the
      way the image and chapter pumps in `WebViewRenderer` already yield
- [ ] Keep the empty-library interlock **exactly** as it is — it is the guard
      against the [DETAIL.md §6.3](DETAIL.md) incident recurring by a new route
- [ ] Keep recording the timestamp only on a completed pass, so a partial run
      retries rather than being skipped for a day

### ☐ P16-2 — Cap and prioritise the cover factory

**Files:** [src/components/PdfCoverFactory.tsx](src/components/PdfCoverFactory.tsx),
[src/screens/LibraryScreen.tsx](src/screens/LibraryScreen.tsx)

One-at-a-time is correct and must stay — every attempt to hold several pdfium
documents open has ended badly. What is missing is a bound on the *queue*:
importing 3,000 PDFs means 3,000 sequential rasterise-and-capture cycles, each
with a settle delay, for covers the user may never scroll to.

- [ ] A per-session cap, so a large import does not spend hours of battery
- [ ] Order by what is on screen rather than by store order — the cover the user
      is looking at is worth a hundred they are not
- [ ] Keep the single-document invariant and the off-screen positioning
      (`display: none` and zero size both defeat `captureRef`)

### ☐ P16-3 — Make the empty-group case impossible to write wrong

**Files:** [src/store/selectors.ts](src/store/selectors.ts)

[selectors.ts:43](src/store/selectors.ts#L43) and
[:67](src/store/selectors.ts#L67) are currently correct — the `??` sits outside
the selector and `EMPTY_IDS` is module-level. Two things make it worth closing
anyway:

- the file's own docstring attributes the safety to the selector *shape* rather
  than to the shared constant, so a reader following the stated reasoning who
  writes `?? []` inside lands in [DETAIL.md §6.10](DETAIL.md) — the trap this
  project has hit **twice**;
- the fallback is nearly dead. The store guarantees an entry for every group
  ([library.ts:125](src/store/library.ts#L125)), so it fires only for a
  `groupId` that is not a group.

- [ ] A `selectGroupIds(groupId)` helper that owns the fallback, so no call site
      writes the `??` itself — the move `EMPTY_TOC` made in `ReaderScreen`,
      one level up
- [ ] Correct the docstring to name the real mechanism: the shared constant

### ☐ P16-4 — Delete `fileChanged` and `groupChanged`

**Files:** [src/storage/libraryDiff.ts](src/storage/libraryDiff.ts),
[src/\_\_tests\_\_/lifecycle.test.ts](src/__tests__/lifecycle.test.ts)

P12-2 replaced them with the hash shadow and left them in place. They now have
no callers — but `hashFile`'s docstring still says *"exactly the fields
`fileChanged` compares, in the same order"*, and `lifecycle.test.ts:184`
references it as though it were live.

This is precisely what [DETAIL.md §6.12](DETAIL.md) warns about in its own
words: *"a comment describing an abandoned approach is worse than no comment: it
is an active invitation to reintroduce the bug."*

- [ ] Delete both functions
- [ ] Move the field-list rationale onto `hashFile`, where it is still true and
      still load-bearing — a field missing from the hash is a field whose
      changes never persist
- [ ] Update the test comment to name `hashFile`
- [ ] T-2 (`knip`) would have caught this; it is still unimplemented

### ☐ P16-5 — Bound `sizeCache`

**Files:** [src/storage/files.ts](src/storage/files.ts)

[files.ts:111](src/storage/files.ts#L111) is a `Map` with no eviction.
`forgetSize` and `clearSizeCache` are correctly wired into `lifecycle.ts` (P8-1),
so it is invalidated properly — nothing bounds ordinary growth.

- [ ] A modest LRU bound, or drop it entirely for entries carrying `size`
- [ ] Note the cache exists only for entries imported before `FileEntry.size`
      did, so it should shrink to nothing over time

### ☐ P16-6 — Document `MAX_GHOSTS`

**Files:** [src/renderers/webview/prepareCache.ts](src/renderers/webview/prepareCache.ts)

[prepareCache.ts:85](src/renderers/webview/prepareCache.ts#L85) is a bare `32`.
[CLAUDE.md](CLAUDE.md) warns that *"a bare tuning constant with no rationale
will be 'cleaned up' by the next reader"*, and every other constant in this file
carries its reasoning.

- [ ] State why 32 — or measure and state the real number

---

## P17 — Ship readiness — ☐ not started

Resolves [AUDIT §3.7](AUDIT.md), [§3.10](AUDIT.md) and [§6](AUDIT.md).

Everything here is invisible in the artefact: a wrong build installs and runs
perfectly on the machine that made it. That is the same property
[DETAIL.md §7.3](DETAIL.md) already identifies for the release configuration.

### ☐ P17-1 — `versionCode` automation

**Files:** [app.json](app.json),
[scripts/tune-gradle.mjs](scripts/tune-gradle.mjs) or a sibling script

Keeping it in `app.json` is correct and documented — the generated `android/`
copy is reset to 1 by every prebuild. But nothing increments it, so it is still
`1` ([app.json:12](app.json#L12)) and the first update ships unpublishable.

- [ ] Bump it in the release script, or fail `npm run apk` when it has not moved
      since the last tagged build
- [ ] Fold it into the existing `release-check.mjs` gate, which already refuses
      to build when the release configuration is wrong

### ☐ P17-2 — Commit hygiene

One commit (`Initial commit`) with ~40 files uncommitted, including
`credentials/`. `.gitignore` covers it and the signing posture is right, but the
working tree is one `git add -A` from a leak that **cannot be rotated** — only
replaced by a new key that orphans every installed copy.

- [ ] Split the working tree into reviewable commits
- [ ] Confirm `credentials/` has never entered history, not merely that it is
      ignored now
- [ ] Stop tracking `modules/pdf-text/android/build/` — compiled `.class`,
      `.dex` and `.aar` artifacts in the source tree

### ☐ P17-3 — Automate the force-quit persistence check

Extends T-1 and T-3 with the one verification this project keeps performing by
hand. [DETAIL.md §6.3](DETAIL.md) states that a persistence change is only
verified by force-quitting from recents — and that is still a manual step,
which means it is a step that will eventually be skipped.

- [ ] A device test (Maestro or Detox) that force-quits and relaunches
- [ ] Assert the library survives an import killed inside the debounce window
- [ ] Assert a removal inside the undo window resolves correctly either way
- [ ] **Assert an interrupted restore leaves the library intact** — this is the
      property P13-2 fixes, and nothing in the suite holds it today

### ☐ P17-4 — Performance regression CI

Every scaling finding in the fourth audit was found by reading, not by
measuring. There is no gate that would catch the next one.

- [ ] Measure startup, frame drops and peak memory at 1k / 5k / 10k files
- [ ] Fail on regression, so the next O(n)-per-mutation selector is caught by a
      number rather than by an audit

### ☐ P17-5 — Accessibility pass

`accessibilityLabel` is present in places — the group menu, the tool buttons —
but there is no systematic coverage, and the reader is the part of the app most
likely to be used by someone who needs it.

- [ ] TalkBack pass over the board and the reader
- [ ] Dynamic type, beyond the reader's own font-size control
- [ ] Contrast check across all four reader themes
- [ ] Confirm `ReducedMotionConfig` genuinely covers the pager and the droplet
      marker (it should — no config hard-codes `reduceMotion`)

---

## What the fourth audit found, in one line

The three previous audits found **structural**, **frequency** and **lifetime**
faults. The fourth found **unpropagated fixes**: a good decision applied to one
path and not to its twin.

Export streams; restore does not (P13-1). `GroupRow` windows; the pager does not
(P15-1). `prepare` offloads its unzip; restore does not (P13-1). The store was
normalized to kill O(groups × files); `usePdfsNeedingCovers` reintroduced it
(P15-2).

This class is invisible to both techniques that found the previous three. Every
individual path is correct and well-commented — there is no contradictory
comment to notice, no missing caller to grep for, no failing test. The fault
only appears when two files are held side by side and one asks *why does this
one know something the other does not?*

The durable version, in the spirit of [DETAIL.md §6.10](DETAIL.md) and §6.12:

> **When a fix encodes a decision rather than a line of code, matching the
> sibling path is not enough — the sibling has to share the implementation.**
> `bytes.ts` was created for exactly this reason and it worked. These four pairs
> are the same problem at the level of design decisions, where there is no
> obvious function to extract and therefore nothing forces the merge.

Partly mechanical: a review checklist asking *"is there another path in this app
that does the same job, and does it now differ?"* would have caught
export/restore and `GroupRow`/pager. T-2 (`knip`) would have caught P16-4. Both
are still unimplemented.

---

## P18 — Motion and UI polish — ✅ complete

Derived from a motion and UI review rather than from [AUDIT.md](AUDIT.md); it is
the first phase here that is not a correctness or scale finding.

**Start from what is already true.** Every component except `PdfCoverFactory`
(invisible by design) already animates, and [ui/motion.ts](src/ui/motion.ts) is a
real design system — springs in SwiftUI's `duration`/`dampingRatio` units,
asymmetric enter/exit curves, and a deliberate refusal to export an `inOut` token
so the symmetric-easing mistake cannot come back. P6 and P7 did the per-frame and
droplet work. This phase is **not** "add animation to a static app"; it is the
short list of places where motion is missing, contradictory, or where the real
problem is UI *structure* rather than motion at all.

### Three constraints on everything in this phase

1. **No numerals at call sites.** [motion.ts](src/ui/motion.ts) states its goal
   as call sites reading `withTiming(1, Timing.enter)` with no numbers in them.
   Every value below resolves to an existing token, or adds one *with its
   rationale* — a bare constant will be "cleaned up" by the next reader
   ([CLAUDE.md](CLAUDE.md)).
2. **Delays need an explicit reduced-motion guard.** `<ReducedMotionConfig>` at
   the root disables *animations* automatically, but a stagger delay is not an
   animation — it will still run and merely make things appear late.
   [motion.ts:150](src/ui/motion.ts#L150) already documents this exact trap;
   P18-4 is the one task that hits it.
3. **Do not touch the pager's gesture arbitration.** `activeOffsetX([-24, 24])`,
   `failOffsetY([-8, 8])`, `.maxPointers(1)`, `.enabled(!isZoomed && !seeking)`
   and the `Gesture.Simultaneous` composition are scar tissue from
   [DETAIL.md §6.4 and §6.5](DETAIL.md). P18-3 is safe because it animates a
   shared value that already exists. **Adding a new gesture anywhere in the
   reader is out of scope for this phase.**

### ☑ P18-1 — A transition for opening and closing a file

**Files:** [App.tsx](App.tsx),
[src/screens/LibraryScreen.tsx](src/screens/LibraryScreen.tsx),
[src/screens/ReaderScreen.tsx](src/screens/ReaderScreen.tsx),
[src/components/LoadingCover.tsx](src/components/LoadingCover.tsx)

**This is the highest-impact item in the phase.**

[App.tsx:96](App.tsx#L96) is a hard conditional swap — the board is *replaced in
one frame* by a full-screen reader. This is the most-repeated transition in the
app and the one place with no motion at all, which is conspicuous precisely
because everything either side of it is polished: the card presses with a spring
(P6), and `LoadingCover` paints a ThumbHash and fades out (P9-1). Between them is
a cut.

The pieces needed already exist, which is what makes this tractable: the card can
report its on-screen rect, and `LoadingCover` already renders **the same
ThumbHash bitmap** the card is showing — so a shared-element expansion has no
cross-fade artifact to hide.

- [x] Measure the tapped card's rect in `LibraryScreen` and pass it up through
      `onOpenFile`
- [x] Spring the reader's cover from that rect to fullscreen, and reverse it on
      close
- [x] Use `Spring.smooth` — this is large travel, and an overshoot at screen
      scale reads as a bug rather than as life
- [x] Keep the conditional swap and the `key={reading.id}` remount exactly as
      they are; the key is what stops the reader opening into the previous
      file's group, and no nav library is being introduced
- [x] Close must animate back to the card's rect **only if that card is still on
      screen** — the row may have scrolled, or the file may have been removed;
      fall back to a scale-and-fade

**Cheaper interim, if the shared element proves fiddly:** scale the reader in
from `0.94` with a fade while the board scales to `1.03` and fades under it.
Roughly 20 lines and it gets most of the perceived depth.

**Verify:** open and close the same file ten times in a row. The transition must
stay interruptible — tapping close mid-open should retarget, not queue, which is
the property `Spring` was chosen for in the first place.

### ☑ P18-2 — An empty state that teaches the board

**Files:** [src/screens/LibraryScreen.tsx](src/screens/LibraryScreen.tsx)

The only empty affordance today is the header subtitle *"Add files to get
started"* ([LibraryScreen.tsx:440](src/screens/LibraryScreen.tsx#L440)) and the
word `empty` in a row header ([GroupRow.tsx:133](src/components/GroupRow.tsx#L133)).

So a first-run user sees a title, a dashed "+ New group" box, and **nothing that
explains the 2-D board** — the single idea the entire product rests on
([DETAIL.md §1](DETAIL.md): *"That second sentence is the whole product"*). The
app's one differentiator against every other reader is invisible at the exact
moment it should be taught.

- [x] An empty state that *shows* the concept rather than describing it: a
      mocked row of cards with a horizontal swipe hint, and a second row beneath
      to imply the vertical stack
- [x] Say what a group is in one line — a logical tag, not a folder — since that
      is also the thing that makes reorganizing free
- [x] Show it when the library has no files, not merely no groups: `load()`
      always invents a starter group ([library.ts:150-152](src/store/library.ts#L152)),
      so "no groups" is a state the user never actually sees
- [x] Route its primary action into the existing `handleAddFiles`, so there is
      one import path rather than two

**This is the cheapest change in the phase with the largest effect on first
impression**, and it is UI structure rather than motion.

### ☑ P18-3 — Chrome auto-hide, and a page-turn settle

**Files:** [src/screens/ReaderScreen.tsx](src/screens/ReaderScreen.tsx),
[src/components/HorizontalPager.tsx](src/components/HorizontalPager.tsx)

Two small reader items.

**Auto-hide.** [DETAIL.md §3](DETAIL.md) describes chrome that *"auto-hides on
tap so the document owns the screen"*, and `toggleChrome`
([ReaderScreen.tsx:140](src/screens/ReaderScreen.tsx#L140)) only ever toggles.
Nothing hides it on its own, so the reader *has* an immersive mode rather than
*being* immersive — which is the difference between this and Drive or Books.

**Page-turn settle.** The pager commits with `Haptics.selectionAsync()`, so the
turn is confirmed in the hand but not in the eye. A small scale-settle on the
arriving page reads as landing rather than stopping.

- [x] Hide chrome after ~2.5s idle once a file is open; cancel on any tap,
      scroll, seek or sheet
- [x] Never auto-hide while a sheet or the search bar is open — `immersive`
      already excludes sheets ([ReaderScreen.tsx:95](src/screens/ReaderScreen.tsx#L95))
      and the timer must respect the same rule
- [x] Do not auto-hide on the very first open until the document has reported
      `rendered`; hiding chrome over a loading cover hides the only way back
- [x] Settle the incoming page from `0.98 → 1` on the existing `Spring.pager`
- [x] Drive the settle from the pager's existing `translateX` reaction — no new
      shared value, and above all **no new gesture** (see constraint 3)

**Verify:** the timer must not fire while the user is reading. Scrolling is not
a tap, so confirm a long scroll with no taps does not leave chrome up forever
*or* hide it mid-gesture.

### ☑ P18-4 — Stagger imported cards, and settle search results

**Files:** [src/components/GroupRow.tsx](src/components/GroupRow.tsx),
[src/components/LibrarySearch.tsx](src/components/LibrarySearch.tsx)

`GroupRow` fades in as a row, and `LayoutAnimationConfig skipEntering` correctly
suppresses the cold-start cascade — *"the animation should mark things that just
arrived, not replay the whole library"*
([LibraryScreen.tsx:401-410](src/screens/LibraryScreen.tsx#L401-L410)). That
reasoning is right and must survive this task.

But when files are actually imported they all appear at once, which is the one
case the entrance animation exists for. Search results replace wholesale for the
same reason.

- [x] Stagger newly-added cards by ~30ms each, capped at ~8 so a 200-file import
      does not take six seconds to finish appearing
- [x] **Guard the delay with `useReducedMotion()`** — a delay is not an
      animation and nothing disables it for you (constraint 2, and
      [motion.ts:150](src/ui/motion.ts#L150))
- [x] Keep `skipEntering` doing its job: the stagger must apply to an import,
      never to a cold start or to rows remounting as they scroll
- [x] Give the search results container `layoutTransition()` and results
      `FadeIn`, so refining a query reads as continuous rather than as a new list
- [x] Pairs with P15-4 (search debounce) — do that first or the stagger will
      re-trigger per keystroke

### ☑ P18-5 — Carry the brand colour into the app

**Files:** [src/ui/theme.ts](src/ui/theme.ts)

Two separate issues in the palette
([theme.ts:29-56](src/ui/theme.ts#L29-L56)).

**The launch promises a brand the UI does not deliver.** The splash is
`#0e1a3b`, a deep navy sampled from the logo's own tile — and
[DETAIL.md §7.3](DETAIL.md) records real work getting three colour layers to
agree so launch does not flash. Then the app opens on a neutral grey scale
(`bg: '#0b0b0d'`) that carries none of it. The palette is competent and its
contrast looks sound; it simply has no identity, so the app reads as defaulted
rather than authored.

**`dark.gutter` is invisible.** It is `#000000` against `bg: '#0b0b0d'`. The
field's own docstring says it is *"the grey behind document pages, so each page
reads as a separate sheet"* — in dark mode that intent is lost entirely.

- [x] Thread the navy through the dark theme's `bg`/`surface` so the splash
      resolves into the app rather than being replaced by it
- [x] Give `dark.gutter` real separation from `bg`
- [x] Re-check contrast on all four **reader** themes after any change — those
      are separate from the app chrome
      ([WebViewRenderer.tsx:63-85](src/renderers/WebViewRenderer.tsx#L63-L85))
      and must not drift
- [x] Keep `#0e1a3b` in [app.json](app.json) and the three splash layers in
      agreement — that is a solved problem and changing one colour of it
      reopens §7.3

### ☑ P18-6 — Previews for the formats that still show a badge

**Files:** [src/storage/thumbs.ts](src/storage/thumbs.ts),
[src/renderers/webview/prepare.ts](src/renderers/webview/prepare.ts)

The largest item here, and the one that most changes how the board reads.

Only images, PDFs (P5-1/P9-3), EPUB and CBZ (P1-1) get a real cover. DOCX, XLSX,
CSV, Markdown, TXT, HTML and ZIP all fall back to a coloured badge, so a library
of documents is a wall of format labels. `canThumbnail()` in
[thumbs.ts](src/storage/thumbs.ts) is already the single place that decides this,
which is what makes this additive.

- [x] Render the first lines of extracted text small into a card-sized preview
      for text-ish formats
- [x] A spreadsheet's first cells for XLSX/CSV — a grid is recognisable at card
      size in a way a badge is not
- [x] Reuse the extracted text `prepareFile` already produces rather than
      re-parsing; the page count is derived from it today
- [x] Generate a ThumbHash alongside, so these cards get the same
      first-frame placeholder every other card has
- [x] Respect the existing concurrency cap in `thumbs.ts` — this must not become
      a second unbounded queue (see P16-2)
- [x] Keep `canThumbnail()` as the one place that decides, so the badge fallback
      stays a deliberate answer rather than an accident

### ☑ P18-7 — Make the move sheet spatial

**Files:** [src/screens/LibraryScreen.tsx](src/screens/LibraryScreen.tsx),
[src/components/ActionSheet.tsx](src/components/ActionSheet.tsx)

`moveActions` ([LibraryScreen.tsx:259-268](src/screens/LibraryScreen.tsx#L259-L268))
renders destination groups as plain text rows. This is the **only** path that
changes a file's group — dragging is confined to its own row, deliberately, as a
product requirement — so it is a deliberate, low-frequency, high-consequence
action presented as a flat menu.

The board is spatial; this flattens it to a list at the one moment the user is
reasoning about where something goes.

- [x] Show each destination with its file count and two or three miniature card
      thumbnails, so the sheet looks like the board it is describing
- [x] Keep the current group listed but disabled — it reads more clearly than
      hiding it, and that is already the behaviour
- [x] Reuse `useGroupCounts()`; it is O(1) per group and already mounted here
- [x] Do not add drag-to-move. Cross-group moves being deliberate is a product
      requirement ([DETAIL.md §5.1](DETAIL.md)), not an interaction gap

---

### What this phase deliberately does not do

- **No new gestures in the reader.** Constraint 3. The arbitration is settled
  and every past attempt to add to it cost real debugging time.
- **No animation library.** Reanimated 4 plus the tokens already cover all of
  this; a second one would be weight with nothing to buy.
- **No bottom-sheet library.** `SheetShell` documents why `@gorhom/bottom-sheet`
  was evaluated and rejected — it has no back-button handling, and this app
  shows four sheets from a screen that registers no `BackHandler`.
- **Nothing on the per-frame path.** P6 and P7 established that the scroll and
  droplet paths contain no DOM or layout reads (P12-7 closed by measuring). No
  task here may put work back onto them.

### A correction from the review that produced this phase

The review that generated these tasks listed an eighth item: *"the ThumbHash to
thumbnail swap is a hard cut — add `expo-image`'s cross-dissolve."* **That was
wrong.** [FileCard.tsx:139](src/components/FileCard.tsx#L139) already sets
`transition={120}` alongside `placeholder={{ thumbhash }}`, and
[ImageRenderer.tsx:135](src/renderers/ImageRenderer.tsx#L135) does the same — so
the cross-dissolve has been in place since P1-2. The task was dropped rather than
written.

Worth recording for the same reason [DETAIL.md](DETAIL.md) records its own
near-misses: the claim was made from the *absence* of a `transition=` grep hit in
the components list, and the grep had already matched it. A finding that is one
`grep` from being disproved should be checked with that grep before it is
written down.

### What P18 taught

**One of the seven tasks was already done, and the review that wrote it was
wrong twice.** P18-4's card stagger existed in `DraggableCard` — correctly
capped at six and correctly reduced-motion guarded — so only the search half was
built. That is the *second* claim in this phase's source review to survive into
a written task despite being one `grep` from disproof; the first
(`transition={120}`) was caught before the tasks were written and is recorded at
the end of the phase above. The lesson is not "check twice", it is that a review
which enumerates what is *missing* has to be run against the code rather than
against a list of what was noticed.

**The reader transition needed a geometry module before it needed an
animation.** The animation is fifteen lines; the part that is easy to get subtly
wrong is the arithmetic — a shared-element transition computed from corners
rather than centres is off by half the size difference, which still *looks* like
an animation and is invisible in a screenshot. Splitting `openTransition.ts` out
as pure functions made eleven tests possible, and they are the reason the
translate is known to be right rather than believed to be.

**That split forced a constraint worth stating: a tested module cannot import
from `react-native`.** The first version of `openTransition.ts` used
`useWindowDimensions`, and the whole file became unloadable under
`node --test` — RN's entry point is Flow-typed (`import typeof * as …`), so Node
fails to parse it before a single test runs. Screen dimensions are passed in as
numbers now. `pagination.ts` has always worked under this rule; it just was not
written down.

**Two of the six policy tests were worthless, and mutation testing is the only
reason that is known.** Both passed against deliberately broken code:

- the auto-hide test sliced a window of characters around `CHROME_IDLE_MS` and
  asserted each guard appeared *somewhere* in it — so deleting the `seeking`
  guard left it green, because the word occurs elsewhere in the component;
- the reduced-motion test asserted the file contained `useReducedMotion`, which
  is still true after renaming the hook, because the string survives in the
  file's own comments.

Both now match the actual expression — the early-return line, and the delay
call — and both fail when the guard is removed. This is the same finding P12
recorded about S3-FIFO, in a different subsystem: **a test written from the
shape of the code rather than from the behaviour will pass for the wrong
reason.**

**`StyleSheet.absoluteFillObject` is not in this RN version's types.**
`absoluteFill` is. Caught by `tsc`, which is the gate working as intended.

**The move sheet's file had to outlive the sheet's own state.** `MoveSheet`
closes before it reports the chosen destination — deliberately, so the move does
not re-render the board mid-slide — which means by the time `onMove` fires,
`sheet.kind` is already `'none'`. Reading the file back out of it would have
made every move silently do nothing. A ref written while the sheet is open
survives the gap. This is the `requestAnimationFrame` deferral in `ActionSheet`
having a consequence one level up that nothing in `ActionSheet` documents.

**A preview cache is an id-keyed cache.** `useSnippet` was registered in
`lifecycle.ts` in the same change that introduced it, and `lifecycle.test.ts`
was extended to enforce it — which is exactly what that module's docstring asks
for and what the third audit found had never happened for five caches in a row.

### How P18 was verified

`npm run check` passes — **291 tests, up from 258**. New coverage: the open
transition's geometry (centre-based translation, width-only scale, stale-rect
rejection in five forms), snippet extraction (markdown markers, links, images,
fenced code, HTML entities, script/style exclusion, CSV separators, word-boundary
trimming, the too-short case), and six motion-policy assertions.

Mutation-checked, all four now failing when they should: removing the
group-isolation clamp, animating a layout property in the transition, deleting
the `seeking` guard, and unguarding the stagger delay.

**Still device-unverified**, and this is the larger half for a phase that is
entirely about how things feel:

- whether the reader transition reads as one object moving or as a screenshot
  being scaled — the opacity ramp is tuned by reasoning, not by watching it;
- whether 2.5s is the right idle timeout, or whether it fires while the user is
  still orienting on a newly opened file;
- whether the page-settle at 0.98 is perceptible at all, or so subtle it is
  merely two frames of extra work;
- whether the navy tint reads as continuous with the splash or merely as a
  slightly-off grey;
- whether snippet previews make the board scannable or make it noisy — this is
  the one most likely to need reverting;
- whether the empty state teaches the 2-D board, which is the only question in
  this phase that a user test answers and a developer cannot.
