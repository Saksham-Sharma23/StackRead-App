# StackRead — task list, R-series

Actionable work derived from [AUDIT2.md](AUDIT2.md), the sixth audit. Each task
carries the files it touches, the change itself, and **how to know it worked** —
several of these are only observable with a number, which is why R0 exists and
comes first.

Phases are ordered so safety lands before speed, instrumentation lands before
optimisation, and each phase is independently shippable. Task ids are stable;
the audit section each one resolves is linked.

**This file replaces the Q-series.** Q1–Q5 landed and are correct as written —
the pager is windowed, library search is debounced, the two id-keyed Zustand
stores are invalidated, `GroupRow`'s memo is live, the composed gesture is
memoised. `Q0` (dead code plus two compiler flags) never landed and is carried
forward as **R6-5**. The fifth audit's record is preserved in
[AUDIT2 Appendix A](AUDIT2.md).

**Status: P0–P12, P18 and Q1–Q5 are implemented. R0–R5 are done.
R6 and R7 are not started.**

`npm run check` passes — **366 tests, 0 failures**. Everything below awaits
on-device verification.

**[AUDIT.md](AUDIT.md)'s P13–P17 backlog is still open** and has been folded
into this series rather than left in two places:

| Old id | Now | What |
|---|---|---|
| P13 | **R1** | Restore safety — still the highest priority in the project |
| P14 | R7-1, R7-2 | Crash reporting, error boundary |
| P15 | R2-4, R2-5, R6-4 | Selector scans, prefetch keying, search pagination |
| P16 | R6-1, R6-2, R6-3, R6-5 | Prune chunking, cover budget, `sizeCache`, dead code |
| P17 | R7-3, R7-4, R7-5 | `versionCode`, commit hygiene, regression checks |

**No native rebuild is required for any task in this series.** Everything is
JavaScript and arrives over Fast Refresh. R2-1 and R2-2 change the module graph,
which Metro handles on its own.

**Gate before any reload:** `npm run check` (typecheck + tests).
**Persistence changes are verified by force-quitting from recents**, never by a
reload — see [DETAIL.md §6.3](DETAIL.md).

**Benchmark only against a release build.** `npm run android` produces a debug
APK: Hermes parses plain JS instead of bytecode, React double-invokes renders,
and R8 never runs. Numbers from it are 3–8× off and will send you after the
wrong thing. Use `npm run apk:dev`, which builds a release APK explicitly marked
as not for shipping. See [AUDIT2 §4](AUDIT2.md).

---

## Running order, condensed

```
R0-1  four log lines                     DONE      ← everything else is verified against these
R1-1  stream the restore unzip           DONE      ← the only task that protects user data
R1-2  additive unpack, commit last       DONE
R2-1  lazy-import SheetJS                DONE      ← largest cold-start win per line changed
R2-2  lazy-load the reader subtree       DONE
R2-3  toLibrary inside the debounce      DONE
R2-4  incremental cover/count selectors  DONE
R2-5  key prefetchAround on ids          DONE
R2-6  persist thumbnail failures         DONE
R2-7  real size ceilings                 DONE
R3-1  incremental measure()              DONE      ← kills load-time jank in long books
R3-2  first paint inside the document    DONE
R3-3  injectJavaScript for batches       DONE
R3-4  fix useGroupFiles' subscription    DONE
R4-1  two-phase EPUB                    DONE      ← the decisive latency fix
R4-2  cross the boundary with less       DONE
R5-1  warm the WebView across a swipe  DONE
R6-*  scale and housekeeping
R7-*  ship readiness
```

---

## R0 — Instrument first — ☑ done

The whole phase is one task and it is the shortest in the series. Do it before
anything in R2–R5.

Six audits have found real faults by reading code. None of them could have found
[AUDIT2 §1.2](AUDIT2.md) that way, because the cost lives in a dependency's C++.
Four log lines make the entire R2–R5 sequence verifiable instead of plausible —
and, just as important, they will tell you which of R3, R4 and R5 is actually
worth building.

### ☑ R0-1 — Four timers behind `__DEV__`

Resolves [AUDIT2 §4](AUDIT2.md).

**Files:** new `src/ui/perf.ts`; [App.tsx](App.tsx),
[src/store/library.ts](src/store/library.ts),
[src/renderers/webview/prepare.ts](src/renderers/webview/prepare.ts),
[src/renderers/WebViewRenderer.tsx](src/renderers/WebViewRenderer.tsx),
[src/renderers/webview/viewerHtml.ts](src/renderers/webview/viewerHtml.ts)

- [x] Added [src/ui/perf.ts](src/ui/perf.ts) — `PERF`, `now`, `perf`, `mark` /
      `since`, `beginPrepare`, and the three startup notes. Inert when
      `__DEV__` is false
- [x] **Startup:** module-eval (`noteBundleEval` from
      [index.ts](index.ts)), store-hydrate ([store/library.ts](src/store/library.ts)),
      first paint (`reportStartup` at the splash hide in [App.tsx](App.tsx))
- [x] **Prepare:** format, byte size, lane, and four segments — read, cross,
      unzip, assemble — from [prepare.ts](src/renderers/webview/prepare.ts),
      [epub.ts](src/renderers/webview/epub.ts) and
      [offload.ts](src/renderers/webview/offload.ts)
- [x] **Viewer:** `boot` → `ready` → `complete` with batch and image counts,
      from the existing message handler in
      [WebViewRenderer.tsx](src/renderers/WebViewRenderer.tsx)
- [x] **Long tasks:** `measure()` wrapped in the viewer, posting a `perf`
      message over 16 ms with the anchor count

**The guard is `typeof __DEV__`, not `__DEV__`** — and the plan's sketch was
wrong about this:

```ts
export const PERF = typeof __DEV__ !== 'undefined' && __DEV__
```

A bare read throws `ReferenceError` under Node, where `src/__tests__` runs and
`__DEV__` is not declared. Several tests import modules that reach this one, so
the sketched version would have taken down the suite. `typeof` on an undeclared
identifier is legal and yields `'undefined'`, and Metro still substitutes
`false` in release, so both properties hold at once.

**Why a module rather than scattered `console.log`s.** Two reasons. The calls
have to be cheap in release — a `Date.now()` per batch is not free on the path
this series is trying to make fast, and a module-level `const false` reduces
each call site to one comparison — and every line has to be greppable under one
prefix so a session's output can be read as a whole.

**Why `Date.now()` and not `performance.now()`.** Hermes has `performance.now`,
but the numbers here are tens-to-thousands of milliseconds and sub-millisecond
resolution buys nothing. Keep the dependency surface at zero.

**Four changes the plan did not call for**, each because the code demanded it:

1. **`beginPrepare` takes a lane label.** `prefetch.ts` calls `prepareFile` too,
   so without it a speculative neighbour's parse is indistinguishable from the
   file the user is waiting on — and a slow prefetch would read as a slow open,
   which is the opposite conclusion.
2. **`prepareFile` is split into guards + `prepareByFormat`.** One `trace.done()`
   is needed for seven branches that each return directly. Splitting was cleaner
   than indenting the whole switch into a wrapper, and it puts the size ceiling
   and the dispatch in separate functions, which is a better shape anyway.
3. **The viewer's `measure()` is now a wrapper over `measureImpl()`.** Timing
   gates a *value* (`SR_DEBUG`), not an emitted code path, so the script this
   repo's tests parse is the script that ships apart from one boolean. **R3-1
   edits `measureImpl`, not `measure`.**
4. **`buildViewerHtml` gained an optional third parameter.** Defaulted, so the
   four existing call sites in tests are unchanged.

**Three tests changed or added:**

- `lifecycle.test.ts` — *"the size ceiling is checked before the file is read"*
  broke, correctly. It matched `await target.bytes()` at each of seven branches,
  which pinned *how the reads were spelled* rather than *when they happen*. It
  now asserts the structural property — the guard is in `prepareFile`, every
  read is behind one helper inside `prepareByFormat` — and that there is exactly
  **one** bytes read in the file, so a future format cannot read unguarded.
- `viewerHtml.test.ts` — a new test parsing the viewer in **both** modes, and
  asserting the two differ by exactly one interpolated boolean. Without it the
  instrumented viewer — the one every dev build actually runs — would have no
  coverage at all.
- `perf.test.ts` — new. Pins that the module is inert under Node (which is the
  release path), that the disabled trace is a shared singleton rather than an
  allocation per document, and that `assemble` is a remainder that absorbs an
  unreported segment rather than dropping it.

**Gate:** `npm run check` — typecheck clean, **328 tests, 0 failures** (up from
323).

**Verify on device — not yet done.** Open a large EPUB on a build from
`npm run apk:dev` and read four lines shaped like this. **Record them here** —
they are the baseline every later task is measured against, and there is
currently no other record of how slow anything is.

```
[perf] startup   bundle-eval 000ms · store-hydrate 000ms → first-paint 000ms
[perf] prepare   epub 8.2MB [user] → read 000ms · cross 000ms · unzip 000ms · assemble 000ms = 000ms
[perf] viewer    epub boot 000ms → ready 000ms → complete 000ms  (18 batches, 42 images)
[perf] longtask  measure() 000ms over 612 anchors
```

**The number that decides R4-2 is `cross`.** It is wall time inside
`runOnRuntimeAsync` minus the unzip the worklet reports doing, so it is the
boundary cost alone — the figure [AUDIT2 §1.2](AUDIT2.md) derives from the
library's C++ and has never confirmed on hardware. If it comes back small,
**drop R4-2** and spend the effort on R5. That is what instrumenting first is
for.

**Two cautions when reading the output:**

- A `[perf] prepare` line tagged `[prefetch]` is background work nobody was
  waiting on. Do not optimise against it.
- A `[perf] startup` line preceded by a `FAILSAFE` warning describes a launch
  where `load()` never resolved. Its timings are meaningless.

---

