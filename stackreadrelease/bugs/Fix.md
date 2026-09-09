# Fix — v0.1.0 release defects

Four problems found in the tagged v0.1.0 build, all present in dev as well. One
is a release blocker; the other three are UI defects in the reader chrome and the
library's undo affordance. The screenshots beside this file
(`../Screenshot_20260909_17*.jpg`) are the report.

This document is the plan and the record: what was wrong, why, what changed, and
how to verify it. It is written to be readable after the fact, not only before.

## Status

All four are implemented. `npm run check` is green — typecheck clean under
`noUnusedLocals` / `noUnusedParameters`, **377 tests passing** (376 before, plus
the two island regression tests below, one of which replaced nothing). No native
rebuild is required; every change is JS and arrives over Fast Refresh.

On-device verification is still outstanding and is listed at the end.

One note from the implementation, because it is the kind of thing that looks like
a flake later. The new assertion for Bug 1 —

```ts
assert.doesNotMatch(js, /render\(JSON\.parse\(/)
```

— failed on first run against **its own fix**. The replacement comment in
`viewerHtml.ts` quoted the old expression to explain what had been wrong, and
that comment is *inside* the emitted script, so the assertion found the pattern
in prose rather than in code. The comment was reworded rather than the assertion
weakened: a guard that also catches a description of the bug is behaving
correctly for a file where comments ship to the runtime.

---

## Context

StackRead is a React Native port (Expo SDK 57 / RN 0.86.3, New Architecture) of a
desktop Electron reader, organised as a **2-D board** rather than a file list. A
group is a horizontal row of related files and a *logical tag*, never a folder,
so moving a file between groups is a one-field change that never touches disk.
Opening a file gives vertical scroll to read and horizontal swipe to move between
files in the same group.

Eleven formats converge on two renderer families — native `PdfRenderer` /
`ImageRenderer`, and a deliberately inert `WebViewRenderer` fed by `prepare.ts` —
so adding a format is one function rather than a native module. That convergence
is why **Bug 1 below is much wider than the two formats it was reported against**.

---

## Bug 1 — "Couldn't open this file: TypeError: Cannot read properties of null (reading 'mode')"

**Severity: high — release blocker.**

Reported for EPUB and Markdown: the first open fails, reopening works. The real
blast radius is **every WebView-backed format** — EPUB, Markdown, HTML, text,
DOCX, spreadsheets and CBZ, seven of the eleven. PDF and image are unaffected
because they use different renderers.

### Root cause — a `null` that should have been `undefined`

1. `src/renderers/WebViewRenderer.tsx:178-185` — a cold open has no cache hit, so
   the `payload` state initialises to **`null`**.
2. `src/renderers/WebViewRenderer.tsx:198` — `const inlinedPayload = useRef(payload).current`
   captures that `null`.
3. `src/renderers/WebViewRenderer.tsx:290` — it is passed to `buildViewerHtml()`
   as `initialPayload`.
4. `src/renderers/webview/viewerHtml.ts:271` — the guard is
   `initialPayload === undefined ? '' : <script id="sr-initial">…`.
   **`null !== undefined`**, and `JSON.stringify(null)` is `"null"` — so the
   document ships a real, present island whose entire content is four characters:

   ```html
   <script id="sr-initial" type="application/json">null</script>
   ```

5. `src/renderers/webview/viewerHtml.ts:1697-1699` — boot finds the island and
   calls `render(JSON.parse('null'))`, i.e. `render(null)`. The `|| 'null'`
   fallback on that line pushes toward the same value rather than away from it.
6. `src/renderers/webview/viewerHtml.ts:1341` — `mode = payload.mode || 'paper'`
   throws. This is the **only** `.mode` read on a possibly-null object in the
   repo; `offload.ts`, the worklet runtimes, `prepare.ts` and `expo-file-system`
   were all traced and are clear.
7. The throw is caught by `render`'s **own** catch (`viewerHtml.ts:1429-1432`),
   which posts `String(e)` verbatim — which is why the on-screen message carries
   no `'initial payload unreadable: '` prefix, matching the screenshot exactly.
