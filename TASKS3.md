# StackRead — task list, L-series (Looks)

Adds the redesign in [design/redesign-plugin](design/redesign-plugin/README.md)
(Figma: <https://www.figma.com/design/7P4WuTpeVgA7D4B9j4NV1b>) as **optional
looks and colour themes**, sold later as Pro. The app as it is today becomes the
**Classic** look, and stays the default.

**Status: L0, L1, L3–L8 built — 553 tests pass. Needs a native rebuild (L1:
SVG module and 28 embedded font faces), then the on-device checks under L6–L8.
L2 (full Appearance screen) and L9 (billing) not started.**

**The paywall is off** (decided 2026-11-02): every look is open to everyone in
every build while the looks are being made. `PAYWALL_ENABLED` in
[store/pro.ts](src/store/pro.ts) turns the lock on in L9; the resolution logic
and its tests already exist.

---

## Rules for every phase

1. **Classic does not change.** It is the default, and it is what anyone without
   Pro sees. Today's components are not restyled. Where a screen has to choose
   between Classic and another look, the switch sits in the screen, and the
   Classic branch renders exactly what it renders today. If an existing component
   has to accept something new, it is an *optional* prop whose default is today's
   behaviour.
2. **New looks live in `src/looks/`** (one file per look). They reuse today's logic (stores,
   gestures, hooks like `useThumbnail` and `useSnippet`); only presentation is new.
3. **Lock by resolution, not by deletion.** The chosen look and theme are saved
   as chosen. `resolveAppearance()` returns Classic whenever Pro is off, so a
   refund or a lapsed entitlement falls back to Classic, and buying again
   restores the choice. Nothing else in the app asks "is this user Pro?" for
   looks.
4. **Until L9 there is no lock at all** (`PAYWALL_ENABLED = false`). The dev
   switch in `store/pro.ts` stays for testing the lock once it is on.
5. The usual gates still apply: `npm run check` before any reload; Zustand
   selectors return stable values (CLAUDE.md §5.1); nothing heavy in the startup
   graph (`startupBundle.test.ts`); a look's code loads only when that look is
   active.

---

## Running order

```
L0  foundation — appearance + pro state, palettes, resolution    DONE · no visible change
L1  assets — icon set, fonts                                      BUILT · native rebuild
L2  Appearance screen + locks + dev Pro switch                    first visible step
L3  Modern — board                                                 BUILT
L4  Modern — reader chrome, sheets, search                         BUILT (sheets shared by all looks)
L5  reading — two new page themes, five reading fonts, Display     BUILT
L6  Notebook look                                                 BUILT
L7  Shelf look                                                    BUILT
L8  Terminal look                                                 BUILT
L9  Pro for real — Play Billing via RevenueCat (ROADMAP §6)        native rebuild
```

Each phase ships on its own and leaves Classic untouched.

---

## L0 — Foundation — ☑ done

Nothing on screen changes. Everything later reads from what this phase adds.

- ☑ **L0-1 Palettes as data** — `src/looks/palettes.ts`. The eight app themes
  (Midnight, Daylight, Paper, Sepia, Forest, Ember, Terminal, OLED) × 17 roles,
  and the six reading themes, copied from the Figma variables. Pure data, no
  imports.
- ☑ **L0-2 Resolution** — `src/looks/appearance.ts`, pure. Types for `Look` and
  the theme names; `resolveAppearance(stored, isPro, systemDark)`; `paletteTheme()`
  turning a palette into a full `Theme` (overlay, gutter and nav scrim derived
  from `bg`, as theme.ts does today); `groupColor(groupId)` — a stable hash to one
  of five, so group colour needs no schema change.
- ☑ **L0-3 Appearance state** — `src/store/appearance.ts`, persisted in MMKV
  beside `readerSettings`: `look`, `theme`, `followSystem`, `lightTheme`,
  `darkTheme`, `readingFont`. Defaults to Classic.
- ☑ **L0-4 Pro state, stub** — `src/store/pro.ts` → `useIsPro()`. Currently
  always true (`PAYWALL_ENABLED = false`); a dev-only switch exists for testing
  the lock once it is on. Replaced by billing in L9.
- ☑ **L0-5 `useTheme()` reads the resolution** — Classic returns today's `light`
  / `dark` objects, the same references as now, so nothing re-renders differently.
  Other looks return the palette theme. Adds `useLook()`.
