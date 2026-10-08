# PLAN — search highlighting, viewer colour, and a systemic UI pass

**Status: not started.** Written 2026-09-10, to be picked up later. Nothing in
this document has been implemented.

Prior work: v0.1.1's four fixes are complete and verified on device — see
[stackreadrelease/bugs/Fix.md](stackreadrelease/bugs/Fix.md). This is the next
body of work.

---

## Context

Two things came out of testing v0.1.1:

1. **Find-in-document doesn't visibly highlight.** Tracing both search paths
   shows two *different* causes, one per renderer family — not one bug.
2. **The UI wants a design pass.** A full audit of both screens found a lot of
   measurable inconsistency: 19 distinct spacing values, 12 radii, 16 font
   sizes, 6 different press-scale values, 6 touch targets under 44pt, and one
   glyph (`⋯`) rendered at four different sizes with two instances having no
   press feedback at all.

Scope decision: **systemic polish** — keep the app's identity, fix what is
measurably wrong — rather than a full visual refresh. Plus two extra defects
found during the audit (§2.4, §2.5). The design canvas comes before any UI code
changes.

### On `freshtechbro/claudedesignskills`

Evaluated and **not used**. It is a *web* skill collection: Three.js, GSAP,
WebGL, PixiJS, React Three Fiber, Framer Motion, Locomotive Scroll, Barba.js,
AOS, Spline, Rive. Around 20 of its 22 skills emit code that cannot run in React
Native — there is no DOM here, and Reanimated already covers what
`motion-framer` / `react-spring` would. Only `lottie-animations` is plausibly
relevant, and that needs a native module (see the icon decision below).

Used instead: **`/design`** for the canvas, and **`ui-ux-pro-max`**, which
explicitly covers React Native and mobile design systems.

### Decisions taken

| Question | Decision |
|---|---|
| Redesign depth | Systemic polish, not a full refresh |
| Icons | **Leave as-is.** No new dependency, no glyph substitutions |
| Filename display | Out of scope for now |
| Duplicate search results | Out of scope for now |
| Spreadsheet contrast bug | **In scope** (§2.4) |
| Card ⋯ over light covers | **In scope** (§2.5) |

**Reading of the icon decision:** don't change the icon *system* or the
characters. Containers are still normalised — box sizes, touch targets, optical
centring — because "proper alignment of buttons, icons and items" was part of
the original request and that is alignment, not iconography.

**Known and deliberately not acted on,** because it needs a glyph change: `⌕`
(the search icon) is U+2315 TELEPHONE RECORDER, not a magnifier, and `⌄` (the
dropdown chevron) is U+2304. Neither is in Roboto, so both fall back to a symbol
font with different metrics — which is what `Dropdown.chevron`'s `marginTop: -5`
hack is compensating for.

---

# Phase 1 — The design canvas (first)

Invoke **`/design`** to produce a multi-artboard canvas, informed by
`ui-ux-pro-max`. Artboards:

1. **The system** — proposed 4pt spacing scale, radius scale, type scale and
   press-feedback set, each against the ad-hoc values it replaces.
2. **Library board** — current vs proposed at real geometry (cards 132×176,
   gutter 16, card gap 12).
3. **Reader chrome** — top bar, search bar, popover, scroll indicator.
4. **Sheets** — the four side by side, since they currently use four different
   row rhythms (16/15/15/15pt text at 15/13/13/11pt padding).
5. **The reading surface** — typography of the document itself, where users
   actually spend their time and the weakest area in the audit.

No code changes in this phase. Phase 3 is built from whatever is approved here.

---

# Phase 2 — Defects

Bugs rather than restyling, so these do not wait on the canvas.

## 2.1 Search highlighting — WebView formats (EPUB, MD, HTML, DOCX, …)

**Not missing — nearly invisible.** `runSearch` does wrap every match in
`<mark class="sr-hit">`, and `total` is `matches.length` counted *after* each
wrap succeeds, so a non-zero count proves the marks are in the DOM.