8. `src/renderers/WebViewRenderer.tsx:883-897` — `setError` renders the error
   screen and returns early, **unmounting the WebView**. `prepareFile` then
   resolves successfully a moment later and `setPayload` has nowhere to deliver
   it. The open is lost even though the parse worked.

### Why reopening works, and why EPUB differs from Markdown

`prepareFile`'s result is cached *before* the cancellation check
(`WebViewRenderer.tsx:450-460`), so even the failed open warms the cache. On
reopen `inlinedPayload` is a real object, the island parses, and the file
renders.

`src/renderers/webview/diskCache.ts:150-172` declines to persist anything
carrying `loadRest` / `loadImages`, and EPUB always sets both
(`prepare.ts:582,585`). Hence the asymmetry:

| Format | Cached where | Symptom |
|---|---|---|
| Markdown, text, HTML, DOCX | memory **and** disk | fails on the very first open ever, then survives restarts |
| EPUB (and anything streaming images) | memory only | fails on the **first open of every app session** |

### Why the test suite missed it

`src/__tests__/viewerHtml.test.ts:594-598` asserts no island is emitted — but
both assertions **omit** the argument, testing `undefined`. `null`, the value the
only production call site actually passes on a cold open, was never tested. The
test's own comment states the invariant that production violates.

### The fix — defence in depth

| # | Site | Change |
|---|---|---|
| 1 | `viewerHtml.ts:271` | `initialPayload === undefined` → `initialPayload == null`. The primary fix; restores the documented "a cold open gets an empty shell and the message path" behaviour. |
| 2 | `viewerHtml.ts:1339` | Guard `render` with `if (!payload) return;` before touching `payload.mode`. Returning silently is correct — the host still pushes content on `boot`. |
| 3 | `viewerHtml.ts:1697-1705` | Parse first, render only if truthy, so an empty or `null` island is a no-op rather than a call with a null argument. |
| 4 | `WebViewRenderer.tsx:290` | Pass `inlinedPayload ?? undefined`, so the call site's intent matches the guard rather than relying on it. |
| 5 | `WebViewRenderer.tsx` `apply()` | `setError(null)`. Fixes the failure *class*: `setError` was a one-way latch, so any viewer-side error during boot permanently discarded a document that had prepared successfully. Cannot loop — an unrenderable document re-posts `error`, but `payload` no longer changes, so `apply` does not re-run. |

### Tests added

- The `null` case at `viewerHtml.test.ts:594`, with a comment naming
  `WebViewRenderer`'s cold-open call site as the reason `null` is the value that
  matters.
- An assertion that the emitted boot code guards its island read. This suite
  already parses the emitted script — it exists because the viewer is a template
  literal that `tsc` only sees as a string — so it is the right home for it.

---

## Bug 2 — Undo snackbar sits behind the Android navigation bar

### Root cause

`src/components/UndoToast.tsx:27` hard-codes `bottom: 18 + index * 58` inside a
`StyleSheet.absoluteFill` container. The app runs **edge-to-edge**
(`edgeToEdgeEnabled=true`, both system bars transparent — see
`src/ui/useFullscreen.ts:15`), so `bottom: 18` is 18px from the *screen* bottom,
i.e. underneath the ~48dp 3-button bar. The component never calls
`useSafeAreaInsets()`.

It is the **only** bottom-anchored interactive surface in the app that does not.
Everything else already consumes the inset: list content
(`LibraryScreen.tsx:689-692`, `insets.bottom + 96`), the reader's bottom bar
(`ReaderScreen.tsx:416`), every sheet (`SheetShell.tsx:136`). The cost is
unusually high here because the undo window is only five seconds
(`UNDO_MS = 5000`, `src/store/pendingRemoval.ts:29`).

### Fix A — lift the toast clear of the bar

`useSafeAreaInsets()` is called once in `UndoToasts` (the parent, not per-toast)
and `bottomInset` passed down, so the stack becomes
`bottom: bottomInset + 18 + index * 58`.

### Fix B — glassmorphic strip behind the nav bar

A **JS-only glass scrim**, chosen over a real blur. `expo-blur` is not installed,
and on Android SDK 57 a real `BlurView` additionally requires wrapping screen
content in `BlurTargetView` and passing its ref — a per-frame render capture over
a scrolling board, plus a native rebuild. Recorded as a follow-up instead.

