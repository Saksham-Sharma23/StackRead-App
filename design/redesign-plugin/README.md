# StackRead UI redesign — Figma sheet

Builds the redesign sheet into a Figma file: four selectable **looks**
(Modern, Notebook, Shelf, Terminal), eight **colour themes**, six **reading
themes**, five reading fonts, the new **Appearance** screen, and every existing
screen (board, empty board, search, card menu, sheets, reader) redrawn.

No app code changes here. This folder is design only.

Target file: <https://www.figma.com/design/7P4WuTpeVgA7D4B9j4NV1b>

`preview/` holds a PNG of every section, rendered from the same code, so you
can look without opening Figma.

## Why a plugin

Figma's MCP on the Starter plan allows only a few calls a month. They ran out
after the colour tokens, the three pages, the cover and the critique were
created. A development plugin has no such limit: it builds all 15 sections in
one run, and re-running it rebuilds them from scratch.

## Run it (once, ~30 s)

1. Open the **Figma desktop app** (development plugins don't run in the browser).
2. Open the target file above (any design file works; it makes its own pages).
3. Menu → **Plugins → Development → Import plugin from manifest…** → pick
   `design/redesign-plugin/manifest.json`.
4. Menu → **Plugins → Development → StackRead redesign sheet**.

A message at the bottom says how many sections were built, or lists anything
that failed. Running it again replaces every section whose name starts with
`NN · `; anything else on the pages is left alone.

## What it builds

| Page | Sections |
|---|---|
| 1 · Direction & Foundations | 00 Read me · 01 What reads as generic today · 02 Colour themes · 03 Typography · 04 Icons, marks, shape |
| 2 · Looks & Screens | 05 Four looks · 06 Modern — every screen · 07 Notebook — screens · 08 Shelf & Terminal — screens |
| 3 · Reading, Themes & Appearance | 09 Reader anatomy · 10 Reading themes · 11 Reading fonts & Display · 12 Appearance · 13 Every theme · 14 Mix and match |

Every colour is bound to a variable in the **StackRead colour** collection
(`Midnight/bg`, `Paper/accent`, `Reading/Night/page`, …). The Starter plan
allows one mode per collection, so themes are variable groups, not modes.

## Editing

Edit `src/*.js`, then:

```sh
node design/redesign-plugin/build.mjs   # writes code.js
```

and re-run the plugin. `code.js` is generated, so don't edit it by hand.

| File | Holds |
|---|---|
| `src/00-helpers.js` | tokens, fonts, layout helpers, the icon set, sample data |
| `src/01-common.js` | status bar, sheets, the shared reading sample |
| `src/02-modern.js` | Modern: board, empty, search, menus, sheets, reader, Appearance |
| `src/03-notebook.js` | Notebook |
| `src/04-shelf-terminal.js` | Shelf, Terminal, and the look previews |
| `src/10-page1.js`, `src/20-pages23.js` | the documentation sections |
| `src/99-main.js` | page layout and the run |

## Notes for implementation (later)

- **Tokens.** The first nine roles of each theme map onto `src/ui/theme.ts`:
  `surfaceAlt → raised`, `border → line`, `fg/fgDim/fgFaint → ink/ink2/ink3`.
  New roles: `onAccent`, `rule`, `margin`, `g1…g5`.
- **New state.** Look and theme are two values in MMKV, beside
  `readerSettings`. "Follow system" picks between a chosen light and dark theme,
  which preserves today's automatic behaviour.
- **Group colour.** A new field on the group (index 0–4). It is display-only,
  so it does not affect the group-is-a-label rule.
- **Card titles.** The clean title comes from the file's first heading, falling
  back to the file name without number, dashes or extension. The card number is
  the file's position in its group, so it agrees with the reader's "2 / 106".
- **New dependencies.** `react-native-svg` for the icons and `expo-font` for the
  type. Neither is installed yet, so adding them needs one native rebuild.
- **Reading font** is the only new reader control; the others (size, line
  spacing, margins, page theme) are today's, re-laid out.
