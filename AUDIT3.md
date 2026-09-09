# AUDIT3 — Sanitisation surface and performance headroom

Seventh audit. Two questions, asked separately because they have different
answers: **what is not sanitised**, and **where is the remaining speed**.

Read after [AUDIT2.md](AUDIT2.md), whose R-series is complete through R6. This
does not repeat its findings; where it agrees it says so and moves on.

**Method.** Every path where bytes from a file, an archive, or the WebView
become markup, SQL, a filesystem path, or a JavaScript string was traced by
hand. Where a verdict could be tested rather than asserted, it was: the
Markdown renderer was lifted out of the viewer template and run against twelve
injection cases under Node. Findings are ranked by *reachability*, not by
category — a traversal reachable only from a file the user explicitly restores
outranks a theoretical parser bug nothing feeds.

Tree state at time of audit: **376 tests passing, typecheck clean** with
`noUnusedLocals` and `noUnusedParameters` on.

---

## 1. Summary

The HTML sanitisation is **genuinely good** and better than most apps of this
size. Two independent passes, one regex-based on the native side and one
DOM-based inside the viewer, with a documented account of why both exist and
what each catches that the other misses. The WebView is inert by configuration.
SQL is parameterised everywhere. Zip Slip is guarded on the restore path. The
Markdown renderer resists every injection case thrown at it.

The gaps are not in the markup layer. **They are in the trust boundary around
the restore file**, which is the one place the app accepts a wholly
attacker-authored data structure and does almost nothing to validate it.

| # | Finding | Severity | Reachability |
|---|---------|----------|--------------|
| 2.1 | Restored `library.json` fields are unvalidated; `storedName` becomes a path | **High** | User restores a hostile backup |
| 2.2 | `extensionOf` is unbounded; `copyIntoLibrary` trusts its caller | Medium | Latent — no current caller is unguarded |
| 2.3 | Viewer→native messages: strings unbounded, numbers unchecked for finiteness | Low | Compromised viewer only |
| 2.4 | `console.warn` logs filenames | Low | Local logcat |

Performance: the app is well-architected and most of the easy wins are already
taken. **One significant regression is live** — a 1.4 MB parser is in the
startup bundle by an import chain that defeats the `lazy()` boundary meant to
exclude it. The rest is genuine headroom rather than defects.

---

## 2. Sanitisation

### 2.1 The restore path validates shape, not contents — **High**