New component `src/components/NavBarScrim.tsx`:

- Absolute, `left/right/bottom: 0`, `height: insets.bottom`, `pointerEvents="none"`.
- Four stacked layers of increasing alpha to fake a gradient without pulling in
  `expo-linear-gradient`, plus a hairline top rule so the strip has an edge.
- Returns `null` when `insets.bottom === 0` — gesture nav with no inset, or
  immersive mode. No empty view, no wasted layer.

The ramp lives in `src/ui/theme.ts` as two tokens — `navScrim` (four stops) and
`navScrimEdge` (the hairline) — rather than as `rgba()` literals in the
component. That file states the rule: *"no literal hex outside this file, so dark
mode can't drift out of sync."* Both ramps are built from their palette's own
`bg`, so the strip resolves to the page colour at full strength instead of to a
grey that would read as a foreign surface.

Mounted in `LibraryScreen` between `PdfCoverFactory` and `UndoToasts`, so the
toast floats above the glass. **Not** in the reader: its bottom bar already spans
full width with `rgba(0,0,0,0.45)` and pads by `insets.bottom + 12`, and in
immersive mode the nav bar is hidden entirely — a scrim there would fight the one
rule the reader has.

**Deliberate non-change.** `UndoToast` hard-codes its own hex (`#2a2a32`,
`#7fb0ff`, `#fff`). A snackbar is conventionally an inverted surface, and the
reader chrome makes the same exception for the same reason. Re-tinting it from
`theme.*` risks making it invisible for no gain.

---

## Bug 3 — Scroll indicator truncates to "115 / 2…" and hides the percentage

### Root cause

The badge's containing block is 44pt wide. `ScrollPageIndicator.tsx:438-448`
positions `styles.badge` absolutely with only `right: 18` — no `left`, no
`width` — inside `styles.wrap` (line 401), which is `width: 44`. Yoga lays an
absolute child out against its parent's padding box, so the badge resolves to
roughly `44 − 18 = 26pt`:

- `paddingHorizontal: 10` takes 20 of those 26pt, leaving ~6pt for text, so
  `numberOfLines={1}` ellipsises to **"115 / 2…"**.
- The divider and percent are laid out *after* the text in a `row`, so they fall
  outside the box entirely — **the percentage never appears**.

The comment at lines 430-437 claimed "the badge lives outside the 44pt gesture
column" and that absolute positioning without a width constraint let it extend
past the parent. Both halves were wrong: it was a direct child of `wrap`. A
previous fix attempt described the right idea and never applied it. That comment
is rewritten — leaving a confidently wrong explanation in place is how this
regresses again.

### Fix — give the badge a full-width containing block

The gesture column and the badge become siblings:

```
<View style={styles.host} pointerEvents="box-none">     ← left:0 right:0, full width
  <GestureDetector gesture={pan}>
    <View style={styles.column} onLayout={…}>           ← right:0, width:44 (unchanged)
      <Animated.View style={[styles.track, fade]} />
      <Animated.View style={[styles.thumb, thumb]} />
    </View>
  </GestureDetector>
  <Animated.View style={[styles.badge, badge]} pointerEvents="none"> … </Animated.View>
</View>
```

- `host` spans full width but is `pointerEvents="box-none"`, so taps still pass
  through to the document everywhere except the 44pt column — current behaviour,
  preserved.
- The badge now sizes to its content and shows `115 / 592 · 19%` in full.
- `onLayout` moves to the inner `column`. It drives `trackHeight`, and the column
  spans the same top-to-bottom extent, so `e.y` in the pan handlers keeps its
  meaning. None of the gesture maths changes.
- `marginTop: -15` becomes `-BADGE_H / 2` from a named constant, so the centering
  is derived rather than hand-picked.

Polish within the same structure: a hairline border on the pill so it reads over
a white PDF page as well as a dark one, and the inline
`{ duration: 320, easing: Ease.exit }` at line 145 routed through a `motion.ts`
token, which that file's own rule requires.

**The thumb stays a fixed 44pt.** Proportional-to-document sizing was considered
and deliberately left out of this change.

### Tests that pin this file