- ☑ **L0-6 Tests** — `src/__tests__/appearance.test.ts`: defaults resolve to
  Classic; a stored look without Pro resolves to Classic and keeps the choice;
  Pro resolves to the choice; follow-system picks the light or dark theme; every
  palette has every role as valid hex; group colour is stable and in range.

**Done when:** `npm run check` passes and the app looks and behaves exactly as
before.

## L1 — Assets — ☑ built (rebuild pending)

- ☑ **L1-1 Icon set** — `react-native-svg` 15.15.4;
  [looks/Icon.tsx](src/looks/Icon.tsx) has the 32 icons, generated from the
  Figma plugin's own icon data.
- ☑ **L1-2 Fonts** — `expo-font` ~57.0.4. Nineteen OFL faces for Notebook,
  Shelf and Terminal in `assets/fonts/` (2.1 MB uncompressed; licences in
  `assets/fonts/licenses/`), listed in the `expo-font` plugin in app.json. One
  file per face, and **the file name is the font family** on Android
  (`Fraunces-SemiBoldItalic`), so styles set `fontFamily` and leave weight and
  style at normal — `face()` in [looks/skin.ts](src/looks/skin.ts) does this,
  so Android never synthesises a fake bold on top. Geist and the reading fonts
  come with L3 and L5.
- ☐ **L1-3 Rebuild** — required before the JS reloads: `react-native-svg` is a
  native module and the fonts are embedded at build time. Check APK size.

The looks and react-native-svg are **not** in the startup graph: the registry
loads each look on first use (pinned in `startupBundle.test.ts`), so Classic
launches exactly as before.

## L2 — Appearance screen — ☐

- ◐ **L2-1 Entry** — a "Look…" row is already the first row of the board's ⋯
  (Library) sheet, opening a plain list of looks. L2 replaces that list with the
  Appearance screen. The row is the only Classic change in the series.
- ☐ **L2-2 Screen** — look tiles with previews, colour swatches, the two toggles
  from the sheet. Locked tiles show a lock; tapping one opens a placeholder Pro
  sheet ("Coming soon", plus "Unlock (dev)" in dev builds).
- ☐ **L2-3 Dev Pro switch** — on the Appearance screen in `__DEV__` builds only.
- ☐ **L2-4 Interim result** — with Pro on and a colour theme chosen, today's
  components already recolour through `useTheme()`. That is the check that L0
  is wired correctly.

**Done when:** you can switch theme with the dev switch on, and Classic comes
back the moment it is off.

## L3 — Modern: board — ☑ built (device check pending)

- ☑ **L3-1 Seams** — done with L6–L8: Modern is one more `Skin` in
  `looks/registry.ts`.
- ☑ **L3-2 Components** — [looks/modern.tsx](src/looks/modern.tsx): logo top
  bar with a count line, group header with colour chip, card (position number,
  clean title, three lines of snippet or the cover, format mark, size or
  "Read", progress line in the group colour), dashed add tile and New group,
  empty board with a drawn board and two actions. Geist and Geist Mono added to
  `assets/fonts/`. Picking Modern follows the phone between Daylight and
  Midnight, as Classic follows light and dark.
- ☑ **L3-3 Clean titles** — `cleanTitle()` in `looks/text.ts`, tested.
- ◐ **L3-4 Card menu** — *changed from the design:* the card's menu is the look's
  bottom sheet (icons for Open / Move to group… / Remove), headed by the clean
  title with the real file name beneath, rather than a popover over the lifted
  card. A popover needs the card's position passed up through every look; the
  sheet keeps Classic's back-button handling for free. Revisit if it matters.

## L4 — Modern: reader, sheets, search — ☑ built (device check pending)

- ☑ **L4-1 Reader top bar** — *changed 2026-11-02 at the user's request:* every
  look now uses Classic's bar — back · **File** [title ▾] · **Group** [● name ▾]
  · ⋯ — drawn in the look's colours, type and corners (`Picker` in
  layout.tsx). The breadcrumb and the separate Aa button are gone; Display is in
  the ⋯ menu, as in Classic. Checked on device: File → Jump to file, Group →
  Switch group.
- ☑ **Equal pickers and Look in ⋯** (2026-11-02, user request) — File and Group
  are the same width in every look *and in Classic* (Classic's File used to take
  1.35 shares). The reader's ⋯ menu, in every look and Classic, ends with
  **Look**, which opens the same picker as the board (`lookSheetActions` in
  registry.ts); Find in document, Chapters and Display are unchanged. The status
  bar now takes dark icons over a light look's reader bar (it was always light,
  which suits only Classic's black bar). All checked on device.
