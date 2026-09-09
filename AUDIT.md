# StackRead for Android — engineering audit

A read of 14,475 lines of [src/](src/) plus 4,370 lines of tests, `App.tsx`, the
build scripts and the project record. Verified against a clean `npm run check` —
typecheck plus **258 passing tests, 0 failures**.

Audited at commit `334c437`, branch `master`, with the working tree as read.
Line references point at that tree. Every finding below was traced through the
code rather than inferred from the documentation.

This is the **fourth** audit of this project. The three before it found,
in order, **structural** faults (work registered in the wrong scope), **frequency**
faults (cheap operations on a hot path), and **lifetime** faults (nothing owning
when a `file.id` stops being valid). All of P6–P11 from the previous round have
landed and are correct as written; that audit's findings are now history and are
not repeated here.

Companion documents: [DETAIL.md](DETAIL.md) for the project record,
[README.md](README.md) for usage and build, [CLAUDE.md](CLAUDE.md) for the rules
that cost real debugging time.

---

## Verdict

**78 / 100.** The architecture is genuinely good and the documentation is the
best I have read in a project this size. What holds the score down is not the
design — it is the distance between how carefully the code is *reasoned* and how
ready it is for a stranger's device.

| Dimension | Score | Notes |
|---|---|---|
| Architecture & design | 90 | State split by update frequency, the single WebView host, the format pipeline |
| Code quality & documentation | 95 | Comments explain *why*, and record the failure that motivated each fix |
| Correctness of core paths | 80 | Persistence, gestures and pagination are carefully reasoned and tested |
| Security posture | 88 | Inert WebView, blocked permissions, `allowBackup=false`, CDN-sourced SheetJS |
| Testing | 65 | 258 tests, pure logic only. No integration, no device, no E2E |
| Scalability | 55 | Several O(n)-per-mutation paths; restore is unshippable at scale |
| Production readiness | 45 | No crash reporting, no error boundary, `versionCode` 1, one commit |
| Performance engineering | 82 | Worklet lanes and streaming are sophisticated; some hot paths regressed |

### The class of fault this audit found

Each previous audit named a class. This one has a name too, and it is the most
uncomfortable of the four because the project has **already diagnosed it once**:

> **A good fix applied to one path and not to its twin.**
>
> Export streams; **restore does not** (§1.1). `GroupRow` windows its cards;
> **the pager does not** (§2.1). `prepare` offloads its unzip to a worklet;
> **restore's unzip runs on the JS thread** (§1.1). The store was normalized to
> kill O(groups × files) per mutation; **`usePdfsNeedingCovers` reintroduced it
> one file over** (§2.2).

[DETAIL.md §6.12](DETAIL.md) records exactly this failure mode — a
stack-overflow fix applied to one copy of `toBase64` and not the other — and
concludes *"duplicated logic means a bug fix is only ever half applied."* The
response then was to merge the duplicates into `bytes.ts`, which was right. The
lesson did not generalise: these four pairs are not duplicated *code*, they are
duplicated *decisions*, and nothing makes a decision propagate to its sibling.

The durable fix is structural, and it is the same shape as the `bytes.ts` one:
**make the sibling paths share an implementation rather than match each other.**
Export and restore should call one streaming-zip helper. The pager and
`GroupRow` should call one windowing primitive.

---

## 1. Critical

Both findings in this section are on the **restore** path, and they compound.
Restore is the last line of defence for a user's library; it is currently the
most dangerous code in the app.

### 1.1 `importLibraryArchive` loads the entire backup into memory

**Severity: OOM kill on the data-recovery path. A library that exports
successfully cannot necessarily be restored on the device that made it.**