`src/__tests__/perceivedSpeed.test.ts:657-757` asserts on four raw source
patterns — the `if (total < 2 || dragging…) return` visibility guard, `endDrag`'s
ordering (`setPendingPage` before `setDragging`), `Math.abs(current - pendingPage) <= 1`,
and `seekTo`'s throttle-before-`setDragPage` ordering. None touch the badge markup
or the stylesheet, so this rework is free — but those four regions stay untouched.

---

## Bug 4 — Reader top bar is cluttered

Before: `‹` · **File ▾** · **Group ▾** · `☰` · `⌕` · `Aa` — six controls in one
row at `gap: 9`, so the two dropdowns (`flex: 1.35` / `flex: 1`) fight for what is
left and a long filename ellipsises hard.

After: **`‹` · File ▾ · Group ▾ · `⋯`**. Back stays a one-tap target; the three
glyph buttons collapse into one, recovering ~60pt for the dropdowns.

### The menu — an anchored dropdown card, not a bottom sheet

New component `src/components/PopoverMenu.tsx`: a small card that drops from the
`⋯` button with its items stacked vertically, the way a normal overflow menu
behaves.

- Rendered in a transparent RN `Modal` with `statusBarTranslucent` and
  `onRequestClose`. Not incidental — `SheetShell.tsx:20-30` records that
  `@gorhom/bottom-sheet` was evaluated and **rejected** for having no Android
  back-button handling. `Modal` + `onRequestClose` is the house pattern, and the
  popover must not regress it.