The problem is the colour, at
[viewerHtml.ts:245-254](src/renderers/webview/viewerHtml.ts#L245-L254):

```css
mark.sr-hit         { background: rgba(255, 214, 10, 0.42); color: inherit; }
mark.sr-hit-current { background: rgba(255, 159, 10, 0.85); }
```

These are **the only two hard-coded colours in the entire viewer stylesheet** —
every other one is interpolated from the theme. Composited over the paper:

| Reader paper | Non-current match | Contrast vs page |
|---|---|---|
| `#ffffff` light | rgb(255,238,152) | **~1.2 : 1** |
| `#f4ecd8` sepia | rgb(249,227,130) | very low |
| `#17171b` dark | rgb(120,103,20) | muddy olive |
| `#000000` black | rgb(107,90,4) | muddy olive |

`color: inherit` means the text keeps `--sr-ink`, so there is no figure/ground
change at all — only a faint wash. The reader sees **one orange word (the
current match at 0.85 alpha) and every other match invisible.**

**Fix.** Make the highlight opaque and set the ink, the way a real highlighter
works, and drive both from CSS variables like every other reader colour:

```css
mark.sr-hit         { background: var(--sr-hit);         color: var(--sr-hit-ink); }
mark.sr-hit-current { background: var(--sr-hit-current); color: var(--sr-hit-ink); }
```

Set from `viewerSettings()` in
[WebViewRenderer.tsx:66-88](src/renderers/WebViewRenderer.tsx#L66-L88), which
already resolves the paper theme, and applied by `applySettings`. Opaque amber
with near-black ink reads correctly on all five papers, including black.

Keep `sr-hit-current` **after** `sr-hit` in source order — identical
specificity, so the cascade is what makes the current match win.

## 2.2 Search highlighting — PDF

**Genuinely absent, and honestly hard.** pdfium returns per-match rectangles,
[usePdfSearch.ts](src/renderers/usePdfSearch.ts) carries them onto
`SearchHit.rects`, and **nothing ever reads them**. `PdfRenderer` renders exactly
two children: the PDF view and the loading cover.

**The overlay is deliberately not being built.** To place a rect on screen you
need the scroll offset, the rendered per-page height after `fitPolicy=2`, and
the live scale. `react-native-pdf` exposes **no scroll callback at all**, and
`onScaleChanged` is forwarded straight to the pager without being stored. On top
of that, pdfium's rects are in **PDF page space (y-up)** while `mergeRects` in
[search/types.ts](src/search/types.ts) assumes screen space (y-down) — it has no
production caller, so nobody has hit this yet. A real overlay means patching the
library or writing a native view; that is its own project.

**Instead, using data already crossing the bridge:** every hit already carries
`context` (±40 chars around the match) and `contextOffset`, both currently
discarded. Render the current hit's context under the search bar with the
matched span emphasised, so the match is *visible* even without an on-page
highlight. Page-jump navigation stays as it is.

This is not equivalent to on-page highlighting, and should not be described as
closing the PDF gap.

## 2.3 Two smaller search defects

- **`truncated` is dropped on step.** `goToMatch`
  ([viewerHtml.ts:1128](src/renderers/webview/viewerHtml.ts#L1128)) and
  `usePdfSearch`'s step effect both post a status without `truncated`, so the
  `+` in `1/500+` **vanishes the first time next is pressed**. Carry it through.
- **Highlights outlive their UI.** Tapping the document while search is open
  hides the chrome, which unmounts `SearchBar` without calling `close(fileId)` —
  leaving marks painted with no way to clear or navigate them. Make the
  hide-chrome path close search, matching what the back button already does.

## 2.4 Spreadsheet text invisible — the viewer's two-palette bug

Visible in `stackreadrelease/screenshots` / `screenshots/04-xlsx-grid.png`: cell
text is essentially unreadable. The cause is structural and affects far more
than spreadsheets.

**The viewer paints surfaces from the APP palette and ink from the READER's
paper theme, and the two never coordinate.** Baked in at HTML-build time:

- `html, body { background: ${theme.gutter}; color: var(--sr-ink); }` — the two
  halves of one rule come from different palettes
- `#paper.flow-mode { background: ${theme.bg} }` — spreadsheets, CSV, zip listings
- `.sr-grid td { background: ${theme.surface} }`
- `thead th`, `code`, `pre` → `${theme.surfaceAlt}`
- `blockquote` → `${theme.fgDim}`, rules → `${theme.border}`, links → `${theme.accent}`

With a **light or sepia** reader theme on a **dark** phone, ink is `#14141a` and
the cell behind it is `#15171e`. Dark on near-black. The same cause makes a code
block a near-black slab on a cream page, and blockquote text light grey on cream.

**Fix.** Derive every in-document surface from the reader's paper instead.
Extend `viewerSettings()` to return derived values alongside `paper`/`ink` —
`paperAlt`, `rule`, `inkDim`, `link`, `gutter`, plus the highlight pair from
§2.1 — have `applySettings` set them all as CSS variables, and replace the
`${theme.*}` interpolations inside the document CSS with `var(--sr-*)`.

The stylesheet is **completely unpinned by tests**, so this is safe to change.

One dead line while in there:
`color-scheme: ${theme.bg === '#0b0b0d' ? 'dark' : 'light'}` — neither palette's
`bg` is `#0b0b0d` (dark is `#0b0c11`), so the WebView always declares a light
scheme. Derive it from the resolved paper instead.

## 2.5 Card ⋯ invisible on light covers

On a white book cover the menu button disappears. `menuBtn` is `theme.overlay`
(`rgba(0,0,0,0.45)`) with a `#fff` glyph — not enough against a bright
thumbnail. Give it an opaque scrim and a hairline so it holds over any image,
and fix the ripple, currently `rgba(255,255,255,0.2)` — a white ripple on a dark
plate, invisible in light mode.

---

# Phase 3 — Systemic polish (after the canvas is approved)

## 3.1 Tokens that don't exist yet

New **`src/ui/tokens.ts`**, alongside `motion.ts`, which already proves the
pattern works here:

- **`Space`** — a 4pt grid. Today **19 distinct spacing values between 1 and
  28**; every integer from 2 to 16 is in use except 17.
- **`Radius`** — today **12 distinct radii**, and nothing is concentric: a card
  at radius 14 with 8pt padding should give an inner 6, but its preview uses 9
  and the two badges inside it use 6 and 4.
- **`Type`** — size + weight + lineHeight together. Today **16 sizes across 25
  pairs**, with 13 / 13.5 / 14 all serving the same semantic role and weight 600
  vs 700 carrying no meaning. `lineHeight` is set on only 5 of 25 styles.
- **`Hit`** — one minimum touch target and one `hitSlop` rule. Today hitSlop is
  6, 8, 10 or 12 with no rule.

Extend `Scale` in [motion.ts](src/ui/motion.ts): press feedback currently uses
**0.85, 0.86, 0.88, 0.92, 0.97 and 1**, and `Scale.press` (0.97) is used by
exactly one component. Consolidate to two — one for large surfaces, one for
small controls.

## 3.2 Applying them

**One shared menu button.** `⋯` appears at 24/700 (library header), 18/700
(group row), 15/700 (card) and 15/600 (reader) — four sizes, four containers,
and **two have no press feedback at all**. One `MenuButton`, used in all four.

**Touch targets.** Six are under 44pt: "show more" (26), UNDO (31), group title
(32), search clear (28×36), EmptyBoard CTA (38), search result row (39), group
⋯ (41 tall). The two worst are also transient — the hardest kind to hit.

**Alignment fixes:**

- The card strip is **asymmetric — 16 left, 28 right** — because `FileCard.wrap`
  applies `marginRight` to the last card too.
- `EmptyBoard` sits at `paddingHorizontal: 28` inside the header's 16, so the
  first thing a new user reads is inset 44pt and aligns with nothing.
- Card **preview height shifts by 10px** depending on whether the file has been
  opened, because the progress track is conditional — so cards in one row have
  different preview areas. Reserve the track always.
- `FileCard` has a **hairline** border while `AddTile`/`MoreTile` beside it have
  **1.5** — a 3–4× stroke difference between adjacent same-size tiles.
- Reader top bar: the back button is the only control with **no declared
  height** (28 in a 34pt row) and its glyph is 26pt while the `⋯` at the other
  end is 15pt.
- `ScrollPageIndicator` positions itself with a bare `56` matching neither
  `TOP_BAR_H` (52) nor the bottom bar (~45). Derive it.

**Sheet rhythm.** Four sheets, four rhythms: body text 16/15/15/15 at padding
15/13/13/11, horizontal 20/20/16/20. Pick one.

**Motion consistency:**

- `Timing.tint` (100ms) exists and is **never used**; both sheet row tints run on
  `Spring.snappy` (350ms) instead, interpolating from `'transparent'`, which on
  Android passes through transparent *black* and darkens the row mid-press.
- The **importing overlay has no enter/exit** — the largest un-animated surface
  in the app hard-cuts in and out over the whole board.
- `GroupRow` exits at `Duration.medium` while every other exit is `fast` or
  `instant`.
- Inline numbers against `motion.ts`'s stated rule: `0.88`, `0.65`, `120` (×3),
  `220`, `40`, `120`/`70`, `0.3`, `400`, `0.7`, `0.92`/`0.08`/`-8`, `-12`/`+12`.

**Two dead things** worth removing while adjacent: `FileCard`'s `dragging` prop
is never passed by `DraggableCard`, so its ghost-opacity animation never runs;
and `PageDots` accepts a `theme` prop it destructures as `_theme` and discards,
while `ReaderScreen` still passes it.

## 3.3 Explicitly out of scope

- **Filename display.** Cards keep showing `andrew-ng-machine-learning-yearni…`.
  Self-contained, available later.
- **Duplicate search results.** Quick way to tell which it is: if the board shows
  two cards for `Orbital Silence.epub` it's a duplicate import; if one card but
  two search rows, the FTS index is stale and needs a `rebuild`.
- Icons, per the decision above.

---

## Tests that pin source text — must not break

These assert on **raw source**, so they constrain how, not whether:

- **[viewerSearch.test.ts](src/__tests__/viewerSearch.test.ts)** slices the
  emitted script between the literal comments `/** Flat text index` and
  `/** Removes every highlight`, and by the function names `runSearch`,
  `goToMatch`, `clearHighlights`, `cssEscape` **in that order**. It also pins the
  backwards paint loop, the empty-query early return (within 200 chars of its
  guard), and the wrap-around modulo. It asserts **nothing** about colour — §2.1
  is free, restructuring is not.
- **[search.test.ts](src/__tests__/search.test.ts)** requires the mapped PDF hit
  to still contain `rects:` — they stay on the wire even while unused.
- **[perceivedSpeed.test.ts](src/__tests__/perceivedSpeed.test.ts)** pins two
  `<Dropdown/>` call sites, four `ScrollPageIndicator` regions, the literal
  `contentContainerStyle={listContentStyle}`, and `GroupRow`'s `memo()`.
- **[motionPolicy.test.ts](src/__tests__/motionPolicy.test.ts)** pins the reader's
  auto-hide guard as one line containing all four terms.

---

## Verification

**Static.** `npm run check` after each phase. `tsc --noEmit` alone is not
enough: the viewer is a template literal, so the type checker validates the
*string* — which is exactly why `viewerSearch.test.ts` parses the emitted script.

**On device**, per phase:

1. **Search, WebView.** Open an EPUB, search a common word. Every match must be
   visibly highlighted, not just the current one, and legible on **all five**
   reader themes — check Light and Black especially. Press next repeatedly and
   confirm the `+` on a truncated count survives. Hide the chrome mid-search and
   confirm highlights clear.
2. **Search, PDF.** Confirm the context strip shows the matched text with the
   match emphasised, and that next/prev still jumps pages.
3. **Spreadsheet.** Open an xlsx with the reader theme set to **Light**, then
   **Sepia**, with the phone in **dark** mode. Cell text must be readable in
   every combination — that is the exact case that fails today. Also check a
   Markdown file with a code block and a blockquote on sepia.
4. **Card menu.** Find a white-covered book and confirm `⋯` is visible.
5. **Polish.** Compare against the approved canvas. Walk every control for press
   feedback, and check the six raised touch targets on a real thumb.

**Release.** Bump `version` and `android.versionCode` in `app.json`, then
`npm run apk` — redirect to a file and `echo $?`, never pipe through `tail`.