[backup.ts:196](src/storage/backup.ts#L196):

```ts
const unzipped = unzipSync(await archive.bytes())
```

Export was deliberately rewritten to stream, and the comment above it
([backup.ts:18-31](src/storage/backup.ts#L18-L31)) celebrates removing the
400 MB cap that the in-memory version needed:

> `exportLibrary` now streams: one file is read, pushed through the zip, and
> written out before the next is touched, so peak memory is roughly the largest
> single file rather than the whole library.

**Restore never got the same treatment.** At peak it holds the compressed
archive bytes, the fully decompressed `Record<string, Uint8Array>` of *every*
entry, and each `target.write()` on top. Peak memory is therefore
`archive + decompressed library`, which for a stored-not-deflated archive of
PDFs is roughly **twice the library size**.

Two aggravating details:

- The cap was removed on the export side because streaming made it unnecessary.
  Nothing re-imposed one on the import side, so there is now **no ceiling at all**
  on either path — but only one of them can survive without one.
- This is the only `unzipSync` in the app still on the JS thread.
  [prepare.ts](src/renderers/webview/prepare.ts) and
  [epub.ts](src/renderers/webview/epub.ts) both route through
  `unzipOffThread` ([offload.ts:120](src/renderers/webview/offload.ts#L120)), so
  restore blocks every touch handler for the duration on top of the memory cost.

**Fix.** fflate's streaming `Unzip` class, entry by entry, on the `prefetch`
worklet lane — the mirror image of what `exportLibrary` already does with `Zip`.
Ideally both directions end up behind one helper, per the class-of-fault note
above.

### 1.2 Restore deletes the library before writing, with no rollback

**Severity: total library loss if the process dies mid-restore.**

[backup.ts:212-214](src/storage/backup.ts#L212-L214):

```ts
// Clear the existing library only once the archive has proven readable.
if (LIBRARY_DIR.exists) LIBRARY_DIR.delete()
new Directory(LIBRARY_DIR.uri).create({ intermediates: true })
```

The comment states the guard that exists — the index parsed — but that guard
proves only that `library.json` is well-formed. It does **not** prove the file
writes that follow will complete. Combined with §1.1, the likely failure is an
OOM kill *after* the delete and *partway* through the writes, leaving:

- the old library directory gone,
- the new one partially populated,
- and the SQLite index still describing the old library, because
  `replaceLibrary` runs last ([backup.ts:249](src/storage/backup.ts#L249)).

The next launch then has an index full of rows whose bytes do not exist. Note
that `pruneOrphans` cannot save this and is not meant to — it removes bytes with
no row, not rows with no bytes.

There is a real asymmetry here worth stating plainly: the project has been
careful about exactly this class of risk elsewhere. `saveLibraryNow` leaves its
shadow untouched on failure so the write retries
([library.ts:152-168](src/storage/library.ts#L152-L168)); `schedulePruneOrphans`
refuses to run on an empty library ([files.ts:219](src/storage/files.ts#L219)).
Restore is the one destructive path with no equivalent interlock.

**Fix.** Unpack to a sibling directory, then swap — or write the new files
alongside the old and prune by manifest only after `replaceLibrary` commits.
Either makes the operation atomic at the granularity the user cares about.

### 1.3 The empty-case fallback in `useGroupFiles` is one paren from a render loop

**Severity: latent. Currently correct, but it is the exact trap this project has
hit twice.**

[selectors.ts:43](src/store/selectors.ts#L43) and
[selectors.ts:67](src/store/selectors.ts#L67):

```ts
const ids = useLibrary((s) => s.groupOrder[groupId]) ?? EMPTY_IDS
```

This is safe **because the `??` is outside the selector**. Move it one paren
left — `useLibrary((s) => s.groupOrder[groupId] ?? EMPTY_IDS)` — and it is still
safe, because `EMPTY_IDS` is a shared constant. Write the more natural
`?? []` inside and you have precisely
[DETAIL.md §6.10](DETAIL.md): *"The result of getSnapshot should be cached"*
followed by *"Maximum update depth exceeded"*.

Two things make this worth listing rather than leaving alone:

- **The file's own docstring describes it inaccurately.** It says *"The
  membership array is selected raw — no allocation in the selector"*, which is
  true, but reads as though the safety comes from the selector's shape. It comes
  from `EMPTY_IDS` being module-level. A reader who internalises the stated
  reason and then writes `?? []` has followed the documentation into the bug.
- **The fallback is nearly dead.** The store guarantees an entry for every group
  ([library.ts:123-125](src/store/library.ts#L125)) — *"Every group gets an
  entry, including empty ones, so a row's selector never has to distinguish 'no
  such group' from 'group with no files'"*. So the `??` fires only for a
  `groupId` that is not a group at all.

**Fix.** Make it structurally impossible rather than conventionally correct: a
`selectGroupIds(groupId)` helper in `selectors.ts` that owns the fallback, so no
call site ever writes the `??` itself. That is the same move `EMPTY_TOC` made in
`ReaderScreen`, applied one level up.

---

## 2. High

### 2.1 The pager renders a View per file in the group

[HorizontalPager.tsx:223-252](src/components/HorizontalPager.tsx#L223-L252):

```ts
<Animated.View style={[styles.track, { width: width * count }, track]}>
  {files.map((file, i) => {
    const mounted = i === index
    ...
```

The *renderer* is correctly mounted only for the active file, and the comment
explaining why is one of the best in the codebase — three pdfium documents
crashing inside `FPDF_LoadPage` is exactly the reasoning that should be
preserved. But the **track** is `width * count` and there is a `<View>` per file
regardless of `mounted`. A 400-file group creates 400 native views and a track
400 screens wide.

This is the twin of a problem `GroupRow` already solved. It windows its cards at
`INITIAL_WINDOW = 30` with a "show more" tile
([GroupRow.tsx:38](src/components/GroupRow.tsx#L38)), and its comment names the
reason precisely:

> The docstring above says groups hold "tens of files, not thousands", and that
> is a product assumption nothing enforces: a row with 400 files mounts 400 card
> trees.

The same assumption is unenforced one component over.

**Fix.** Render `index - 1 … index + 1` with a translate offset so the track
width is constant. Nothing changes visually; the pager already animates
`translateX` on the UI thread and the arithmetic that enforces group isolation
(`Math.max(0, Math.min(count - 1, next))`) is unaffected.

### 2.2 `usePdfsNeedingCovers` scans every file on every store mutation

[selectors.ts:100-112](src/store/selectors.ts#L100-L112):

```ts
return useLibrary(
  useShallow((s) => {
    const out: string[] = []
    for (const id of Object.keys(s.filesById)) {
      const file = s.filesById[id]
      if (file.format === 'pdf' && !file.thumb) out.push(id)
    }
    return out
  }),
)
```

Zustand runs **every subscriber's selector on every store update**. So each
`setThumb`, each rename keystroke, each import walks all of `filesById` and
allocates an array for `useShallow` to compare. At 5,000 files that is a 5,000-entry
scan plus an allocation per mutation — the O(n)-per-mutation shape the store
normalization exists to eliminate, reintroduced one file over.

The docstring defends *returning ids rather than entries*, and that reasoning is
correct and load-bearing (the factory's job is to call `setThumb`, so a selector
returning entries would re-drive the effect that produced them). The cost that
went unexamined is the scan itself.

`useFileCount` ([selectors.ts:84](src/store/selectors.ts#L84)) has the same shape
— `Object.keys(s.filesById).length` allocates a full key array to read a number
— though it is cheaper and returns a primitive, so it cannot loop.

**Fix.** Maintain the set incrementally in the reducers. A PDF enters the set in
`addFiles` and leaves it in `setThumb`/`removeFile`; the result only ever
shrinks, so this is O(1) per mutation with no scan at all.

### 2.3 `prefetchAround` re-fires on every library mutation

[ReaderScreen.tsx:113-115](src/screens/ReaderScreen.tsx#L113-L115):

```ts
useEffect(() => {
  prefetchAround(files, index)
}, [files, index])
```

`files` is a `useMemo` over `filesById` ([selectors.ts:47-57](src/store/selectors.ts#L47-L57)),
so **any** file's metadata changing — a thumbnail landing, a progress write —
produces a new array identity and re-triggers prefetch scheduling. The
`InteractionManager` deferral and the `busy` flag in
[prefetch.ts](src/renderers/webview/prefetch.ts) absorb most of the damage, but
the work is being rescheduled for reasons that have nothing to do with which
file is being read.

**Fix.** Depend on the neighbour ids, not the array:
`[files[index - 1]?.id, files[index]?.id, files[index + 1]?.id]`.

### 2.4 `PdfCoverFactory` has no session budget

[LibraryScreen.tsx:501](src/screens/LibraryScreen.tsx#L501) mounts it with the
full `pdfsNeedingCovers` list. One-at-a-time is correct and the reasoning is
sound — every attempt to hold several pdfium documents open has ended badly. But
nothing bounds the *queue*. Importing a 3,000-PDF library means 3,000 sequential
rasterise-and-capture cycles, each with an empirical settle delay before
`captureRef`, running whenever the board is idle. That is hours of battery for
covers the user may never scroll to.

**Fix.** A per-session cap, and order the queue by what is actually on screen
rather than by store order — the cover the user is looking at is worth a hundred
they are not.

### 2.5 `pruneOrphans` is a synchronous full-directory walk

[files.ts:242-263](src/storage/files.ts#L242-L263) enumerates the entire library
directory on the JS thread. It is correctly deferred behind
`runAfterInteractions` and throttled to once a day
([files.ts:177-234](src/storage/files.ts#L177-L234)), and the reasoning for both
is right. What neither addresses is that at 10,000 entries the walk itself is a
multi-second JS-thread freeze — and because it is deferred, it lands *after* the
user has started interacting, which is the worst moment for it.

**Fix.** Chunk it across frames with an explicit budget (~8 ms slices), the same
way the image and chapter pumps in `WebViewRenderer` already yield between
batches.

---

## 3. Medium

**3.1 Dead code with a live comment.** `fileChanged`
([libraryDiff.ts:68](src/storage/libraryDiff.ts#L68)) and `groupChanged`
([libraryDiff.ts:84](src/storage/libraryDiff.ts#L84)) have no callers — the hash
functions replaced them. But `hashFile`'s docstring still says *"exactly the
fields `fileChanged` compares, in the same order"*, and
`lifecycle.test.ts:184` references it as though it were live. This is the
situation [DETAIL.md §6.12](DETAIL.md) warns about in its own words: *"a comment
describing an abandoned approach is worse than no comment: it is an active
invitation to reintroduce the bug."* Delete both functions; move the
field-list rationale onto `hashFile` itself, where it is still true and still
load-bearing.

**3.2 Library search runs synchronously on every keystroke.**
[LibraryScreen.tsx:133-136](src/screens/LibraryScreen.tsx#L133-L136) — no
debounce. FTS5 is fast and the query construction is careful, but it is a
synchronous JSI call plus a `setState` per character typed.

**3.3 No pagination on search results.** `searchFiles` defaults to `LIMIT 50`
([db.ts:338](src/storage/db.ts#L338)) with no "more results" affordance, so on a
large library the 51st match is unreachable and the user is not told.

**3.4 The reader's file menu is rebuilt on every index change.**
[ReaderScreen.tsx:192-204](src/screens/ReaderScreen.tsx#L192-L204) maps every
file in the group, calling `fileSize(f)` — a `stat` — for entries predating the
`size` field. Memoized on `[files, index]`, so it rebuilds on every page turn.

**3.5 `sizeCache` grows without bound.** [files.ts:111](src/storage/files.ts#L111)
is a `Map` with no eviction. `forgetSize` and `clearSizeCache` exist and are
wired into `lifecycle.ts` correctly, but nothing bounds ordinary growth.

**3.6 `MAX_GHOSTS = 32` is unexplained.**
[prepareCache.ts:85](src/renderers/webview/prepareCache.ts#L85) — FIFO eviction
of the ghost set is reasonable, but the constant carries no rationale. In a
codebase where [CLAUDE.md](CLAUDE.md) explicitly warns that *"a bare tuning
constant with no rationale will be 'cleaned up' by the next reader"*, this one
is exposed.

**3.7 `versionCode` is 1 with no bump automation.** [app.json:12](app.json#L12).
The decision to keep it here rather than in generated `android/` is correct and
documented ([DETAIL.md §7.3](DETAIL.md)) — a prebuild resets the generated
copy. But nothing increments it, so the first update ships unpublishable.

**3.8 No error boundary.** A render throw anywhere is a white screen with no
recovery path. Given the number of code paths that parse untrusted files, this is
a real exposure.

**3.9 No crash or error reporting.** Every failure path is `console.warn` or
`console.error`, which is invisible on a user's device. This is the sharpest
remaining gap in the whole audit: the defining incident of this project
([DETAIL.md §6.3](DETAIL.md)) was **a silent write failure**, and the fixes that
followed — throwing from `applyDiff`, logging as an error, preserving the shadow
— all make the failure loud *in a console nobody is reading*. The next silent
failure is as invisible as the last one.

**3.10 Repository hygiene.** One commit (`Initial commit`) with ~40 files
uncommitted, including `credentials/`. `.gitignore` covers it and
[DETAIL.md §7.3](DETAIL.md) explains the signing posture correctly, but the
working tree is one `git add -A` from a leak that cannot be rotated, only
replaced by a key that orphans every installed copy. Separately,
`modules/pdf-text/android/build/` holds compiled `.class`, `.dex` and `.aar`
artifacts in the source tree.

---

## 4. Scaling limits

What breaks first, as the library grows:

| Library size | What breaks |
|---|---|
| ~500 files | Cover-factory backlog; `usePdfsNeedingCovers` scan becomes visible (§2.2, §2.4) |
| ~2,000 | `pruneOrphans` freeze (§2.5); `readLibrary()` full load at startup; selector scans |
| ~5,000 | MMKV loads every key at startup — 3 keys per file, ~15,000 keys |
| ~10,000 | Whole library resident; **restore impossible** (§1.1); export marginal |
| 100+ in one group | Pager creates 100 views (§2.1) — `GroupRow` windows at 30, the pager does not |

**The architectural ceiling** is `readLibrary()`
([db.ts:277](src/storage/db.ts#L277)), which loads every row at startup into a
fully-resident normalized store. The docstring defends this well and is right at
today's scale:

> The whole library is read once at startup and held in a normalized store whose
> membership lookup is already O(1), so a `SELECT ... WHERE groupId = ?` per row
> would cross into native code to answer something the map in memory answers for
> free.

That reasoning holds until roughly 20k files. Past it, the `files_by_group
(groupId, orderInGroup)` index already exists ([db.ts:139](src/storage/db.ts#L139))
— the query path simply is not built. Cursor-based per-group hydration is the
change, and it is deliberately *not* recommended yet: it would be complexity
bought against a scale nobody is at.

---

## 5. Closing the gap with Drive

**A caveat on the target, stated as a disagreement rather than a finding.**
"On par with Google Drive" bundles two different goals:

- **Drive's polish** — instant thumbnails, sub-100 ms search, buttery scroll at
  any size, offline-first. **Achievable, and mostly the fixes above.**
- **Drive's substance** — cloud sync, multi-device, sharing, collaboration,
  server-side rendering. **A different product**, with a backend, an auth system
  and a sync engine.

StackRead is deliberately local-first with **no network path at all**, and
[DETAIL.md §4](DETAIL.md) treats that as a security property rather than a
limitation — *"File content can never reach the network."* Sync would spend it.
The recommendation is to target Drive's *feel* and not its *feature list*: the
2-D board is the thing Drive does not have, and it is the reason to use this app.

### Techniques worth adopting

- **Windowed pager** (§2.1) — constant view count regardless of group size.
- **Incremental derived sets** (§2.2) — O(1) per mutation instead of O(n).
- **Streaming zip read** (§1.1) — fflate's `Unzip`, on the prefetch lane,
  mirroring the `Zip` already used on export.
- **Frame-budgeted housekeeping** (§2.5) — ~8 ms slices for the prune and the
  cover queue, the same yielding the WebView pumps already do.
- **Viewport-priority cover queue** (§2.4) — rasterise what is on screen first.
- **ThumbHash at import** — the two-phase placeholder→cover path is already
  built and is the right technique; generating the hash at import means a card
  never shows a bare badge.
- **Recency-weighted cache eviction** — `prepareCache` already tracks bytes;
  eviction currently walks insertion order.
- **Manifest-based orphan detection** — compare against a persisted manifest
  instead of walking the directory.
- **FTS5 over document bodies, not just names** — the `pdf-text` native module
  already extracts PDF text; extending the existing index is the single largest
  genuine feature gain available.

---

## 6. Recommended order of work

Sequenced so the safety fixes land before anything structural, and each phase is
independently shippable. Numbering continues from the completed P0–P12 in
[TASKS.md](TASKS.md), where each phase below is broken into individual tasks
with their files and verification steps.

### P13 — Restore safety (highest priority)

The two critical findings are one piece of work, and until they are done the app
has a data-recovery path that can destroy the data it exists to recover.

- Stream the restore unzip, on the prefetch lane (§1.1)
- Unpack-then-swap so a mid-restore kill cannot strand the library (§1.2)
- Ideally: one shared streaming-zip helper serving both directions

Verify by force-quitting from recents mid-restore, per
[DETAIL.md §6.3](DETAIL.md).

### P14 — Make failures visible

- A crash/error reporter (§3.9) — the highest-leverage single change in this
  document
- A root error boundary with a reset-caches recovery path (§3.8)

### P15 — Hot paths

- Window the pager (§2.1)
- Incremental `pdfsNeedingCovers` (§2.2)
- Key `prefetchAround` on ids, not the array (§2.3)
- Debounce library search; paginate results (§3.2, §3.3)

### P16 — Scale and housekeeping

- Chunk `pruneOrphans` (§2.5)
- Cap and prioritise the cover factory (§2.4)
- Bound `sizeCache` (§3.5)
- Delete `fileChanged`/`groupChanged` and fix the docstring (§3.1)
- `selectGroupIds` helper so the empty case cannot be written wrong (§1.3)

### P17 — Ship readiness

- `versionCode` automation in the prebuild script (§3.7)
- Commit hygiene; confirm `credentials/` never enters history (§3.10)
- Device integration tests — specifically **automate the force-quit persistence
  check**, which [DETAIL.md](DETAIL.md) currently says is only verifiable by hand
- Performance regression CI: startup, frame drops and peak memory at 1k / 5k /
  10k files
- Accessibility pass — TalkBack, dynamic type, contrast

---

## 7. Process note

The four audits have found, in order: **structural** → **frequency** →
**lifetime** → **unpropagated fixes**. The progression is informative, and the
fourth is different in kind from the first three.

The first three classes were found by reading code and grepping for callers.
This one is invisible to both, because **every individual path is correct**.
`exportLibrary` streams and says why. `importLibraryArchive` does not stream and
says nothing about it — there is no comment to contradict, no caller to find
missing, no test to fail. `GroupRow` windows its cards and explains the
reasoning; `HorizontalPager` does not window and its comment about mounting one
renderer is entirely true. Nothing looks wrong in place. The fault only appears
when two files are held side by side and one asks *why does this one know
something the other does not?*

The durable version of the lesson, in the spirit of
[DETAIL.md §6.10](DETAIL.md) and §6.12:

> **When a fix encodes a decision rather than a line of code, matching the
> sibling path is not enough — the sibling has to share the implementation.**
> `bytes.ts` was created for exactly this reason and it worked. The four pairs in
> this audit are the same problem at the level of design decisions, where there
> is no obvious function to extract and therefore nothing forces the merge.

Mechanically checkable, at least partly: a lint rule or review checklist asking
*"is there another path in this app that does the same job, and does it now
differ?"* would have caught export/restore and `GroupRow`/pager. The
`ts-prune`/`knip` suggestion from the previous audit is still unimplemented and
would have caught §3.1.

The behavioural-test gap noted in the two previous audits **also still stands**,
and has now grown a sharper edge. The 258 tests cover pure logic well, and
`viewerHtml.test.ts` remains the most valuable file in the suite. But nothing
asserts *"a restore interrupted halfway leaves the library intact"* — and that
is precisely the property §1.2 breaks.