- A full-screen transparent `Pressable` backdrop dismisses on outside tap.
- Anchored top-right: `top: insets.top + TOP_BAR_H`, `right: 10` (matching the
  bar's `paddingHorizontal`), `theme.surface`, radius 12, `theme.border` hairline,
  elevation, `minWidth: 200`.
- Rows are glyph + label, reusing `usePressAnimation` and the row-tint pattern
  from `ActionSheet`'s `Item` — tint, not scale, because a full-width row that
  shrinks on touch looks like it is detaching from the card.
- Enter: scale `0.92 → 1` plus fade and a small `translateY`, so it reads as
  dropping from the button. Tokens from `motion.ts`, never inline numbers, and
  `useReducedMotion()` honoured.

### Wiring in ReaderScreen

`'menu'` is added to the `Sheet` union (`ReaderScreen.tsx:42`). That one change
makes three existing behaviours cover the menu for free, because all three
already test `sheet !== 'none'`:

- auto-hide chrome pauses while the menu is open (line 211);
- Android back closes the menu before the reader (line 235);
- immersive mode stays off (line 106).

Menu items: **Find in document** (`⌕`), **Chapters** (`☰`, rendered only when the
document declares a TOC, exactly as the button was), **Display** (`Aa`).

Transitions follow the `ActionSheet` convention — `setSheet('none')` then
`requestAnimationFrame(...)` — so one Modal has begun dismissing before the next
mounts. Presenting two Android Modals in the same frame flickers.

`TOP_BAR_H = 52` is extracted as a named constant (`8` top pad + `34` control +
`10` bottom pad) and used for both the popover's `top` and `SearchBar`'s
`topOffset` (`ReaderScreen.tsx:391`), which hard-coded `insets.top + 52` — an
undocumented mirror of the bar's height that would break silently if the bar
changed. The dead `toolGlyph` style (line 473) is removed; it was unreferenced,
and `noUnusedLocals` does not catch unused StyleSheet keys.

### Tests that pin this file

`perceivedSpeed.test.ts:1001-1023` requires **exactly two** `<Dropdown … />` call
sites in `ReaderScreen.tsx`, neither passing `theme=` — the new layout keeps
both. `motionPolicy.test.ts:169-198` requires the auto-hide guard to remain one
line containing `sheet !== 'none'`, `searchOpen`, `seeking` and `!documentLive` —
adding `'menu'` to the union does not alter that line.

---

## Also found while tracing

| # | Finding | Handling |
|---|---|---|
| 1 | `setError` in `WebViewRenderer` is a one-way latch — any transient viewer error permanently kills an open | **Fixed** with Bug 1 |
| 2 | The `ScrollPageIndicator` badge comment describes a fix that was never applied | **Rewritten** with Bug 3 |
| 3 | `SearchBar`'s `topOffset` and `ScrollPageIndicator`'s `top: topInset + 56` both hard-code the top bar's height from other files | `TOP_BAR_H` extracted for the first; the indicator's `+56` noted, left alone |
| 4 | `pageNav.report`'s dedupe guard compares `current` / `total` / `percent` but **not** `label`, so a label-only change (roman → arabic) will not publish | Noted; no observed symptom |
| 5 | `useFullscreen.ts` calls `setVisibilityAsync` / `setBehaviorAsync`, both **deprecated** in `expo-navigation-bar` SDK 57 (`setBehaviorAsync` is no longer documented at all) — immersive mode is one SDK bump from breaking | Follow-up |
| 6 | Real `expo-blur` glass | Follow-up; needs prebuild + native rebuild + `BlurTargetView` |
| 7 | AUDIT3's two open findings — `fast-xml-parser` in the startup bundle (~1.4 MB past the `lazy()` boundary), and restore validating shape not contents | Out of scope; still open |
| 8 | `app.json` `versionCode` is still `1` and maintained by hand (TASKS2 R7) | Bump with this release |

---

## Files touched

**Modified**

- `src/renderers/webview/viewerHtml.ts` — island guard, `render` null guard, island read
- `src/renderers/WebViewRenderer.tsx` — `?? undefined`, clear error on apply
- `src/components/ScrollPageIndicator.tsx` — host/column/badge restructure, comment rewrite
- `src/components/UndoToast.tsx` — bottom inset
- `src/screens/ReaderScreen.tsx` — top bar rework, `'menu'` sheet, `TOP_BAR_H`, dead style
- `src/screens/LibraryScreen.tsx` — mount `NavBarScrim`
- `src/ui/theme.ts` — `navScrim` token
- `src/__tests__/viewerHtml.test.ts` — the `null` island regression test

**New**

- `src/components/NavBarScrim.tsx`
- `src/components/PopoverMenu.tsx`
- this file

---

## Verification

**Static.** `npm run check` — typecheck plus the full suite. `npx tsc --noEmit`
alone is not sufficient: the viewer is a template literal, so the type checker
validates the *string* and cannot see a syntax error in the JavaScript inside it
— exactly the class of bug fixed here.

**On device.** All changes are JS, so Fast Refresh carries them; no native
rebuild. Read any timings from a release build (`npm run apk:dev`), never
`npm run android` — debug numbers are 3–8× off.

1. **Bug 1.** Force-quit from recents (not a reload) to clear the memory cache,
   then open an **EPUB** — it must render on the *first* tap. Repeat for `.md`,
   `.txt`, `.html`, `.docx`, `.xlsx`, `.cbz`. Then clear app data and repeat for
   Markdown, the case the disk cache otherwise masks. Confirm PDF and image still
   open.
2. **Bug 2.** Delete a group with several files; the toast must sit fully above
   the nav bar with UNDO tappable, and UNDO must restore the group. Check with
   both 3-button and gesture navigation, and rotate — `insets.bottom` differs in
   all three. Confirm the glass strip appears with content scrolled under it and
   vanishes when `insets.bottom` is 0.
3. **Bug 3.** Open a long PDF and a long EPUB and drag the scrollbar. The pill
   must show page, total and percent with no ellipsis at any page number,
   including a 4-digit total. Confirm the percent returns on release and is hidden
   mid-drag, that a roman-numeral label still fits, and that dragging still seeks.
4. **Bug 4.** The bar shows `‹ · File ▾ · Group ▾ · ⋯` only, and a long filename
   has visibly more room. `⋯` drops a card from the button. Chapters appears only
   for a document that declares a TOC. Each item acts with no Modal flicker.
   Hardware back closes the menu, then search, then the reader — in that order.
   Chrome does not auto-hide while the menu is open. Tapping outside dismisses.

**Release.** Bump `version` and `android.versionCode` in `app.json`, then
`npm run apk`. Never pipe a build through `tail` — the shell reports the last
command's status, which once masked a FAILED Gradle build as exit 0. Redirect to
a file and `echo $?`.