[backup.ts:408-416](src/storage/backup.ts#L408-L416)

```ts
const parsed = JSON.parse(indexJson) as Library
if (!Array.isArray(parsed.groups) || !Array.isArray(parsed.files)) {
  throw new Error('shape')
}
library = parsed
```

That is the **entire** validation of a file the user obtained from anywhere. The
`as Library` cast is a lie the compiler cannot check, and every field inside
those two arrays flows onward untouched.

The entry names *inside* the archive are correctly guarded
([backup.ts:333](src/storage/backup.ts#L333)):

```ts
if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return
```

**But `library.json` is not an archive entry name.** Its `storedName` fields
bypass that check entirely and reach the filesystem through `new File(LIBRARY_DIR, …)`
in **twelve** call sites — [prepare.ts:503](src/renderers/webview/prepare.ts#L503),
[epub.ts:201](src/renderers/webview/epub.ts#L201),
[useSnippet.ts:85](src/components/useSnippet.ts#L85),
[prefetch.ts:149](src/renderers/webview/prefetch.ts#L149),
[WebViewRenderer.tsx:102](src/renderers/WebViewRenderer.tsx#L102), and
`fileUri()` in three renderers — plus `pruneToManifest`'s `keep` set.

A `storedName` of `../../../databases/library.db` is a read primitive against the
app sandbox, surfaced to the user as a document. Worse, it enters `keep`, so the
prune logic reasons about a path outside the directory it is pruning.

Nothing is parameterised away here because these are **paths, not queries** —
`replaceAll` is correctly parameterised and that is exactly why the SQL layer
does not catch this.

Secondary problems in the same object, all unchecked:

- `id` — used as an MMKV key (`setScroll(file.id, …)` runs **before** the commit,
  at [backup.ts:230](src/storage/backup.ts#L230)) and as a SQLite primary key.
  A non-string id, or one colliding with another entry, is accepted.
- `format` — cast to `FileEntry['format']` and used to pick a renderer. A value
  outside the union reaches a `switch` with no matching case.
- `groupId` — may reference a group that does not exist, orphaning files into a
  row that never renders.
- `lastScroll` / `lastProgress` — `typeof === 'number'` is checked, which
  admits `NaN` and `Infinity`. Both are written to MMKV and read back by every
  renderer on mount.
- `name` — unbounded length; rendered in the board, the move sheet and search.

**Fix.** One validator between `JSON.parse` and everything downstream. It
belongs in `unpackArchive`, before `library` is returned, so no caller can
forget it:

```ts
/**
 * Validates a restored index field by field.
 *
 * `JSON.parse` returns `any` and the `as Library` cast asserts a shape nobody
 * checked. Every field below reaches something that trusts it: `storedName`
 * becomes a filesystem path, `id` an MMKV key and a primary key, `format` a
 * renderer choice. A backup is the one input to this app that is wholly
 * authored by someone else.
 */
function validateLibrary(raw: unknown): Library {
  // ... shape checks, then per-entry:
  //   typeof id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(id)
  //   isSafeStoredName(storedName)   // no '/', '\\', '..', non-empty, bounded
  //   format in FORMATS
  //   Number.isFinite(lastScroll)    // rejects NaN and Infinity
  //   groupId resolves to a real group, or the entry is dropped
}
```

Reject the whole archive rather than repairing it: a backup with one bad entry
is not a backup, and partial acceptance is how a hostile file gets a foothold.
`isSafeStoredName` should be **shared with the archive-entry check above**, so
the two cannot drift — that drift is precisely the failure mode
[sanitize.ts](src/renderers/webview/sanitize.ts)'s header documents for the two
HTML passes.

### 2.2 `extensionOf` is unbounded — **Medium (latent)**

[formats.ts:133](src/storage/formats.ts#L133)

```ts
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot < 1 || dot === filename.length - 1) return ''
  return filename.slice(dot + 1).toLowerCase()
}
```

Everything after the last dot, unvalidated — and that string is concatenated
into a filename by `storedFile(id, ext)`. A name of `x.../../evil` yields an
extension containing path separators.

**This is not currently exploitable.** `importFiles` gates on
`isKnownExtension()` (membership in `FORMATS`) before calling
`copyIntoLibrary`, and that is the only caller. But `copyIntoLibrary` is
**exported** with the precondition living in its caller rather than in itself —
the shape of bug this codebase has been bitten by twice, per
[DETAIL.md §6.3](DETAIL.md): *a rule written down rather than enforced*.

**Fix.** Enforce it where it is depended upon, not where it happens to hold:

```ts
export function copyIntoLibrary(...): FileEntry {
  const ext = extensionOf(originalName)
  // Enforced here, not assumed from the caller: this function builds a
  // filesystem path out of `ext`, so it is the place that has to care.
  if (!(ext in FORMATS)) throw new Error(`unsupported extension: ${ext}`)
```

### 2.3 Inbound viewer messages — **Low**

[WebViewRenderer.tsx:793-886](src/renderers/WebViewRenderer.tsx#L793-L886)

Numeric fields are `typeof`-checked, which is better than most. Two gaps:

- **Finiteness.** `typeof msg.scrollY === 'number'` admits `NaN` and `Infinity`,
  which reach `setScroll` → MMKV → every future mount of that file. Use
  `Number.isFinite`.
- **String bounds.** `msg.message` is rendered directly into the error view and
  `msg.query`/`msg.label` into the search and page indicator, none length-capped.

Low severity because reaching it requires the viewer to already be executing
attacker code — at which point the sanitisers have failed and this is the second
line. Worth fixing precisely *because* it is the second line.

### 2.4 Filenames in logs — **Low**

[files.ts:63](src/storage/files.ts#L63), [files.ts:183](src/storage/files.ts#L183)
log `asset.name` and `entry.storedName`. Document titles are personal
information; logcat is readable by any app holding `READ_LOGS` and by anyone
with the device on a cable. Log the id and the format, not the name.

This becomes urgent the moment **R7-1** adds crash reporting: whatever these
lines carry will be uploaded off-device. Fix it before wiring Sentry, not after.

### 2.5 What is already correct — verified, not assumed

Recorded so a later reader does not "improve" it:

- **Two-pass HTML sanitisation.** [sanitize.ts](src/renderers/webview/sanitize.ts)
  (regex, native side) in front of `sanitize()` in
  [viewerHtml.ts:474](src/renderers/webview/viewerHtml.ts#L474) (DOM, inside the
  viewer). Both decode entities and strip control characters before testing
  schemes; both match URL attributes on the *local* name so `xlink:href` is
  covered. Their scope lists agree deliberately.
- **The Markdown renderer resists injection.** Tested, not assumed: `escapeHtml`
  runs *before* any attribute is constructed, so `"` is already `&quot;` and
  attribute breakout via alt-text or URL is impossible; `safeUrl` decodes
  entities and control characters before probing the scheme. Twelve cases —
  `javascript:`, mixed case, tab padding, `&#106;`-encoding, `data:text/html`,
  `vbscript:`, two breakout attempts, raw HTML, raw `<script>` — **all
  contained**, with legitimate links and images surviving intact.
- **SQL is parameterised everywhere**, including the FTS `MATCH` and the new
  `count(*)`. The match expression is quoted term-by-term with `"` doubled,
  which is the correct escape for FTS5's own syntax.
- **Zip Slip is guarded** on archive entry names (2.1 is about the *index*, a
  different input reaching the same sink).
- **The WebView is inert by configuration** — `originWhitelist: ['about:blank']`,
  `allowFileAccess={false}`, `allowUniversalAccessFromFileURLs={false}`,
  `domStorageEnabled={false}`, `setSupportMultipleWindows={false}`, navigation
  refused via `onShouldStartLoadWithRequest`.
- **Both content transports are safe.** The JSON island escapes `<` — the only
  sequence that can end a raw-text element — and the batch path uses base64,
  whose alphabet cannot terminate a JS string literal.
- **The PNG decoder is bounds-safe.** `subarray` clamps, bit depth, interlace,
  colour type and scanline length are all rejected explicitly.
- **`escapeHtml` on the archive listing path** is load-bearing and now pinned by
  [archiveText.test.ts](src/__tests__/archiveText.test.ts) (R6-6).

---

## 3. Performance

### 3.1 `fast-xml-parser` is in the startup bundle — **High, and a live regression**

[App.tsx:30](App.tsx#L30) makes `ReaderScreen` lazy, which should keep the
reader's dependencies out of the startup path. **It does not work**, because a
second, static chain reaches the same modules:

```
App.tsx
  └─ store/library.ts          (static)
      └─ storage/lifecycle.ts  (static)
          └─ renderers/webview/prefetch.ts   (static)
              └─ renderers/webview/prepare.ts (static)
                  └─ renderers/webview/epub.ts (static)
                      └─ ./xml.ts → fast-xml-parser   ~1.4 MB
```

`lifecycle.ts` imports `prefetch.ts` for two functions —
`forgetPrefetchFailure` and `resetPrefetchFailures` — and pays for the entire
subtree to get them. Metro has `inlineRequires: false` in SDK 57, so there is no
lazy-require rescue: **the parser is parsed and evaluated on every cold start**,
before the board can paint, for a code path most sessions never reach.

This is exactly the class of fault R0 instrumented for and it is currently
unmeasured, because `[perf] startup` reports wall-clock without attribution.

**Fix, cheapest first:**

1. **Move the two failure-tracking functions out of `prefetch.ts`** into a small
   `prefetchState.ts` with no heavy imports. `lifecycle.ts` imports that
   instead. One file, no behaviour change, and it severs the chain at its
   weakest link.
2. **Make `epub.ts`'s parser import dynamic** — `await import('./xml')` inside
   the function that parses the OPF — so even the reader path pays for it only
   when an EPUB is actually opened. `prepareSheet` already does this for
   `xlsx`, and `prepareDocx` for `mammoth`; this is the same treatment for the
   one that was missed.
3. **Verify with the R0-1 instrumentation**, not by eye. Add a `[perf] bundle`
   line reporting module-evaluation time, then compare before and after on a
   release build (`npm run apk:dev`; a debug build is 3–8× off and will lie
   about the size of the win).

Expected: a measurable cut in `[perf] startup` on cold launch. **I have not
measured it** — no device this session — so treat that as a hypothesis with a
clear mechanism, not a number.

### 3.2 Replace `fast-xml-parser` outright — Medium

Even lazily loaded, 1.4 MB to read an OPF manifest and an NCX is heavy. The app
uses **five** helpers (`parseXml`, `asArray`, `attr`, `child`, `textOfNode`)
against two small, well-specified documents.

| Option | Size | Notes |
|--------|------|-------|
| `fast-xml-parser` (current) | ~1.4 MB | Full-featured; validation, entities, namespaces |
| **`txml`** | **~30 KB** | Same tree shape; the closest drop-in |
| Hand-rolled | ~2 KB | The OPF/NCX subset only; no new dependency |

`txml` is the pragmatic choice: ~45× smaller for a strictly smaller job. The
hand-rolled option is tempting given the project's existing appetite for it
(the Markdown renderer, the PNG decoder), but XML entity handling has sharp
edges that a book will find, and this parser reads **untrusted** input — the
one place in this codebase where "we wrote it ourselves" is a cost rather than
a saving.

Gate the swap on [xml.test.ts](src/__tests__) covering the five helpers against
a real OPF and NCX first. Without that the swap is unverifiable.

### 3.3 The worklet boundary copies bytes four times — Medium

Already diagnosed in [AUDIT2 §1.2](AUDIT2.md) and still true.
`runOnRuntimeAsync` serialises through `SerializableArrayBuffer`, which copies
into a `std::vector<uint8_t>` and `memcpy`s out — twice per direction. A 30 MB
comic moves 120 MB.

The honest position: **this is a platform constraint, not a project defect.**
`react-native-worklets` 0.10 offers no transfer semantics and no `SharedArrayBuffer`.
The options are all worse than the copy:

- A native module doing the unzip — real work, and the project explicitly
  dropped its Kotlin module.
- Keeping bytes on the JS thread — reintroduces the jank the worklet fixed.
- Chunking across the boundary — more copies, not fewer.

**Recommendation: leave it, and stop re-litigating it.** Record the constraint
in `offload.ts` so the next reader does not re-derive it. Revisit only if
worklets gain transfer semantics.

### 3.4 Cheap wins, in order of value per hour

1. **Board image rendering — checked, already correct.**
   [FileCard.tsx](src/components/FileCard.tsx) uses `expo-image` with
   `recyclingKey={file.id}` on both image sites. That is the right library (real
   memory+disk cache, decode off the JS thread) and the right prop (without it a
   recycled row shows the previous file's cover for a frame). **No action.**
   Recorded because it is the first thing a performance review would suspect.

2. **`FlatList` → `@shopify/flash-list` v2.** The project removed FlashList once,
   for reasons recorded in [LibraryScreen.tsx:759](src/screens/LibraryScreen.tsx#L759);
   **read that note before acting on this.** v2 was rewritten for exactly the
   nested-horizontal-inside-vertical case this board is. If the original
   objection was v1-specific, the win at 3,000+ files is large. If it was
   architectural, leave it — the note is the authority, not this suggestion.

3. **`getItemLayout`** is listed as "not doing" in TASKS2.md because rows vary in
   height. That remains correct. Do not revisit.

4. **Batch the MMKV scroll writes.** `store/scroll` writes on every settle. MMKV
   is fast enough that this is not currently a problem, but a `requestIdleCallback`
   coalescer would make it free. Low value; listed for completeness.

5. **`react-native-pdf` is 9 MB** and the largest single dependency. There is no
   better maintained alternative on RN — `pdf.js` in a WebView would be slower
   and would breach the inert-WebView posture. **Keep it.**

### 3.5 Dependencies: what to add, what to drop

**Add:**

| Library | Size | For |
|---------|------|-----|
| `txml` | ~30 KB | Replaces `fast-xml-parser` (§3.2) |
| `@sentry/react-native` | ~200 KB | R7-1, already planned; see §2.4 first |

**Drop or verify:**

- **`buffer` (104 KB)** — one use, `prepareDocx`, already dynamic. Mammoth needs
  a global `Buffer`. Check whether mammoth's browser build can take a plain
  `ArrayBuffer` without it; if so, one fewer polyfill.
- **`xlsx` from a CDN tarball** — pinned to `https://cdn.sheetjs.com/...`, which
  is **not in the npm registry**. That is a supply-chain and reproducibility
  concern independent of size: `npm ci` on a fresh machine depends on
  sheetjs.com being up and serving the same bytes. Vendor it, or move to the
  registry-published `xlsx` if licence terms allow. Worth a decision, not a
  silent dependency.

**Keep, explicitly:** `fflate` (833 KB on disk, tree-shakes to a fraction, and
the streaming API is load-bearing for R1's restore), `thumbhash` (18 KB),
`react-native-pdf`, `react-native-mmkv`, `zustand`.

---

## 4. Ordering

Cheapest-first, and each item is independently shippable:

| Order | Item | Why first |
|-------|------|-----------|
| 1 | §2.4 filenames out of logs | One line each, and **R7-1 will upload them** |
| 2 | §3.1 sever the `lifecycle → prefetch` chain | One new file, biggest measured-startup win available |
| 3 | §2.1 `validateLibrary` | Highest severity; ~80 lines and a test file |
| 4 | §2.2 `copyIntoLibrary` guard | Three lines; closes a latent hole permanently |
| 5 | §2.3 `Number.isFinite` + string caps | Ten lines |
| 6 | §3.2 `txml` swap | Needs its test file first |

Items 1, 2, 4 and 5 are under an hour combined. Item 3 is the one that matters
most and should not be rushed.

---

## 5. What this audit did not cover

Stated so the gaps are known rather than assumed absent:

- **No device verification.** Every performance claim is structural. §3.1 in
  particular predicts a win by mechanism and has not been measured.
- **No dependency CVE scan.** `npm audit` was not run.
- **No native-layer review.** The Gradle config, signing setup and
  `react-native-pdf`'s own JNI surface were not examined.

(`react-native-blob-util` was checked and is **not** dead weight: it is a
declared peer dependency of `react-native-pdf` at `>=0.13.7`. Keep it.)