- ☑ **L4-2 Reader bottom bar** — previous / next file names, a scrubber in the
  group colour, "File 2 of 106 · page 3 of 9".
- ☑ **L4-3 Sheets** — [looks/sheets.tsx](src/looks/sheets.tsx), **shared by all
  four looks** through the skin: an action sheet with icon tiles and one-line
  descriptions (New group, Library, card and group menus, Look), Jump to file
  with numbers, mono sizes, an accent bar + check on the current file and a
  filter for groups over eight files, and Switch group with colours and counts.
  Same actions as Classic throughout. Move to group keeps `MoveSheet` (already
  themed); the reader's ⋯ popover keeps its glyphs.
- ☑ **L4-4 Search** — `LookSearch`: the same FTS query and paging, results
  grouped under their group's colour with the matched text in the accent, the
  real file name beneath. The field takes the look's shape (filled, underline,
  pill, prompt) and the placeholder carries the count ("Search 167 files").

## L5 — Reading — ☑ built (device check pending)

- ☑ **L5-1 Page themes** — `mist` and `dusk` added to `ReaderTheme`. In a look
  the page uses the redesign's reading palettes (page, ink, link, code); in
  Classic `viewerSettings` computes exactly what it did, and draws a stored
  mist/dusk as light/dark.
- ☑ **L5-2 Reading fonts** — Literata, Source Serif 4, Atkinson Hyperlegible,
  Geist, JetBrains Mono. [readingFontLoader.ts](src/looks/readingFontLoader.ts)
  reads two faces from the APK (`asset:///fonts/…`, put there by the expo-font
  plugin — no second copy), caches the base64, and the renderer sends one
  `{type:'font'}` message per font per page load. The viewer installs it as a
  style element; the CSP already allowed `font-src data:` and is unchanged, as
  are the WebView props. `--sr-font`, `--sr-link` and `--sr-code` fall back to
  the viewer's previous values, so Classic renders as before (pinned in
  `lookReading.test.ts`).