## R1 — Restore safety — ☑ done

**The highest priority in the project, and it has been for three audits.**
Carried from [AUDIT.md P13](AUDIT.md), re-verified unchanged against the current
tree. Until both tasks land, the app has a data-recovery path that can destroy
the data it exists to recover.

Do these two together. They are one piece of work: the streaming fix reduces the
window in which a kill can happen, and the swap fix makes the window survivable.
Landing either alone leaves the failure mode intact.

### ☑ R1-1 — Stream the restore unzip

Resolves [AUDIT2 §1.1](AUDIT2.md) / [AUDIT §1.1](AUDIT.md).

**Files:** [src/storage/backup.ts](src/storage/backup.ts)

- [x] `unzipSync(await archive.bytes())` replaced with fflate's streaming
      `Unzip`, entry by entry, in a new `unpackArchive`
- [x] The **compressed** side streams too — the archive is read through
      `archive.readableStream()` rather than `bytes()`, so the whole file is
      never resident either
- [x] `UnzipPassThrough` **and** `UnzipInflate` registered. Our own exports are
      stored, but a user can hand us any zip and an unregistered method makes
      fflate throw inside `start()` — which would surface as an unreadable
      backup for a file that is perfectly fine
- [x] One entry buffered at a time, written synchronously inside fflate's
      callback

**Why one entry is buffered rather than written incrementally.**
`expo-file-system` has no append, so streaming *into* a file would mean holding
a `writableStream` per entry — and fflate delivers chunks synchronously inside
`push`, so those writes could not be awaited in order without stalling the
parser. Buffering one entry bounds peak memory at the largest single file, which
is the property that matters; writing synchronously also gives natural
backpressure, so a fast archive cannot queue decompressed entries faster than
they land.

**Why not the prefetch worklet lane.** [AUDIT.md §1.1](AUDIT.md) suggested it
and was right at the time. [AUDIT2 §1.2](AUDIT2.md) changes the answer: crossing
the boundary with the archive costs two full copies of it, which is exactly what
this task exists to stop holding.

**Not done: sharing one helper with `exportLibrary`.** [AUDIT §7](AUDIT.md) asks
for it, and it is still the right instinct — but the two directions turned out
to share almost nothing in practice. Export pushes entries it chooses into a
`Zip`; restore reacts to entries an untrusted archive chooses, with path
validation, index capture and a manifest. A shared helper would be a parameter
bag with two disjoint halves. **The duplication is four lines of fflate setup**,
which is not the shape [DETAIL.md §6.12](DETAIL.md) warns about.

### ☑ R1-2 — Additive unpack, commit last

Resolves [AUDIT2 §1.1](AUDIT2.md) / [AUDIT §1.2](AUDIT.md).

**Files:** [src/storage/backup.ts](src/storage/backup.ts)

**This diverges from the plan, deliberately.** The plan said unpack to a sibling
directory and rename it into place. That needs a **directory rename onto a
destination that does not exist** — which is precisely the operation Android's
`moveSync` refuses with `NoSuchFileException` naming the destination, even when
it has just been created ([DETAIL.md §6.3](DETAIL.md)). The plan flagged the
hazard and then specified the operation anyway. Building the one path that
protects the user's whole library on top of it would be repeating a mistake this
project has already paid for once.

- [x] Nothing is deleted before the commit. Entries stream **straight into**
      `LIBRARY_DIR`, which is purely additive
- [x] `replaceLibrary` stays the commit point and runs last
- [x] `pruneToManifest` reclaims the previous library's files **after** the
      commit, using what this restore actually wrote plus what the new index
      references

**Why additive reaches the same guarantee.** The property wanted is "no window
in which the library is neither the old one nor the new one". Adding files does
not violate the old index — every file it references is still present and still
correct — so until `replaceLibrary` commits, a kill leaves the previous library
working, plus some unreferenced bytes. After the commit, a kill leaves the new
library working, plus the old files as orphans. There is no intermediate state,
and it uses only writes and one transactional index update, both of which this
platform does reliably.

**Why the prune is after the commit and by manifest.** It is housekeeping, so a
kill during it costs disk space rather than files. By manifest rather than "wipe
first" because `pruneOrphans` alone would not do: it is throttled to once a day
and refuses to run on an empty library, so leaving it to chance would mean a
restore silently doubling the app's storage until tomorrow.

**Why the index is validated mid-stream.** `exportLibrary` writes
`library.json` as the first entry, so in practice it is validated before a
single file is written and a malformed backup is rejected having touched
nothing. The check cannot be hoisted out of the stream — the entry's position
is a property of the archive, not something we control — so a hand-made archive
that puts it last is validated last, and rejecting one leaves a few orphans
behind. That is the honest trade for never holding the whole library in memory.

**Seven tests added**, in a new
[backupRestore.test.ts](src/__tests__/backupRestore.test.ts) — the ordering
property [AUDIT §7](AUDIT.md) has asked for across three audits is now pinned:

- every entry recovered byte-for-byte, including invalid UTF-8 and a NUL
- **peak buffering is exactly one entry** at 40 entries, which is the whole
  point of the rewrite
- the commit is last, and the index is read first
- an archive with no index, and one with a malformed index, are both refused
- path traversal (`files/../../evil.txt`, nested paths) cannot escape
- a **deflated** archive restores, which is what pins the decoder registration

`storage/backup.ts` still cannot be imported under Node (`expo-file-system`), so
the unpack is mirrored exactly, the same way `backup.test.ts` mirrors the export.
That is stated in the file's header along with what it cannot prove.

**Verify on device — not done:**

1. Start a restore of a large archive
2. **Force-quit from recents** partway through
3. Relaunch → the *previous* library must be intact and complete

Repeat at three different points. Per [DETAIL.md §6.3](DETAIL.md), a reload does
not test this — only a process kill does. Also check peak memory with
`adb shell dumpsys meminfo com.stackread.app` during a 300MB+ restore: it must
stay proportional to the largest single file, not to the library.

---

## R2 — Free wins — ☑ done

Seven small, independent, low-risk tasks. None changes an architecture and all
seven fit in a day. R2-1 is the best latency-per-line-changed in the repository.

### ☑ R2-1 — Lazy-import SheetJS

Resolves [AUDIT2 §2.2](AUDIT2.md).

**Files:** [src/renderers/webview/prepare.ts](src/renderers/webview/prepare.ts)

- [x] Static `import * as XLSX from 'xlsx'` deleted
- [x] `prepareSheet` is async and `await import('xlsx')` inside it
- [x] Both call sites (`xlsx`, `csv`) already `return` inside an async function,
      so no `await` was needed at either
- [x] Comment added, pairing it explicitly with `prepareDocx` below

```ts
/**
 * Imported lazily, for the same reason mammoth is: SheetJS is ~975KB of
 * JavaScript and most sessions never open a spreadsheet.
 *
 * This is not a micro-optimisation. Expo SDK 57's Metro config sets
 * `inlineRequires: false`, so a static import here is evaluated during app
 * startup — before the splash can hide — on every cold launch, for every user,
 * whether or not they own a single .xlsx.
 */
async function prepareSheet(bytes: Uint8Array): Promise<Prepared> {
  const XLSX = await import('xlsx')
  // ...body unchanged
}
```

**Why this was missed.** `prepareDocx` lazy-imports mammoth ten lines below,
with the reasoning spelled out. The same reasoning applies verbatim to SheetJS
and was not carried across — the fourth audit's class of fault, inside one
function's neighbourhood. Writing the comment above is what stops it recurring.

**Verify:** R0-1's `bundle-eval` figure drops. On a release build expect a
double-digit percentage of startup to disappear; on debug the improvement will
look larger and should not be believed. Then open an `.xlsx` and confirm it
still renders with dates as `15/01/2024` rather than `45306` — the `cellDates`
/ `raw: false` behaviour must be unchanged.

### ☑ R2-2 — Lazy-load the reader subtree

Resolves [AUDIT2 §2.2](AUDIT2.md).

**Files:** [App.tsx](App.tsx)

- [x] `const ReaderScreen = lazy(() => import('./src/screens/ReaderScreen'))`
- [x] Default export added to `ReaderScreen.tsx`; the named one is kept
- [x] Reader branch wrapped in `<Suspense fallback={null}>`
- [x] Verified `ReaderTransition` imports no renderers, so it stays eager and is
      what paints over the chunk load

**Why `fallback={null}` and not a spinner.** `ReaderTransition` is already
animating an opaque backdrop over this exact moment
([App.tsx](App.tsx) — *"the reader animates in from card size… painting the
app's own background behind it is what keeps the transition from flashing blue
at both ends"*). A spinner would appear *behind* that backdrop and never be
seen, and a second loading affordance during a designed transition is worse than
none.

**What this removes from startup:** `react-native-pdf`, the WebView host,
[viewerHtml.ts](src/renderers/webview/viewerHtml.ts)'s 1,511-line template
literal, `pagination`, `epub`, `bookCss`, `sanitize` and — until R2-1 lands —
SheetJS. None of it is needed to paint the board.

**Verify:** `bundle-eval` drops again. Then open a file **from a cold start** and
confirm the transition is unchanged — the chunk load lands during an animation
that is already covering the screen, so if it is visible at all, this task needs
a different fallback.

### ☑ R2-3 — Move `toLibrary()` inside the debounce

Resolves [AUDIT2 §2.4](AUDIT2.md).

**Files:** [src/store/library.ts](src/store/library.ts),
[src/storage/library.ts](src/storage/library.ts)

- [x] `scheduleSave` now takes a **thunk** (`() => Library`) rather than a
      flattened library
- [x] `toLibrary()` runs once, inside the timer, immediately before
      `saveLibraryNow`
- [x] `flushLibrarySave` does the same on its synchronous path, clearing
      `pending` **before** the flatten so a throw cannot leave a stale thunk to
      be re-run against state that has since moved on
- [x] Only `persist()` needed changing — it is the single caller, so the eleven
      call sites were untouched

**Why this is not already correct.** `scheduleSave` debounces the *write*, which
was the expensive half before SQLite and is cheap now. The *flatten* —
`{ ...entry, orderInGroup: index }` for every file in the library
([library.ts:83-97](src/store/library.ts#L83-L97)) — was never debounced. It
runs synchronously inside every reducer, so importing 50 files with thumbnails
rebuilds the whole library 50 times while the board is animating those cards in.

**Watch for one trap.** The state handed to the timer must not be a live
reference that mutates before it fires. Zustand's reducers already return fresh
top-level objects, so capturing `{ groups, filesById, groupOrder }` by value at
`persist()` time is correct — capture the three references, not `get()`.

**Verify:** import 50 files at once. With R0-1's `store-hydrate` timing plus a
temporary counter on `toLibrary`, the call count must drop from ~50 to 1–2. The
board's card entrance animation should visibly stop stuttering during an import.

### ☑ R2-4 — Incremental `pdfsNeedingCovers` and `useFileCount`

Resolves [AUDIT2 §3.2](AUDIT2.md) / [AUDIT §2.2](AUDIT.md).

**Files:** [src/store/library.ts](src/store/library.ts),
[src/store/selectors.ts](src/store/selectors.ts)

- [x] `pdfsNeedingCovers` and `fileCount` added to the store state
- [x] Maintained in `normalize` (the one full scan, at load) plus `addFiles`,
      `removeFile`, `removeGroup`, `setThumb` and `reload`
- [x] Both selectors are plain reads, and their docstrings rewritten — they
      described the old implementation
- [x] `useShallow` is gone; identity stability now comes from `dropIds`

**What to preserve.** The docstring's defence of returning **ids rather than
entries** is correct and load-bearing: `PdfCoverFactory`'s whole job is to call
`setThumb`, and a selector returning entries would see every one of those writes
and re-drive the effect that produced them. Carry that paragraph over verbatim.
It is the scan, not the shape, that this task removes.

**Verify:** with 2,000 files, hold a key down in a group-title field. Before:
each keystroke walks all 2,000 entries twice. After: no scan at all. Frame rate
during a rename should be flat.

### ☑ R2-5 — Key `prefetchAround` on ids, not the array

Resolves [AUDIT2 §3.3](AUDIT2.md) / [AUDIT §2.3](AUDIT.md).

**Files:** [src/screens/ReaderScreen.tsx](src/screens/ReaderScreen.tsx)

- [x] Dependency array changed to the three window ids, with the reasoning
      inline

```ts
useEffect(() => {
  prefetchAround(files, index)
  // The identity of `files` changes on any file's metadata write (a thumbnail
  // landing, a progress update), because it is a useMemo over `filesById`.
  // What prefetching actually depends on is which three files are in the
  // window, so that is what this watches.
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [files[index - 1]?.id, files[index]?.id, files[index + 1]?.id])
```

**Verify:** open a file and read it. Instrument `prefetchAround`'s entry count
temporarily — before, it fires on every thumbnail and progress write; after,
only on a page turn.

### ☑ R2-6 — Persist thumbnail failures

Resolves [AUDIT2 §3.4](AUDIT2.md).

**Files:** [src/storage/thumbs.ts](src/storage/thumbs.ts),
[src/storage/mmkv.ts](src/storage/mmkv.ts),
[src/storage/lifecycle.ts](src/storage/lifecycle.ts)

- [x] `attempted` is now two tiers: the in-memory set for the session, plus a
      durable `thumbfail:<fileId>` key in MMKV
- [x] Written **only** on a genuinely negative outcome — "this archive declares
      no cover". The `catch` path is deliberately *not* recorded, because an
      `ImageManipulator` throw can be transient and would otherwise mark a good
      file as coverless forever
- [x] `resetThumbnailAttempt` clears both tiers, so
      [lifecycle.ts](src/storage/lifecycle.ts)'s existing call covers the new
      key without a new entry — noted at that call site
- [x] `resetAllThumbnailAttempts` sweeps every `thumbfail:` key by prefix.
      **This one matters for restore**: an export preserves ids, so a stale flag
      would describe the previous library's bytes under an id the new one also
      uses, and a restored book with a cover would never get one. Filtered by
      prefix rather than `clearAll()`, because the same instance holds reading
      positions a restore has just written

**Why this matters more than it looks.** A file that legitimately yields no
cover — an EPUB with no declared cover image, a comic whose first entry is not
an image — is retried on **every cold launch**, two at a time, and each retry is
a full unzip through the boundary described in [AUDIT2 §1.2](AUDIT2.md). On a
library with fifty such files that is fifty archive decompressions per launch,
producing nothing, competing with the board's first paint.

**Obey the rule in [lifecycle.ts](src/storage/lifecycle.ts).** This is a seventh
id-keyed cache. Its module docstring says in bold that every one of them must be
invalidated there. Add the line in the same commit that adds the cache — that is
the entire point of the module existing.

**Verify:** import an EPUB with no cover image. Cold-start twice. The second
launch must attempt no unzip for it — visible as the absence of a
`[perf] prepare` line from R0-1.

### ☑ R2-7 — Size ceilings that can actually be reached

Resolves [AUDIT2 §3.6](AUDIT2.md).

**Files:** [src/storage/formats.ts](src/storage/formats.ts)

- [x] `comic` and `archive` dropped from `300_000_000` to `40_000_000`
- [x] Rationale recorded in the comment, including that they should be raised
      after R4-1 and R4-2 and re-verified on a device

```ts
comic:   40_000_000,
archive: 40_000_000,
```

**Why.** 300 MB is not a ceiling, it is a comment. With the boundary copying in
[AUDIT2 §1.2](AUDIT2.md) and the whole-archive materialisation in §1.3, a 300 MB
comic needs well over a gigabyte of transient heap and the process is killed
long before the check would fire. A refusal the user can read is strictly better
than an OOM kill they cannot.

**Raise these deliberately after R4-1 and R4-2 land**, when a larger number
means something, and verify the new figure on a real device rather than
assuming it.

**Verify:** try to open a 100 MB CBZ. A clear "too large to display" message
with the size and the limit, not a crash.

**Two things this phase turned up that were not in the plan:**

1. **A vacuous test.** `perceivedSpeed.test.ts` asserted `useShallow` appeared
   within 400 characters of `usePdfsNeedingCovers`. Once the list became a
   maintained store value that regex started matching `useShallow` in
   **`useGroupPreviews`' docstring two functions below** — so the test kept
   passing while asserting nothing at all. It is now pinned to the real shape,
   and the identity property it was guarding moved to a behavioural test.
2. **`dropIds` was extracted to [src/store/derived.ts](src/store/derived.ts).**
   `store/library` imports `expo-sqlite` transitively and cannot load under
   Node, so the one piece of logic with a property worth asserting was
   untestable where it sat — the same reasoning that put
   [libraryDiff.ts](src/storage/libraryDiff.ts) in its own module.
   [derived.test.ts](src/__tests__/derived.test.ts) pins the identity guarantee,
   including that thirty unrelated thumbnails do not change the reference once.

**Two counter-drift bugs closed while wiring R2-4**, neither in the plan and
both silent if left:

- `addFiles` added `entries.length` blind. The group-undo path calls it with
  entries removed a moment earlier, and nothing structurally stops a caller
  passing an id already present — which would leave `fileCount` permanently too
  high. It now counts only ids that were genuinely absent.
- `removeGroup` subtracted the membership array's length. `groupOrder` can
  briefly hold an id with no file — `useGroupFiles` documents and tolerates
  exactly that — so it now counts only ids that actually had an entry.

A maintained counter that can drift is worse than the scan it replaced, because
the drift is silent and survives for the life of the session.

**Gate:** `npm run check` — typecheck clean, **342 tests, 0 failures** (up from
328).

**Not verified on device.** R2-1 and R2-2 are startup changes and their whole
justification is a number: read R0-1's `bundle-eval` before and after, on a
build from `npm run apk:dev`. R2-6's effect is the *absence* of a
`[perf] prepare` line for a coverless EPUB on the second cold start.

---

---

## R3 — Transport — ☑ done

Where the content actually moves. R3-1 is independent and can go first; R3-2 and
R3-3 are one piece of work.

### ☑ R3-1 — Incremental `measure()`

Resolves [AUDIT2 §2.3](AUDIT2.md).

**Files:** [src/renderers/webview/viewerHtml.ts](src/renderers/webview/viewerHtml.ts)

- [x] Track `measuredAnchors` and `measuredItems` alongside `pbTops` / `itemTops`
- [x] In `measure()` ([:496](src/renderers/webview/viewerHtml.ts#L496)), query
      once and read `offsetTop` only for nodes at index `>= measuredAnchors`
- [x] Keep the full re-measure on `resize`, where every offset genuinely changes
- [x] Pass a flag so `appendChunk` ([:1379](src/renderers/webview/viewerHtml.ts#L1379))
      takes the incremental path and the resize handler takes the full one

```js
function measure(full) {
  // ...paper/items geometry unchanged...

  var breaks = el.querySelectorAll('.sr-pb');
  if (full) { pbTops = []; pbLabels = []; measuredAnchors = 0; }

  /*
   * Only anchors appended since the last call are measured.
   *
   * Content is only ever appended -- appendChunk uses
   * insertAdjacentHTML('beforeend') -- so an anchor measured before a batch
   * has an unchanged offsetTop afterwards. Re-reading all of them per batch
   * made loading a 600-page book O(batches x pages) forced layouts, each one
   * over a document that had just grown. A resize is the one event that
   * invalidates every offset, and it passes full=true.
   */
  for (var b = measuredAnchors; b < breaks.length; b++) {
    pbTops.push(breaks[b].offsetTop);
    pbLabels.push(breaks[b].getAttribute('data-page') || String(b + 1));
  }
  measuredAnchors = breaks.length;

  scrollRange = document.body.scrollHeight - window.innerHeight;
}
```

- [x] Apply the identical treatment to `itemTops` for `items` mode
      ([:513](src/renderers/webview/viewerHtml.ts#L513)) — a long comic has the
      same shape
- [x] Extend [viewerHtml.test.ts](src/__tests__/viewerHtml.test.ts): appending
      three batches must produce the same `pbTops` as one full measure over the
      whole document

**Watch the one hazard.** Images finishing decode change layout *above* already
measured anchors. The existing image-load handlers at
[:1243](src/renderers/webview/viewerHtml.ts#L1243) already call `measure()` —
those must pass `full = true`, or a book with illustrations will report page
numbers that drift as its images land.

**Consider the better version.** An `IntersectionObserver` over `.sr-pb`
replaces the whole scan with zero forced layout and no scroll-handler work, and
composes with streaming appends for free. It is a larger change to `currentPage`
and `seekToPage`, so it is worth doing only if R0-1's `longtask` line says the
scan still dominates after this task. Recorded here so it is not lost.

**Verify:** R0-1's `[perf] longtask measure()` line. On a 600-page EPUB with a
publisher page list, the per-batch figure must stop growing as the book loads.
Then check the page counter still reports the publisher's own numbers — including
roman numerals in front matter, which is what `pbLabels` exists for.

### ☑ R3-2 — First paint travels inside the document

Resolves [AUDIT2 §2.1](AUDIT2.md).

**Files:** [src/renderers/WebViewRenderer.tsx](src/renderers/WebViewRenderer.tsx),
[src/renderers/webview/viewerHtml.ts](src/renderers/webview/viewerHtml.ts)

- [x] Give `buildViewerHtml` an optional initial-payload parameter
- [x] Emit the content into `<div id="paper">` and the metadata into a
      `window.__SR_INITIAL` literal, so the boot script renders it without a
      message
- [x] In `WebViewRenderer`, defer constructing `source` until `payload` exists;
      memoise on `[theme, initialScroll, payload]`
- [x] Skip the `boot → push → ready` round trip when the payload was inlined —
      the viewer posts `ready` directly

**Why this is the right fix and the obvious one is closed.**
[TASKS.md P4-1](TASKS.md) already investigated serving content from disk:
`allowingReadAccessToURL` is **iOS-only**, and the Android equivalent would open
the WebView to the whole app sandbox. That path stays shut and this task does not
reopen it.

What it exploits instead is that `source={{ html }}` on Android goes through
`loadDataWithBaseURL` — **Chromium's HTML parser**. The current path sends the
same bytes through `postMessage`, which the library compiles into an
`evaluateJavascript` call, so the content is parsed by the **JavaScript** parser
after being JSON-escaped twice (once in JS, once by `JSONObject.toString()` in
`RNCWebViewManagerImpl.kt:322`). Moving the first paint into the document
removes all four passes for the largest single chunk, and the boot round trip
with it.

**The size is already bounded**, which is what makes this safe:
`FIRST_PAINT_CHARS = 120_000` ([epub.ts:76](src/renderers/webview/epub.ts#L76))
caps the assembled markup, so this is never a multi-megabyte prop.

**The security posture is unchanged.** Same `originWhitelist`, same
`onShouldStartLoadWithRequest`, same `allowFileAccess={false}`. The content was
already going into this WebView; only the door it enters by changes. Note it
explicitly in the diff anyway — [CLAUDE.md](CLAUDE.md) requires any change near
these flags to be called out.

**Verify:** R0-1's `[perf] viewer boot → ready` line. For a warm-cache open the
`boot` segment should disappear entirely. Then confirm the escaping is right:
open a document containing `</script>`, a backtick, `${`, and a lone `\` — all
four are what an interpolated HTML payload gets wrong, and all four appear in
real Markdown and code files.

### ☑ R3-3 — `injectJavaScript` for streamed batches

Resolves [AUDIT2 §2.1](AUDIT2.md).

**Files:** [src/renderers/WebViewRenderer.tsx](src/renderers/WebViewRenderer.tsx),
[src/renderers/webview/viewerHtml.ts](src/renderers/webview/viewerHtml.ts)

- [x] Add a `window.__srAppend(b64, isLast)` entry point to the viewer that
      `atob`s and `TextDecoder`s its argument, then calls the existing
      `appendChunk`
- [x] Replace the batch `postMessage`
      ([WebViewRenderer.tsx:436](src/renderers/WebViewRenderer.tsx#L436)) with
      `injectJavaScript`
- [x] Encode the batch to base64 on the worklet lane — `toBase64OffThread`
      already exists ([offload.ts:166](src/renderers/webview/offload.ts#L166))
- [x] **Leave every small control message on `postMessage`** — `settings`,
      `seek`, `seekHref`, `search`, `searchNext`. They are a few hundred bytes
      and the existing path is perfectly good for them

```ts
webRef.current.injectJavaScript(
  `window.__srAppend('${b64}',${last});true;`,
)
```

**Why base64 rather than the raw string.** `injectJavaScript` is
`evaluateJavascriptWithFallback(args.getString(0))` with **no `JSONObject`
wrapping**, so one escape pass disappears immediately. But interpolating raw
HTML into a JS string literal means escaping quotes, backslashes and newlines by
hand — exactly the class of bug the viewer's template literal already has a test
for. Base64's alphabet contains no character requiring escaping, so the literal
is safe by construction *and* V8 tokenises it as one opaque string rather than
parsing escaped markup. The 4/3 size increase is repaid many times over by not
running a JavaScript parser across a book.

**The `true;` terminator is required**, not cosmetic — `injectJavaScript`
evaluates its argument as an expression on some Android versions, and returning
a large value stalls the call.

**Verify:** R0-1's `[perf] viewer … → complete` figure, on a large EPUB with
twenty batches. Then confirm no content is lost or duplicated: the appended
document must have exactly as many `.sr-chapter` elements as the book has spine
items.

### ☑ R3-4 — Fix `useGroupFiles`' second subscription

Resolves [AUDIT2 §3.1](AUDIT2.md).

**Files:** [src/store/selectors.ts](src/store/selectors.ts),
[src/components/FileCard.tsx](src/components/FileCard.tsx),
[src/components/GroupRow.tsx](src/components/GroupRow.tsx)

- [x] Change `useGroupFiles` to return **ids**, not entries
- [x] Have `FileCard` subscribe to its own entry:
      `useLibrary((s) => s.filesById[id])`
- [x] Update `GroupRow`'s map and `DraggableCard`'s props accordingly
- [x] Fix the docstring — it currently claims the opposite of what the code does

**The bug, stated plainly.** [selectors.ts:43-44](src/store/selectors.ts#L43):

```ts
const ids = useLibrary((s) => s.groupOrder[groupId]) ?? EMPTY_IDS
const filesById = useLibrary((s) => s.filesById)   // ← replaced by every write
```

`groupOrder`'s identity is stable per group — that is the property the
normalization was built for and it works. But `filesById` is a second
subscription and every reducer replaces the whole map, so one thumbnail landing
re-runs every mounted row's `useMemo`, allocates a new array per row, re-renders
every `GroupRow`, and runs every `FileCard` comparator. The docstring says
*"editing a file's metadata does not re-render them at all."* It does.

**Why per-card subscription rather than structural sharing in `setThumb`.**
Both work. This one is better because the pattern is already proven in the same
component: `FileCard` subscribes to its own MMKV progress key
([FileCard.tsx:74](src/components/FileCard.tsx#L74)) for exactly this reason,
and the comment there explains it well. Doing the same for the entry makes the
two consistent and removes the dependency rather than making it cheaper.

**Also fix the docstring in the same commit.** [AUDIT2 §3.1](AUDIT2.md) counts
this as an enforcement fault — the fifth audit's class — precisely because the
file that documents the rule is the file that breaks it. A correct fix with a
stale comment leaves the trap armed.

**Verify:** 20 groups × 50 files. Import ten new files and watch a render
counter on `GroupRow`. Before: every row re-renders ten times. After: only the
target row, once per import.

**Four deviations from the plan, each because the code demanded it:**

1. **The flag is `incremental`, not `full` — inverted.** The plan had eight call
   sites pass `full=true` and one pass nothing. That makes the *dangerous*
   behaviour the default: a call site added later and forgotten would silently
   take the incremental path and report wrong page numbers. Inverted, a
   forgotten argument gives a full measure — correct but slower. Only
   `appendChunk` passes `true`, and it is the only caller that can prove nothing
   above it moved.
2. **R3-2 is a JSON island, not content in the div.** Putting the content
   straight into the markup would skip `render()` — which is where the viewer's
   **DOM sanitiser** runs, and that is the stronger of the two passes. A
   `<script type="application/json">` block is read by the HTML parser as raw
   text, so it removes the double-escape and the JavaScript parse while keeping
   the entire existing render path, sanitiser included.
3. **Only a *warm* mount inlines.** A cold open still gets an empty shell and
   the message path, deliberately: the WebView can construct itself while
   `prepareFile` runs, and rebuilding `source` when the parse lands would throw
   that overlap away and reload the page. `inlinedPayload` is captured once at
   mount and compared by identity, so a later payload still pushes normally.
4. **`strToU8`, not `TextEncoder`.** R3-3 encodes each batch to base64 on the
   worklet lane. `TextEncoder` **does not exist in React Native** — not in the
   polyfills, not in Hermes — so it would have thrown, been swallowed by the
   catch, and silently truncated every streamed book. fflate is already a
   dependency and is already the UTF-8 encoder on the export path.

**A bug the tests caught, worth recording because it was invisible.** The island
escapes `<` to the JSON sequence so that a document containing `</script>`
cannot terminate the block. Written inside a template literal, a single
backslash makes that replacement `<` → `<` — a **no-op**. It typechecked, it
looked right, and the injection test failed immediately. The comment at that
line now says why the backslash is doubled.

**The dead `append` message branch was removed**, not kept as a fallback. Both
halves ship in the same bundle — the viewer *is* a template literal in the same
file — so there is no version skew for it to absorb.

**Two tests were repaired rather than deleted**, and both had drifted for the
same reason: they sliced the emitted script from `function measure()`, which is
now the timing wrapper rather than the body. The properties they pin are
unchanged; only the address moved. `perceivedSpeed.test.ts` now slices from
`measureImpl`.

**Twelve tests added**, in [viewerHtml.test.ts](src/__tests__/viewerHtml.test.ts):

- measuring in three batches produces exactly the same anchors as one full
  measure — the property R3-1 rests on
- a full measure rebuilds rather than accumulating, and an incremental measure
  with nothing new is a no-op
- an inlined payload round-trips through the island
- **content cannot break out of the island** — `</script><img onerror=...>`
  survives as data, and every `<` is escaped
- the emitted viewer still parses with an island present
- `boot` is still posted when a payload is inlined, so the two sides can
  disagree about inlining and still render once rather than not at all
- a batch survives the base64 round trip with curly quotes, em dashes, accents,
  CJK and an astral-plane emoji
- base64 output needs no escaping inside the injected string literal

**Gate:** `npm run check` — typecheck clean, **354 tests, 0 failures** (up from
342).

**Not verified on device.** R3-1's effect is R0-1's `[perf] longtask` line
ceasing to grow per batch on a long book. R3-2 and R3-3 show up as the `boot`
segment of `[perf] viewer` disappearing on a warm swipe, and a shorter
`→ complete`. R3-4 is a render-count observation, not a timing one.

---

---

## R4 — The document pipeline — ☑ done

The decisive phase for the reported latency. **Do R4-1 before R4-2** — it is
cheaper, it is independently shippable, and it removes most of R4-2's cost as a
side effect by shrinking what crosses the boundary in the first place.

### ☑ R4-1 — Two-phase EPUB loading

Resolves [AUDIT2 §1.3](AUDIT2.md).

**Files:** [src/renderers/webview/epub.ts](src/renderers/webview/epub.ts),
[src/renderers/webview/offload.ts](src/renderers/webview/offload.ts),
[src/renderers/webview/prepare.ts](src/renderers/webview/prepare.ts)

- [x] Add `unzipFilteredOffThread(bytes, filter, lane)` to `offload.ts`, passing
      fflate's `UnzipOptions.filter` through
- [x] Add `listEntriesOffThread(bytes, lane)` — a filter that returns `false`
      for everything and collects `{ name, originalSize }`, decompressing nothing
- [x] **Phase 1:** list entries, then decompress only `META-INF/container.xml`,
      the OPF, the nav/NCX, every `text/css` entry, and the first ~3 spine items.
      Assemble and return
- [x] **Phase 2:** decompress and assemble the remaining spine on the prefetch
      lane, feeding the existing `rest` batching
- [x] Post an exact `totalPages` correction when phase 2 completes

```ts
// Phase 1 gets the whole manifest without decompressing a single entry.
// fflate's filter receives every entry's central-directory record, which
// carries `originalSize` -- the uncompressed byte count -- for free.
const entries: { name: string; originalSize: number }[] = []
unzipSync(bytes, {
  filter: (f) => { entries.push({ name: f.name, originalSize: f.originalSize }); return false },
})
```

**How the pagination invariant survives, because this is the part that must not
break.** [DETAIL.md §5.2](DETAIL.md)'s rule is that a page count comes from
content and never from layout, so it cannot become a function of screen size,
font, orientation — or, now, load progress. The two tiers hold:

1. **The publisher's `page-list` still wins, unchanged and on the first frame.**
   It lives in the nav document or the NCX — two small entries, both decompressed
   in phase 1. A book that declares its pages reports them exactly as it does
   today.
2. **The character estimate becomes provisional, then exact.** Phase 1 computes
   `Σ originalSize` over the spine's XHTML entries divided by a calibrated
   constant; phase 2 replaces it with the real `visibleTextLength` count.

The provisional number is derived from the book's own bytes, so it is still a
function of content and not of layout — rotating the phone still cannot change
it, which is the property that actually matters. It lands within a few percent
for XHTML, it is corrected within seconds, and it is cached thereafter.

- [x] **Calibrate the constant rather than guessing it.** Run
      `scripts/inspect-epub.mjs` across the test library, compare
      `Σ originalSize` to the real `visibleTextLength`, and put the measured
      ratio in the constant's comment. A bare divisor with no rationale is
      exactly what [CLAUDE.md](CLAUDE.md) warns will be "cleaned up" by the next
      reader
- [x] Extend [pagination.test.ts](src/__tests__/pagination.test.ts): a book with
      a `page-list` must report identical counts in phase 1 and phase 2

**Verify:** R0-1's `[perf] prepare` line on a 600-page EPUB. `assemble` must
drop from seconds to tens of milliseconds. Then open a book with a publisher
page list and confirm the count is correct on the **first frame**, not after a
correction — that is the tier-1 path and it must not have regressed.

### ☑ R4-2 — Cross the boundary with less, not with everything

Resolves [AUDIT2 §1.2](AUDIT2.md).

**Files:** [src/renderers/webview/offload.ts](src/renderers/webview/offload.ts),
[src/renderers/webview/epub.ts](src/renderers/webview/epub.ts),
[src/renderers/webview/prepare.ts](src/renderers/webview/prepare.ts),
[src/renderers/webview/sanitize.ts](src/renderers/webview/sanitize.ts),
[src/renderers/webview/pagination.ts](src/renderers/webview/pagination.ts)

- [x] Make the pure helpers worklet-capturable: `sanitizeHtml`, `visibleTextLength`,
      `pagesFromChars`, `resolvePath`, `injectPageAnchors`, the XML helpers
- [x] Add `prepareEpubOffThread(bytes, lane)` returning
      `{ html, totalPages, toc, rest, imageRefs }` — a string, three small
      values and a list of offsets
- [x] Do the same for `prepareComic` and `prepareArchive`
- [x] **Return image *references*, not bytes.** `{ token, mime, entryName }` —
      decompress each on demand at delivery time
- [x] Leave `prepareDocx` and `prepareSheet` on the JS thread: both are heavy
      lazy imports that a worklet closure cannot capture, and neither produces a
      large intermediate record

**The measurement this task is chasing.** A 10 MB EPUB currently crosses the
boundary as 10 MB in and ~30 MB out, and `react-native-worklets` copies every
typed array **twice** in each direction — once into a `std::vector<uint8_t>`, once
`memcpy`'d into a fresh `ArrayBuffer` (`Serializable.h:261`,
`Serializable.cpp:147`). That is roughly 80 MB of memcpy and a ~70 MB peak,
before a single character is parsed. Returning ~120 KB of first-paint HTML
instead is a **~250× reduction in boundary traffic**.

**The images channel is the trap.** `PreparedImage.bytes` are raw `Uint8Array`s;
returning them reintroduces exactly the crossing this task removes. Returning
offsets and decompressing lazily is also what the streaming delivery in
[WebViewRenderer.tsx:449-502](src/renderers/WebViewRenderer.tsx#L449-L502)
already assumes it is doing — *"a book whose reader closes it after two pages
never pays for the images they did not reach."* Today it pays for all of them at
parse time.

- [x] Keep the `canOffload()` fallback and make sure it still runs the *same*
      code path synchronously. The current fallback's honesty — one
      implementation, two threads — is the property that stops the two diverging,
      and it must survive this refactor
- [x] `unzipOffThread` becomes unused once all three callers move. Delete it
      rather than leaving it; per [DETAIL.md §6.12](DETAIL.md), a function
      describing an abandoned approach is an invitation to reintroduce it

**Verify:** R0-1's `[perf] prepare` line. The `cross` segment must collapse to
near zero. Then watch peak memory during a 30 MB CBZ open in
`adb shell dumpsys meminfo` — it must stay well under the current figure, and
that is what makes R2-7's ceilings raisable.

**R4-1: what "two-phase" turned out to mean.**

The first attempt filtered the unzip correctly and still ran phase 2 before
returning — so the reader waited for the whole book exactly as before, and the
task's own verify criterion (*"`assemble` must drop from seconds to tens of
milliseconds"*) would have failed. Filtering the *decompression* is not the
point; deferring the *assembly* is. `loadRest` is therefore a **thunk** on
`EpubResult`, called by the renderer's streaming effect once the viewer reports
it is on screen.

That also made the provisional page count load-bearing rather than decorative.
With phase 2 deferred, `charCount` at return time covers only the opening
chapters, so a book with no declared page list genuinely cannot be counted yet —
which is what `provisionalPageCount` is for, and why the calibration below
matters.

**The constant was measured, not guessed**, as the task required:

```
plain prose, few tags .................. 1.014 bytes/char
typical: headings, emphasis, links ..... 1.083
the generated test EPUB ................ 1.232
heavy: spans, classes, epub:type ....... 1.474
```

`BYTES_PER_VISIBLE_CHAR = 1.2` sits in the middle, and
[pagination.test.ts](src/__tests__/pagination.test.ts) pins that all four stay
within 25% — so someone "tidying" it to 1.0 gets a failing test rather than a
book reporting 23% too many pages.

**A bug this restructure introduced, and the fix.** Splitting the unzip meant
images were no longer in any decompressed slice, so `registerImage` resolved
nothing and **every illustration silently vanished**. Caught by reading the
function rather than by a test — nothing would have failed. R4-2 then removed the
problem entirely by making registration size-based.

**`provisionalPageCount` moved to
[pagination.ts](src/renderers/webview/pagination.ts)** — `epub.ts` imports
`expo-file-system` and cannot load under Node, so the one piece of new logic
worth asserting was untestable where it sat. Same reasoning as `derived.ts` in
R2 and `libraryDiff.ts` before it.

---

**R4-2 was rescoped, and the reason is that R4-1 spent most of its
justification.**

The task was written against *"a 10 MB EPUB crosses the boundary as 10 MB in and
~30 MB out"*. After R4-1 that is no longer true: an open crosses with the
container, the OPF, the nav, the stylesheets and three chapters — measured at
**54% of a 6-chapter test book, and far less as chapter count grows**, since the
deferred share is everything past the third.

What remained was the one genuinely unbounded crossing, and it is the trap the
task itself named: **images**. Those are now **registered by path and size from
the ZIP central directory** — no decompression, no crossing, and critically no
place in the prepared-document cache, which previously held up to 24MB per book
with three pinned at once. `loadImages` fetches them in one targeted pass when
the renderer starts streaming, so a book closed after two pages decompresses
nothing — which the delivery code has claimed since P4-1 and could not deliver,
because parsing had already paid for every image.

**What was deliberately not done, and why:**

- **Moving the parser itself into the worklet.** It would mean capturing
  `fast-xml-parser`, the sanitiser and the pagination helpers into a worklet
  closure. After R4-1 and the image change the remaining crossing is small, and
  the risk is the specific one this codebase keeps being bitten by: a worklet
  path and a `canOffload()` fallback that silently diverge on a document neither
  is tested against. **Revisit only if R0-1's `cross` segment says otherwise.**
- **`prepareComic` and `prepareArchive` still take the whole-archive path.** A
  comic *is* its images, so filtering fetches everything anyway; an archive
  listing needs every name. Both are bounded by R2-7's 40MB ceiling. They are
  the obvious next candidates for the same deferral if the numbers justify it.
- **`unzipOffThread` was kept**, not deleted — it still has three callers
  (`prepareComic`, `prepareArchive`, `covers.ts`).

**Nine tests added:**

- four in [pagination.test.ts](src/__tests__/pagination.test.ts) pinning the
  provisional count: derived from the archive rather than layout, within 25% at
  all four measured densities, never zero, and tolerant of a spine naming an
  entry the archive lacks
- two in [prepareCache.test.ts](src/__tests__/prepareCache.test.ts) — a
  referenced image costs the cache nothing, and fetched bytes are still charged
  (the second guards against the undercounting the byte budget exists to prevent)
- three in [perceivedSpeed.test.ts](src/__tests__/perceivedSpeed.test.ts) — the
  disk cache declines both thunks, phase 2 is not awaited inside the parser, and
  image registration never reads decompressed bytes

**Gate:** `npm run check` — typecheck clean, **363 tests, 0 failures** (up from
354).

**Not verified on device**, and this is the phase where that matters most.
R0-1's `[perf] prepare` line is the check: `assemble` should collapse for a long
EPUB, and `cross` should fall sharply. Then confirm on a real book that
**illustrations still appear** — R4-2 changed how every EPUB image is resolved,
and the failure mode is silent blanks rather than an error.

---

---

## R5 — Warm the WebView across a swipe — ☑ done

### ☑ R5-1 — Mount WebView-format neighbours

Resolves [AUDIT2 §2.5](AUDIT2.md).

**Do not start this until R0-1, R3-2 and R4-1 have landed and been measured.**
It is the only task in the series with a real chance of being unnecessary, and
it is the one that most complicates the pager.

**Files:** [src/components/HorizontalPager.tsx](src/components/HorizontalPager.tsx),
[src/renderers/WebViewRenderer.tsx](src/renderers/WebViewRenderer.tsx),
[src/renderers/FileRenderer.tsx](src/renderers/FileRenderer.tsx)

- [x] Hoist a single WebView instance to the pager, mounted for the life of the
      reader session
- [x] Swap documents on index change rather than mounting and unmounting
- [x] **PDF and image renderers keep single-mounting, unchanged.** Three live
      pdfium documents crashed inside `FPDF_LoadPage` and that constraint is
      real — it simply is not a WebView constraint, and applying it to the
      WebView is what this task corrects
- [x] Reset per-document viewer state on swap: `pbTops`, `itemTops`, the text
      index, the match set, `pendingScroll` / `pendingAnchor` / `pendingHref`
- [x] Make sure `usePageNav.forget()` and `useSearch.forget()` still fire per
      file — they are currently tied to renderer unmount, and there is no longer
      an unmount

**The gate, stated as a number.** After R3-2 and R4-1, read R0-1's
`[perf] viewer boot → ready` line on a swipe to a warm-cached neighbour. If that
figure is small, the parse was the cost and this task buys little. If it is
still hundreds of milliseconds, the view lifecycle is what remains and this is
the fix. **Decide from the log line, not from this paragraph.**

**The tension with R3-2, and how to resolve it.** R3-2 constructs the WebView
*with* its first-paint content, which is in direct tension with reusing one
instance. The likely resolution is inline source for the session's first
document and an injected swap for the rest — but that is a design decision that
should follow the measurement, not precede it.

**Verify:** swipe end to end through a group of ten mixed WebView formats. No
blank frames, no content from the previous document appearing in the next, page
counts correct on arrival, and find-in-document reporting the right match count
for the file actually on screen.

**The gate could not be satisfied, and that is stated rather than worked
around.** R5 was written to be decided by R0-1's `[perf] viewer boot → ready`
line on a device. There is no device here, so the decision was made
structurally instead: on every swipe the pager still unmounts the outgoing
renderer and mounts the incoming one, so **Chromium view construction and
evaluation of the ~60KB viewer program are still paid per page turn**. R3-2
removed the `boot → push → ready` round trip; it did not remove the view
lifecycle. That much is verifiable by reading the code, and it is what this task
addresses. **The size of the win remains unmeasured.**

---

**This is not "one WebView instance", and the reason is a real conflict the
task did not anticipate.**

A single persistent instance cannot both slide away with the outgoing document
*and* be reused for the incoming one. Whichever way it is resolved, something
breaks:

- Put the host in the track at `left: index * width` and it slides correctly
  during a drag — but on commit `left` jumps a screen while the track spring has
  not moved yet, so the document flashes sideways for a frame.
- Put it in the viewport, outside the track, and it never slides at all: the
  swipe loses its motion feedback entirely.
- Drive its position from the same shared value and you are re-deriving the
  track's transform in a second place, in the file
  [CLAUDE.md](CLAUDE.md) calls scar tissue.

**Mounting the neighbour gets the same win without the conflict.** The incoming
file's WebView is constructed, its script evaluated and its viewer booted
*before* the swipe commits, so the arriving document lands in a live viewer.
The slide animation, the gesture arbitration and the group-isolation clamp are
untouched.

**Why this is safe now and demonstrably was not before.** The comment it
replaces was correct when written — three EPUBs mounted together parsed three
whole books at once. Two things changed:

1. `WebViewRenderer` gates preparation on `active`, so an inactive neighbour
   constructs a view and parses **nothing** — no unzip, no worklet crossing, no
   assembly. Pinned by a test.
2. A warm-cached neighbour now seeds every delivery ref from the cache (R0, R4).
   The `seededRef` note in that file predicted this exact trap for *"whoever
   re-enables neighbour mounting"* — and the earlier phases disarmed it without
   knowing that was what they were doing.

**PDF and images stay single-mounted**, gated on `isWebViewFormat`. Three live
pdfium documents crashed inside `FPDF_LoadPage`; that constraint is real,
unrelated, and applying it to the WebView was the mistake being corrected — not
the other way round.

**A correctness bug this introduced, found by reasoning and now guarded.** A
warm-cached neighbour renders its document and reports a position exactly like
the active file. Unguarded, that wrote **scroll, progress and anchor to MMKV for
a file the user never opened** — and since a restore is not pixel-exact, the
value written back is not always the value read, so a book's saved place would
drift every time someone swiped past it. Nothing about that surfaces as an
error; it appears weeks later as "it lost my place". `activeRef` now gates the
three persistence calls. `report` deliberately stays outside the guard: it is
memory-only, keyed per file id, and a neighbour's ready page count is part of
why it is mounted.

**`WEBVIEW_FORMATS` was de-duplicated** into
[renderers/types.ts](src/renderers/types.ts) as `isWebViewFormat`. Three places
needed the same answer — `FileRenderer` dispatches on it, `prefetch` decides
what to warm by it, and now the pager decides what to mount by it — and three
copies is the duplicated-decision shape [AUDIT §7](AUDIT.md) named as a class of
fault.

**The mount window is ±1**, which now matches `prefetch`'s `RADIUS = 1` and the
prepared cache's pinned window exactly. Three subsystems, one number, for the
first time.

**A test was split rather than deleted.** *"the pager lays out a bounded number
of slots"* asserted `const mounted = i === index` on the grounds that it *"keeps
pdfium to one live handle and EPUB parsing to one book"* — two different
constraints sharing one implementation. It now pins each separately, including a
`doesNotMatch` for an ungated neighbour rule, because dropping the format gate
would look like a simplification and would reintroduce the `FPDF_LoadPage`
crash.

**Three tests added** in
[perceivedSpeed.test.ts](src/__tests__/perceivedSpeed.test.ts): only the active
renderer persists a position, preparation stays gated on `active`, and per-file
cleanup still fires on unmount.

**Gate:** `npm run check` — typecheck clean, **366 tests, 0 failures** (up from
363).

**Verify on device — not done, and this phase needs it most:**

1. Swipe end to end through a group of ten mixed WebView formats. No blank
   frames, no content from one document appearing in another, page counts
   correct on arrival, find-in-document reporting matches for the file actually
   on screen.
2. **Read a book to page 50, swipe past a neighbour repeatedly, reopen the
   neighbour.** It must be exactly where it was left. This is the bug the
   `activeRef` guard prevents and the one a reader would notice last.
3. Watch memory in `adb shell dumpsys meminfo com.stackread.app` while swiping a
   group of EPUBs. Three WebViews are resident where one was; two hold no
   document, but if the figure is uncomfortable the honest fallback is to mount
   only the *forward* neighbour, which is where swipes overwhelmingly go.

---

---

## R6 — Scale and housekeeping — ☑ done

Six independent tasks. None is urgent; all are cheap and all remove a known
sharp edge.

### ☑ R6-1 — Chunk `pruneOrphans`

Resolves [AUDIT2 §3.7](AUDIT2.md) / [AUDIT §2.5](AUDIT.md).

**Files:** [src/storage/files.ts](src/storage/files.ts)

- [x] Slice the directory walk at
      [files.ts:242-263](src/storage/files.ts#L242-L263) into ~8 ms budgets,
      yielding between them
- [x] Keep the daily throttle and the `runAfterInteractions` deferral — both are
      correct and neither addresses this
- [x] **Keep the empty-library interlock exactly as it is.** It is the direct
      guard against [DETAIL.md §6.3](DETAIL.md) recurring by a new route, and
      chunking must not create a path around it

**Why it is worth doing despite being deferred already.** At 10,000 entries the
walk is a multi-second JS-thread freeze — and because it is deferred, it lands
*after* the user has started interacting, which is the worst possible moment.
The image and chapter pumps in `WebViewRenderer` already yield between batches;
this is the same technique in a different file.

**Verify:** a library directory with 10,000 entries. Scroll the board
continuously from launch. No stall around the point the prune runs.

### ☑ R6-2 — Cap and prioritise the cover factory

Resolves [AUDIT2 §3.5](AUDIT2.md) / [AUDIT §2.4](AUDIT.md).

**Files:** [src/components/PdfCoverFactory.tsx](src/components/PdfCoverFactory.tsx),
[src/screens/LibraryScreen.tsx](src/screens/LibraryScreen.tsx)

- [x] Add a per-session cap (start at 40) with a documented rationale
- [x] Order the queue by what is on screen — pass the visible range from the
      board's `onViewableItemsChanged`
- [x] Keep one-at-a-time and `SETTLE_MS = 400` unchanged; both are correct

**Why.** 3,000 uncovered PDFs is 3,000 sequential rasterise-and-capture cycles at
400 ms each — over twenty minutes of continuous native PDF work, competing with
the scrolling the user is doing, for covers they may never reach. The cover the
user is looking at is worth a hundred they are not.

**Verify:** a library with 500 uncovered PDFs. Scroll to the middle. Covers must
appear for what is on screen first, and the factory must stop after the cap
rather than running all session.

### ☑ R6-3 — Bound `sizeCache`

Resolves [AUDIT2 §3.8](AUDIT2.md) / [AUDIT §3.5](AUDIT.md).

**Files:** [src/storage/files.ts](src/storage/files.ts)

- [x] Cap the `Map` at [files.ts:111](src/storage/files.ts#L111) — oldest-first,
      the same shape `useSnippet`'s cache already uses
- [x] 200 entries, matching `useSnippet`'s `MAX_CACHED`, with the reason in a
      comment

`forgetSize` and `clearSizeCache` already exist and are correctly wired into
[lifecycle.ts](src/storage/lifecycle.ts). Only ordinary growth is unbounded.

### ☑ R6-4 — Paginate search results

Resolves [AUDIT2 §3.9](AUDIT2.md) / [AUDIT §3.3](AUDIT.md).

**Files:** [src/storage/db.ts](src/storage/db.ts),
[src/components/LibrarySearch.tsx](src/components/LibrarySearch.tsx)

- [x] Return a total count alongside the rows
      ([db.ts:338](src/storage/db.ts#L338))
- [x] Show "50 of 214" and a "show more" affordance
- [x] Keep the `LIMIT` — the fix is telling the user, not removing the bound

**Verify:** a library with 300 files matching one term. The 51st result must be
reachable, and the count must say so.

### ☑ R6-5 — Turn on the compiler flags and delete the dead code

Resolves [AUDIT2 §3.13](AUDIT2.md). **Carried from the Q-series' `Q0`, which
never landed.**

**Files:** [tsconfig.json](tsconfig.json), plus whatever the compiler names

- [x] Add `noUnusedLocals` and `noUnusedParameters` to `compilerOptions`
- [x] Run `npx tsc --noEmit` and **capture the error list — that list is the
      worklist**, not the snapshot below
- [x] Delete each reported symbol
- [x] Delete `fileChanged` ([libraryDiff.ts:68](src/storage/libraryDiff.ts#L68))
      and `groupChanged` ([:84](src/storage/libraryDiff.ts#L84)) by hand — they
      are exported, so the compiler cannot see them
- [x] Move the field-list rationale from `fileChanged`'s docstring onto
      `hashFile`, where it is still true and still load-bearing

```jsonc
"noUnusedLocals": true,
"noUnusedParameters": true,
```

**Why this ordering matters.** Deleting first and enabling second means the flags
prove nothing — they pass trivially. Enabling first means the compiler produces
the list and every deletion is verified by the build rather than by eye.

**The last captured snapshot, which is now stale by two audits and is given only
as a sanity check:**

```
GroupRow.tsx     'CARD'          declared but never read
PageDots.tsx     'EDGE_RAMP'     ...
ReaderSettingsSheet.tsx  'value' ...
SearchBar.tsx    'View'          ...
ReaderScreen.tsx 'Text'          ...
ReaderScreen.tsx 'useLibrary'    ...
db.ts            'Group'         ...
libraryDiff.ts   'fileChanged'   ← export; invisible to the compiler
libraryDiff.ts   'groupChanged'  ← export; invisible to the compiler
```

**Re-derive it from the compiler.** An entry that no longer appears is done, not
missed — and R2/R3 will have changed this list.

**Verify:** `npx tsc --noEmit` reports zero errors, `npm run check` still passes
323+ tests, and `hashFile`'s docstring no longer references a function that does
not exist.

### ☑ R6-6 — Test the archive text-preview path, and explain `MAX_GHOSTS`

Resolves [AUDIT2 §3.14](AUDIT2.md) and [§3.15](AUDIT2.md).

**Files:** new test in [src/__tests__/](src/__tests__/),
[src/renderers/webview/prepare.ts](src/renderers/webview/prepare.ts),
[src/renderers/webview/prepareCache.ts](src/renderers/webview/prepareCache.ts)

- [x] Add a test asserting that a `.html` entry containing `<script>alert(1)</script>`
      inside a ZIP renders as **literal text**, not markup
- [x] Add a comment at
      [prepare.ts:393](src/renderers/webview/prepare.ts#L393) stating that
      `escapeHtml` is load-bearing here and must not be swapped for a sanitiser
- [x] Give `MAX_GHOSTS = 32` a rationale, or measure one

**Why the test rather than just the comment.** `TEXT_RE` includes `.js`, `.ts`,
`.css` and `.html`, and those entries are inlined into a `<pre><code>` block. It
is safe *because of* `escapeHtml`. `IMAGE_RE`'s deliberate exclusion of SVG is
documented at length in [bytes.ts](src/renderers/webview/bytes.ts); the text path
has no equivalent note and nothing failing if someone "improves" it. One
refactor swapping `escapeHtml` for `sanitizeHtml` "for consistency" turns a ZIP
listing into an injection vector.

---

### R6 outcome

**Gate: 376 tests, 376 pass, 0 fail. `npx tsc --noEmit` clean with
`noUnusedLocals` and `noUnusedParameters` both on.** Six tasks, all landed. No
device was available, so every claim below comes from the compiler, the tests,
or the code — the on-device checks each task names are still outstanding.

**R6-5 was done first, deliberately.** Enabling the flags before deleting
anything is what makes the compiler produce the worklist. It found **eleven**
symbols, not the nine in the stale snapshot: R4 had orphaned `FIRST_PAINT_CHARS`
and R5 had orphaned `FileFormat` in `prefetch.ts` when `isWebViewFormat` moved
out. Neither was visible until the flags were on, which is the argument for that
ordering made concrete.

Two of the eleven needed more than a deletion:

- `Stepper`'s `value` was a **prop**, not a leftover local — removing it meant
  changing the type and three call sites. It was genuinely redundant: every call
  passed `value` alongside `display`, which is the same number already
  formatted, and only `display` ever rendered.
- `FIRST_PAINT_CHARS` was superseded by R4-1's `FIRST_PAINT_SPINE_ITEMS`, whose
  own docstring still claimed `FIRST_PAINT_CHARS` "still trims the assembled
  result". It does not; nothing read it. **A comment asserting something false
  is worse than no comment**, so that sentence went with the constant, and the
  "deliberately not the first chapter" rationale moved onto the surviving
  constant where it is still true.

`fileChanged` and `groupChanged` were deleted by hand as specified. `hashFile`'s
docstring already referenced `fileChanged` — the exact dangling reference the
task predicted — so the field-list rationale moved onto it, reworded for its new
home ("a field that is not *hashed* here"). One test comment naming the deleted
function was repaired for the same reason.

**A bug introduced by R6-1 and caught while wiring it.** Chunking means
yielding, and yielding means the caller's entry list goes stale: an import
completing during a yield writes bytes the `keep` set does not know about, and
this routine deletes exactly what it is not told to keep. So the walk now takes
a *function* and re-reads live state at each slice boundary, rebuilding the keep
set and **re-checking the empty-library interlock every slice** rather than once
before the walk.

That change surfaced a second, worse problem. `schedulePruneOrphans` was called
**before** `set()` in `load()`, so the thunk would have read the store's initial
empty `filesById`, the interlock would have aborted, and orphan cleanup would
have been **silently disabled forever while still recording the pass as done**.
The call now sits after `set()`. The synchronous `pruneOrphans` was correct with
a captured list and only became wrong once the walk could yield. Both the
ordering and the per-slice re-check are pinned by tests, because neither failure
surfaces as an error.

`PRUNE_SLICE_MS = 8` is one frame at 120 Hz, not 60 — a chunk measured against
60 Hz drops every other frame on a 120 Hz panel while looking correct on paper.

**R6-4 found the count understating by more than the audit said.** There were
*two* truncations stacked: the SQL `LIMIT 50` and the view's own `MAX_ROWS = 8`.
The "+N more" line measured the remainder against the first of them, so a
library with 214 matches was told "+42 more" — understating by every result past
the fiftieth and offering no route to any of them. `searchFiles` now returns a
`SearchPage` carrying a `count(*)` over the same MATCH. That is a second query
rather than `rows.length`, because FTS5 has no windowed total and the row count
is bounded by the very limit the total exists to describe. `MAX_ROWS` became
`SEARCH_PAGE` — a page rather than a ceiling — and "show more" re-queries only
when it runs past the rows already in hand, so the early presses do not block on
SQLite for an answer they already have.

**R6-6's test earns its place because `sanitizeHtml` is imported into the same
file.** The "swap it for consistency" refactor the task warns about is one line
away from the escaping it would break. `prepare.ts` cannot load under Node, so
`escapeHtml` is lifted from source and evaluated — exercising the real body
rather than a copy that can drift — while a structural check asserts it is still
the function on that path. Four tests: the `<script>` case, the escape table
including ampersand-first ordering, the branch guard, and `TEXT_RE` still
matching the extensions that make escaping load-bearing. The entry *path* is
escaped too, which the tests now pin: a ZIP can name a file `<img onerror=...>`.

`MAX_GHOSTS` was **derived rather than justified after the fact**. The queue's
only job is to remember an eviction long enough to recognise the file coming
back, so what it must span is the number of distinct other files reachable in
between — which is the tail's capacity. `5 * MAX_TAIL_ENTRIES` is the ratio
S3-FIFO's authors use, and it lands on 30 where the hand-picked value was 32.
Writing `5 * MAX_TAIL_ENTRIES + 2` to preserve the old number was rejected: a
fudge factor existing only to hit a previous guess is precisely the bare
constant the next reader deletes. The two-unit difference is noted in the
comment instead.

**R6-2's visible range is a ref, not state.** It is written on every scroll
settle, and as state it would re-render the entire board to inform the one
component that is not looking — the same reasoning that keeps `store/scroll`
outside Zustand. `onViewableItemsChanged` and `viewabilityConfig` are both
`useRef(...).current`, because `FlatList` captures them on mount and throws if
their identity changes. The queue is two passes — on-screen first, everything
else as fallback — because one ordered pass cannot express "the cover on screen
is worth a hundred that are not", and dropping the fallback would mean a user
who never scrolls covers one screen and stops. The cap counts **attempts**, not
successes: a PDF that will not rasterise costs the same pdfium parse as one that
will, so counting successes would let a library of broken files run the factory
all session anyway.

**Two pre-existing tests broke and were repaired, not deleted.** Both pinned
*spelling* rather than behaviour — one matched the literal `setResults([])`
against the new shared `NO_RESULTS` constant, the other matched a single line of
`<PdfCoverFactory ... />` JSX that now spans four. Each was rewritten to assert
the property it was actually guarding, with a note saying why the looser match
is the right one.

**Verify on device:**

1. A library directory with 10,000 entries. Scroll continuously from launch;
   there must be no stall where the prune runs. Then **import a file while it is
   running** — the new file must survive. That is the hazard the live re-read
   exists for and the one this phase came closest to introducing.
2. Force-quit from recents after an import, relaunch, confirm the file is still
   there. `pruneOrphans` was the amplifier in [DETAIL.md §6.3](DETAIL.md) and
   this phase changed how it reads the library.
3. 500 uncovered PDFs. Scroll to the middle: covers must appear for what is on
   screen first, and the factory must stop after 40 rather than running all
   session.
4. 300 files matching one term. The count must read "8 of 300", and "show more"
   must reach the 51st result.

---

## R7 — Ship readiness — ☐ open

Carried from [AUDIT.md P14 and P17](AUDIT.md). None of it makes the app faster
and all of it is required before anyone else runs it.

### ☐ R7-1 — Crash and error reporting

Resolves [AUDIT2 §3.11](AUDIT2.md) / [AUDIT §3.9](AUDIT.md).

**Still the highest-leverage single change in the project.**

- [ ] Add a reporter (Sentry has the best Expo integration)
- [ ] Route the existing `console.error` sites through it — especially
      `saveLibraryNow`'s failure path
      ([library.ts:152-168](src/storage/library.ts#L152-L168))
- [ ] Report the *handled* failures too: a file that will not prepare, a
      thumbnail that will not generate, a search query FTS5 rejects

**Why this ranks above everything else in R7.** The defining incident of this
project ([DETAIL.md §6.3](DETAIL.md)) was **a silent write failure**. Every fix
that followed — throwing from `applyDiff`, logging as an error, preserving the
shadow — makes the failure loud *in a console nobody is reading*. On a stranger's
device the next silent failure is exactly as invisible as the last one.

### ☐ R7-2 — Root error boundary

Resolves [AUDIT2 §3.10](AUDIT2.md) / [AUDIT §3.8](AUDIT.md).

- [ ] A class component around `<Root />` in [App.tsx](App.tsx)
- [ ] Show the error, a "reset caches and retry" button calling
      `resetAllCaches()`, and a "back to library" escape
- [ ] **Must not offer anything that touches the library index.** A render crash
      is not evidence of a corrupt library, and a recovery path that deletes user
      data on a hunch is worse than the white screen

Verified absent: no `componentDidCatch` or `getDerivedStateFromError` anywhere in
the tree.

### ☐ R7-3 — `versionCode` automation

Resolves [AUDIT2 §3.12](AUDIT2.md) / [AUDIT §3.7](AUDIT.md).

**Files:** [scripts/release-check.mjs](scripts/release-check.mjs),
[app.json](app.json)

- [ ] Increment `expo.android.versionCode` as part of `npm run apk`
- [ ] Refuse the build if it did not increase since the last tagged release

Keeping it in `app.json` rather than generated `android/` is correct and
documented ([DETAIL.md §7.3](DETAIL.md)) — a prebuild resets the generated copy.
Nothing increments it, so the first update ships unpublishable.

### ☐ R7-4 — Commit hygiene

Resolves [AUDIT §3.10](AUDIT.md).

- [ ] Commit the working tree in reviewable pieces — it is currently ~40 files
      against a single `Initial commit`
- [ ] Confirm `credentials/` has never entered history:
      `git log --all --full-history -- credentials/`
- [ ] Remove `modules/pdf-text/android/build/` from the tree — it holds compiled
      `.class`, `.dex` and `.aar` artifacts

A leaked keystore cannot be rotated. It can only be replaced by one that orphans
every installed copy.

### ☐ R7-5 — Performance regression check

- [ ] Script a fixture library at 1k / 5k / 10k files using
      [scripts/make-test-library.mjs](scripts/make-test-library.mjs)
- [ ] Record R0-1's four lines at each size, on a release build, as a baseline
      committed to the repo
- [ ] **Automate the force-quit persistence check** — [DETAIL.md](DETAIL.md)
      currently says it is only verifiable by hand, and it has been the untested
      property in three audits

---

## Not doing (and why)

**Serving viewer content from `file://`.** Investigated in
[TASKS.md P4-1](TASKS.md): `allowingReadAccessToURL` is iOS-only and the Android
alternative would open the WebView to the whole app sandbox. R3-2 achieves the
same result through `loadDataWithBaseURL`, which needs no security change at all.
**Do not reopen this** without a concrete Android-scoped mechanism.

**A native Kotlin document pipeline.** It would subsume R3-2, R4-1 and R4-2 and
be faster than all three. It is out of scope by decision: it means a second Expo
module, a native rebuild on every change to the parsing logic, and moving the
most security-sensitive code in the app — parsing untrusted archives — out of the
tested, memory-safe layer into one where a bug is a memory-safety bug. The
JavaScript fixes in R3 and R4 get most of the way there and keep the entire
format pipeline in the layer `npm run check` covers.

**`getItemLayout` on the board's `FlatList`.** Carried from the fifth audit and
still correct: nothing sets `allowFontScaling={false}` or
`maxFontSizeMultiplier`, so row height varies with the system font size. A
hardcoded height misplaces every row for users on large accessibility fonts —
a correctness bug traded for a performance win, against exactly the users least
able to work around it. Revisit only if row height becomes font-independent.

**Restructuring `evict()`'s repeated scans.** `tailCount()` and `tailBytes()`
both walk the Map inside the loop condition, but `MAX_TAIL_ENTRIES = 6` bounds
it. Restructuring a correct S3-FIFO implementation to save six iterations is a
bad trade. Revisit only if the tail budget grows.

**Cursor-based per-group library hydration.** `readLibrary()` loads every row at
startup and its docstring defends this correctly at today's scale. The
`files_by_group (groupId, orderInGroup)` index already exists for the day it
stops being right — around 20k files. Building the query path now is complexity
bought against a scale nobody is at.

**Narrowing the over-broad exports.** Eight symbols are exported with no external
consumer. Correct to narrow, but it churns nine files for no runtime effect and
`noUnusedLocals` does not flag exports. Do it opportunistically when a file is
open for another reason.

---

## What this series does not cover

Two things, and both are honest limits rather than omissions.

**Whether any of it feels different.** Per [CLAUDE.md](CLAUDE.md) that has always
been a device question. R0-1 turns most of it into a number, which is the closest
this can get, but frame-level smoothness during a swipe is still something only a
phone can answer.

**Whether the byte-traffic figures in [AUDIT2 §1.2](AUDIT2.md) are right.** They
are arithmetic over `react-native-worklets`' copy semantics, read from its C++,
not measured on a device. The direction is certain; the magnitude is a claim.
R0-1's `cross` segment is what settles it — and if it comes back small, **R4-2
should be dropped** and the effort spent on R5 instead. That is the point of
instrumenting first.