- ☑ **L5-3 Display sheet** — `DisplaySheet`: font row, size, line spacing and
  margins as steppers (today's ranges and steps), seven page themes, Reset.
  Classic keeps `ReaderSettingsSheet`.
- ☑ PDFs keep today's behaviour (page themes do not apply to pdfium yet —
  ROADMAP's "PDF night mode").

**Device checks for L3–L5** (with the L6–L8 list below): Modern in light and
dark; each sheet in each look; change reading font and page theme with a long
EPUB open — the position must hold across the re-flow; switch back to Classic
mid-document and confirm the page returns to its old font and colours.

## L6–L8 — Notebook, Shelf, Terminal — ☑ built (device check pending)

How a look plugs in — [looks/skin.ts](src/looks/skin.ts) is the contract:

- **Board:** `LibraryScreen` picks the skin (`useSkin()`, undefined in
  Classic) and branches the header, empty state and New group footer.
  `GroupRow` takes an optional `skin` (header, card, add tile) and keeps its own
  rename, windowing and drag logic; `DraggableCard` takes an optional `Card`.
  Look cards keep the 132 + 12 slot the drag maths uses.
- **Cards** use [looks/useCard.ts](src/looks/useCard.ts): the same store
  subscription, thumbnail, snippet, live progress and measured open as FileCard.
  Titles are cleaned (`cleanTitle`, tested), numbers are positions in the group.
- **Reader:** `ReaderScreen` swaps the top bar (breadcrumb: group → Switch
  group, title → Jump to file, Aa → Display, ⋯ → the existing menu) and the
  dots (each look's own position bar). Same sheets, same 52dp bar height, so
  search and the popover still line up.
- **Sheets and search** take the look's type through `useLookFonts()`
  (ActionSheet, LibrarySearch); layout unchanged.
- **Picking a look:** board ⋯ → **Look…** → Classic / Notebook / Shelf /
  Terminal. Each opens in its home theme (Paper, Ember, Terminal). This stands
  in for the Appearance screen (L2).

**One layout for every look** (decided 2026-11-02, "same layout throughout").
Every look uses Modern's layout on every screen — board, cards, group headers,
empty board, reader bars, sheets, search — built by `makeLayout()` in
[looks/layout.tsx](src/looks/layout.tsx). A look is now only:

| Look | Fonts (title / body / numbers) | Corner | Home theme |
|---|---|---|---|
| Modern | Geist / Geist / Geist Mono | 14 | Daylight ↔ Midnight |
| Notebook | Fraunces / Literata / IBM Plex Mono | 3 | Paper |
| Shelf | Instrument Serif (×1.18) / DM Sans / DM Sans | 12 | Ember |
| Terminal | JetBrains Mono (×0.9) throughout | 2 | Terminal |

[notebook.tsx](src/looks/notebook.tsx), [shelf.tsx](src/looks/shelf.tsx),
[terminal.tsx](src/looks/terminal.tsx) and [modern.tsx](src/looks/modern.tsx)
are each a twenty-line spec. The earlier per-look layouts (ruled paper and
index cards, book covers on planks, terminal cards and status line) were
removed, as were the five fonts only they used. Ember's group colours were
lifted from dark book-cloth to colours that read as chips and progress lines on
its dark board. Classic is unchanged.

The Figma sheet (design/redesign-plugin) still shows the earlier per-look
layouts on page 2; it is the design history, not the spec, for L6–L8.

- ☑ **L6 Notebook**, ☑ **L7 Shelf**, ☑ **L8 Terminal** — on the shared layout;
  checked on device (Notebook, Shelf, Terminal board; Notebook and Terminal
  reader; both pickers from the breadcrumb and the ⋯ menu).

**On-device checklist** (after the rebuild):

- ☐ Classic looks and behaves exactly as before, cold start included.
- ☐ Each look: board, empty board, rename a group, drag-reorder, card ⋯ menu,
  group ⋯ menu, New group, search, open a file, swipe, breadcrumb → both
  sheets, Aa → Display, ⋯ → menu, back.
- ☐ Fonts render as the named faces (not the system font) — if they don't, the
  rebuild didn't pick up the expo-font plugin.
- ☐ Switching look and back again while the app is running; force-quit and
  relaunch keeps the choice.

**Known gaps, left for later:** TocSheet, MoveSheet and the reader's ⋯
PopoverMenu keep the system font and glyphs; the card menu is a sheet, not a
popover (L3-4); colour themes other than each look's own are not pickable until
the Appearance screen (L2).


## Motion — ☑ two fixes (2026-11-02, checked on device by screen recording)

- ☑ **No navy flash when closing the reader.** The board now mounts the moment
  the close starts (App.tsx), so the reader folds back into its card over the
  real board. The navy was the Android window background showing through once
  the fold's backdrop had faded and before the board came back. The board also
  remembers its scroll position across the reader (LibraryScreen), so the fold
  lands where the card actually is — this applies to Classic too.
- ☑ **Cross-fade on look / theme change.** [ui/ThemeVeil.tsx](src/ui/ThemeVeil.tsx)
  lays the old background colour over the screen in the same commit as the new
  theme and fades it out over 260 ms. Also fires when the phone switches
  between light and dark. Off with "Remove animations".
- ☑ **Return ring** — the card for the file you were last reading (tracked as
  you swipe, [store/lastRead.ts](src/store/lastRead.ts)) gets a 2px ring in its
  group colour that fades over ~1s when the board comes back. Only on that
  return, never on a later scroll past.
- ☑ **Progress lines grow** — look cards remember what they last showed
  ([looks/shownProgress.ts](src/looks/shownProgress.ts), cleared through
  lifecycle.ts) and ease to the new value after the fold (220ms delay, 260ms).
- ☑ **Bottom bar follows the swipe** — the looks' scrubber reads the pager's
  live position on the UI thread, as Classic's dots do. Checked on device: the
  thumb moves continuously during a slow swipe (file 2 → 3 of 15) while the
  "File 2 of 15" caption only changes once the swipe commits.
- ☑ **Sheet rows fade in** — 180ms fade, 24ms apart, capped at eight rows.
- All timed and eased; no springs or bounces. Looks only; Classic unchanged.
- ☐ Suggested, not done: recolour the Android window per theme (expo-system-ui,
  needs a rebuild); predictive back (Android 14+).

## L9 — Pro for real — ☐

ROADMAP §6, unchanged: RevenueCat (`react-native-purchases`), one `pro`
entitlement, one-time unlock; `usePro()` backed by RevenueCat with an MMKV
cache; the real paywall sheet (price from Play, Restore purchases); privacy
policy and Data safety updated; licence-tester checklist. The dev switch stays
dev-only.
