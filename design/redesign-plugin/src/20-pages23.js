// ======================================================= DISPLAY SHEET ===
// The reader's "Display" sheet: today's four controls, re-laid out, plus a
// font row (new) and two more page themes.
M.display = (theme, rt, st = {}) => {
  const S = Object.assign({ title: 'uiS', label: 'monoM', ls: 8, body: 'ui', base: M.reader }, st)
  const s = S.base(theme, rt); TH = theme; scrim(s, 0.3); const sh = sheet(s, 498)
  const pd = AL('V', { gap: 12, p: [4, 20, 0, 20] }); add(sh, pd); fw(pd)
  const hd = AL('H', { ai: 'CENTER' }); add(pd, hd); fw(hd); add(hd, T('Display', { f: S.title, s: 20, ls: -1 })); grow(hd); add(hd, T('Reset', { f: S.body === 'ui' ? 'uiM' : S.body, s: 14, c: 'accent' }))
  const label = (t, extra) => { const r = AL('H', { ai: 'CENTER' }); add(pd, r); fw(r); add(r, T(t, { f: S.label, s: 11, ls: S.ls, c: 'ink3', u: true })); if (extra) { grow(r); add(r, T(extra, { f: 'mono', s: 11, c: 'ink2' })) } }
  label('Font', 'new')
  const fr = AL('H', { gap: 7 }); add(pd, fr)
  for (const [name, f, sel] of [['Literata', 'lit', 1], ['Source Serif', 'ss'], ['Atkinson', 'atk'], ['Geist', 'ui'], ['Mono', 'jb']]) {
    const c = AL('V', { gap: 2, p: [8, 0], w: 58, ai: 'CENTER', r: 12, fill: 'raised', stroke: sel ? 'accent' : null, sw: 2, n: 'Font / ' + name }); add(fr, c)
    add(c, T('Aa', { f, s: 22, lh: 28 }), T(name, { f: 'ui', s: 10, c: sel ? 'accent' : 'ink2' }))
  }
  label('Size', '17')
  const sz = AL('H', { gap: 12, ai: 'CENTER' }); add(pd, sz); fw(sz)
  add(sz, T('A', { f: 'lit', s: 13, c: 'ink2' }))
  const tr = FR(250, 24, { clip: false, n: 'Slider' }); add(sz, tr); at(tr, RC(250, 4, 'raised', { r: 2 }), 0, 10); at(tr, RC(84, 4, 'accent', { r: 2 }), 0, 10); for (let i = 0; i <= 18; i++) at(tr, RC(1, 4, 'ink3', { o: 0.5 }), i * (250 / 18), 10); at(tr, EL(22, 'surface', { stroke: 'accent', sw: 2 }), 74, 1)
  add(sz, T('A', { f: 'lit', s: 22, c: 'ink2' }))
  const two = AL('H', { gap: 12 }); add(pd, two); fw(two)
  for (const [t, v, ic] of [['Line spacing', '1.65', 'spacing'], ['Margins', '22', 'margins']]) {
    const c = AL('V', { gap: 8 }); add(two, c); c.layoutGrow = 1
    add(c, T(t, { f: S.label, s: 11, ls: S.ls, c: 'ink3', u: true }))
    const st2 = AL('H', { h: 44, r: 12, fill: 'raised', ai: 'CENTER', p: [0, 4] }); add(c, st2); fw(st2)
    add(st2, textBtn('−', 'uiM', 'ink', 20)); grow(st2); add(st2, I(ic, 16, 'ink3')); gap(st2, 6); add(st2, T(v, { f: 'monoM', s: 14 })); grow(st2); add(st2, textBtn('+', 'uiM', 'ink', 20))
  }
  label('Page')
  const pg = AL('H', { gap: 5 }); add(pd, pg)
  const pages = [['Auto', null], ['Paper'], ['Sepia'], ['Mist'], ['Dusk'], ['Night'], ['OLED']]
  for (const [n] of pages) {
    const c = AL('V', { gap: 6, w: 40, ai: 'CENTER' }); add(pg, c)
    const sel = n === rt
    const d = FR(38, 38, { r: 19, fill: n === 'Auto' ? 'Reading/Paper/page' : `Reading/${n}/page`, stroke: sel ? 'accent' : 'line', sw: sel ? 2.5 : 1, n: 'Page / ' + n })
    if (n === 'Auto') at(d, RC(19, 38, 'Reading/Night/page'), 19, 0)
    else at(d, T('A', { f: 'litS', s: 14, c: `Reading/${n}/ink` }), 14, 9)
    add(c, d, T(n, { f: 'ui', s: 10, c: sel ? 'ink' : 'ink3' }))
  }
  return s
}

// ===================================================== PAGE 2 · SCREENS ===
function buildLooks() {
  const f = docFrame('Four looks', 'FOUR LOOKS · ONE LIBRARY', 'The same board, four ways. Pick one in Appearance; nothing else about the app changes.', 'Same three groups, same files, same gestures — horizontal swipe within a group, vertical scroll between groups. What changes is type, material and how much each card says. Each look is shown in its home colour theme.', 1872)
  phoneRow(f, [
    phone(M.board('Midnight'), 'Modern · Midnight', 'The default. Position number, clean title, three lines of snippet, a progress line in the group’s colour. Closest to today, with the decisions made.'),
    phone(NB.board('Paper'), 'Notebook · Paper', 'Index cards taped to ruled paper, each sitting on a second sheet — the stack in StackRead. Group names are washi tape; counts and progress are written in the margin.'),
    phone(SH_.board('Ember'), 'Shelf · Ember', 'Each group is a shelf; its files are a matching set of cloth-bound volumes in the group’s colour. A gold ribbon marks the ones you are part-way through.'),
    phone(TM.board('Terminal'), 'Terminal · Terminal', 'For a library of code notes. Raw file names, comments for snippets, block-character progress, and a prompt where the title was.')])
  return f
}
function buildModernScreens() {
  const f = docFrame('Modern screens', 'MODERN · EVERY SCREEN', 'Modern, screen by screen.', 'Midnight on the first row and the reader rows; Daylight at the end shows the same screens in light. All sheets are today’s sheets with today’s actions — only the layout and type change.', 2208)
  phoneRow(f, [
    phone(M.empty('Midnight'), 'Empty board', 'A drawn board explains rows and swipes instead of eight grey tiles. Two actions: Add files, or Import a folder or ZIP (opens the existing New group sheet).'),
    phone(M.searchScreen('Midnight'), 'Search', 'Results grouped by group with the group colour, matched text in the accent, file names in mono beneath. Same FTS5 name search as today.'),
    phone(M.cardMenu('Midnight'), 'Card menu', 'The pressed card lifts above the scrim so you can see what you are acting on. Same three actions: Open, Move to group…, Remove.'),
    phone(M.newGroup('Midnight'), 'New group', 'Each option says what will happen, so “Import ZIP as group…” no longer needs the ellipsis to explain itself.'),
    phone(M.librarySheet('Midnight'), 'Library (board ⋯)', 'Appearance is the one new entry, above backup and restore.')])
  phoneRow(f, [
    phone(M.reader('Midnight', 'Night'), 'Reader', 'One breadcrumb instead of two dropdowns. Previous and next file are named at the bottom; the scrubber replaces the dots and says where you are.'),
    phone(M.jumpSheet('Midnight', 'Night'), 'Jump to file', 'Tap the title. Current file marked with an accent bar and check, numbers and sizes in mono columns, and a filter for 100-file groups.'),
    phone(M.groupSheet('Midnight', 'Night'), 'Switch group', 'Tap the group name. Every group with its colour and count.'),
    phone(M.board('Daylight'), 'Board · Daylight', 'The same board in the light theme. Warm off-white, not blue-grey.'),
    phone(M.jumpSheet('Daylight', 'Paper'), 'Jump to file · Daylight', 'Light app theme over the Paper reading theme.')])
  return f
}
function buildNotebookScreens() {
  const f = docFrame('Notebook screens', 'NOTEBOOK · SCREENS', 'Notebook, screen by screen.', 'Ruled lines are on the board and the sheets, never under the text you read: the reader keeps a clean page and only borrows the margin rule for code blocks. The scrubber becomes a ruler of pages.', 1872)
  phoneRow(f, [
    phone(NB.empty('Paper'), 'Empty board', 'A sketch of three taped cards with margin notes, then one solid action and one underlined one.'),
    phone(NB.reader('Paper', 'Paper'), 'Reader', 'Breadcrumb as a tape strip over an italic title. The ruler counts pages in this file; the file position sits beside it.'),
    phone(NB.jump('Paper', 'Paper'), 'Jump to file', 'Rows on the rules, the current file under a highlighter stroke in the group’s colour.'),
    phone(M.display('Paper', 'Paper', { title: 'frSI', label: 'plexM', ls: 8, body: 'lit', base: NB.reader }), 'Display', 'The same Display sheet in Notebook type.')])
  return f
}
function buildShelfTerminalScreens() {
  const f = docFrame('Shelf and Terminal screens', 'SHELF · TERMINAL', 'Shelf and Terminal, the screens that differ most.', 'Sheets and menus in these looks reuse the Modern layouts with the look’s type, so only the board, empty state and reader are drawn here.', 1872)
  phoneRow(f, [
    phone(SH_.empty('Ember'), 'Shelf · Empty board', 'Two empty shelves and three leaning volumes. Rounded pill buttons in the gold accent.'),
    phone(SH_.reader('Ember', 'Sepia'), 'Shelf · Reader', 'Ember chrome over the Sepia page, Newsreader for text. “Volume 2 of 106” instead of “file”.'),
    phone(TM.empty('Terminal'), 'Terminal · Empty board', 'The explanation is a set of comments; the actions are keyed like a menu.'),
    phone(TM.reader('Terminal'), 'Terminal · Reader', 'Markdown shown with its markers in the accent, a vim-style status line for position.')])
  return f
}
// ================================================ PAGE 3 · READING & MORE ===
function buildReaderAnatomy() {
  const f = docFrame('Reader anatomy', 'THE READER', 'Less chrome, more page — and the chrome that stays says something.', 'Everything here exists today; it is reorganised, not added. Tap the page to show or hide the top and bottom bars, as now.', 1600)
  const r = AL('H', { gap: 64, n: 'Anatomy' }); add(f, r)
  const s = M.reader('Midnight', 'Night')
  const pin = (n, x, y) => { const p = AL('H', { w: 24, h: 24, r: 12, fill: D.acc, jc: 'CENTER', ai: 'CENTER', n: 'Callout ' + n }); add(p, T(String(n), { f: 'uiS', s: 12, c: '#FFFFFF' })); at(s, p, x, y) }
  pin(1, 52, 26); pin(2, 270, 26); pin(3, 316, 26); pin(4, 6, 672); pin(5, 6, 714); pin(6, 300, 748)
  add(r, phone(s, 'Reader · Midnight + Night', null))
  const lg = AL('V', { gap: 22, w: 760, n: 'Legend' }); add(r, lg)
  for (const [n, t, d] of [
    [1, 'Breadcrumb', 'Group colour, group name and ▾ on top — tap to Switch group. Position and file title below — tap to Jump to file. Replaces “File [▾] Group [▾]”, so neither name is cut to six letters.'],
    [2, 'Display (Aa)', 'Was inside the ⋯ menu. It is the reader’s most-used control, so it gets its own button.'],
    [3, '⋯ menu', 'Find in document and Chapters, as today.'],
    [4, 'Previous / next file', 'Names the neighbours you would swipe to. The swipe itself is unchanged.'],
    [5, 'Scrubber', 'Position in the group, in the group’s colour. Replaces PageDots — it reads the same at 3 files or 300.'],
    [6, 'Where you are', 'File and page in one line, in mono so the numbers don’t jump as they change.']]) {
    const it = AL('H', { gap: 18 }); add(lg, it); fw(it)
    const p = AL('H', { w: 28, h: 28, r: 14, fill: D.acc, jc: 'CENTER', ai: 'CENTER' }); add(p, T(String(n), { f: 'uiS', s: 13, c: '#FFFFFF' })); add(it, p)
    const v = AL('V', { gap: 4 }); add(it, v); v.layoutGrow = 1; add(v, T(t, { f: 'frS', s: 20, c: D.ink })); const dt = T(d, { s: 15, lh: 23, c: D.dim }); add(v, dt); fw(dt)
  }
  return f
}
function buildReadingThemes() {
  const f = docFrame('Reading themes', 'READING THEMES', 'Six page themes, each paired with the app theme that suits it.', 'Light pages sit under Daylight chrome and dark pages under Midnight, so the bars never fight the page. Pairing is automatic; both can still be set separately.', 2592)
  phoneRow(f, [['Paper', 'Daylight'], ['Sepia', 'Daylight'], ['Mist', 'Daylight'], ['Dusk', 'Midnight'], ['Night', 'Midnight'], ['OLED', 'OLED']].map(([rt, th]) => phone(M.reader(th, rt), rt, `${th} chrome · Reading/${rt}`)))
  return f
}
function buildReadingFonts() {
  const f = docFrame('Reading fonts', 'TEXT', 'Five reading fonts — chosen for long text on a phone, not for the board.', 'Today the reader has size, line spacing, margins and page colour. Adding a font choice is the one new reading control; each option below has a reason to exist.', 2240)
  const r = AL('H', { gap: 24, n: 'Specimens' }); add(f, r)
  const p = 'Before installing anything, make sure you have the right mental model and tools in place. This module is short on purpose — just enough to get unblocked.'
  for (const [name, fh_, fb, why] of [
    ['Literata', 'litS', 'lit', 'Designed for e-reading at Google Play Books. The default: sturdy serifs, open counters, made for exactly this.'],
    ['Source Serif 4', 'ssS', 'ss', 'Lighter and more classical. For PDFs-turned-text and long-form EPUBs.'],
    ['Atkinson Hyperlegible', 'atkB', 'atk', 'From the Braille Institute: every letter shaped to be told apart. For low vision, or tired eyes.'],
    ['Geist', 'uiS', 'ui', 'A clean sans for notes and docs — matches the Modern look.'],
    ['JetBrains Mono', 'jbB', 'jb', 'For code-heavy notes, where alignment matters more than flow.']]) {
    const c = AL('V', { gap: 14, w: 380, p: 28, fill: 'Reading/Paper/page', stroke: D.line, r: 6, n: 'Font / ' + name }); add(r, c); fh(c)
    add(c, T(name, { f: 'uiS', s: 13, c: D.acc }))
    add(c, T('Prerequisites', { f: fh_, s: 28, lh: 34, c: 'Reading/Paper/ink', w: 324 }))
    add(c, T(p, { f: fb, s: 17, lh: 28, c: 'Reading/Paper/ink', w: 324 }))
    add(c, RC(324, 1, D.line))
    add(c, T(why, { s: 13, lh: 20, c: D.dim, w: 324 }))
  }
  phoneRow(f, [
    phone(M.display('Midnight', 'Night'), 'Display sheet · Modern', 'Font row first, then today’s size, line spacing and margins as steppers, then seven page themes. Changes apply live, as now.'),
    phone(M.display('Daylight', 'Paper'), 'Display sheet · Daylight', 'Same sheet over a light page.')])
  return f
}
function buildAppearance() {
  const f = docFrame('Appearance', 'APPEARANCE · THE ONE NEW SCREEN', 'Pick a look, pick a colour theme. Both apply instantly.', 'Reached from the board’s ⋯ → Appearance. Look and theme are two independent choices stored in MMKV next to the reader settings; “Follow system” keeps today’s automatic light/dark behaviour by switching between a light and a dark theme of your choosing.', 1872)
  phoneRow(f, [
    phone(M.librarySheet('Midnight'), 'Entry point', 'Board ⋯ → Appearance.'),
    phone(M.appearance('Midnight'), 'Appearance · Modern', 'Look previews are drawn from each look’s home theme; the theme swatches are the real tokens.'),
    phone(M.appearance('Paper', { title: 'frSI', titleSize: 24, label: 'plexM', body: 'lit', name: 'frS', selLook: 'Notebook', selTheme: 'Paper', paper: true, r: 3 }), 'Appearance · Notebook', 'The screen takes on the look you are in.'),
    phone(M.appearance('Daylight', { selTheme: 'Daylight' }), 'Appearance · Daylight', 'Modern in the light theme.')])
  return f
}
function buildMatrix() {
  const f = docFrame('Every theme', 'EVERY THEME', 'Modern in all eight colour themes.', 'Same screen, only the theme tokens change — the check that every role holds up in every theme.', 3504)
  phoneRow(f, Object.keys(THEMES).map(t => phone(M.board(t), t, null)), 48)
  return f
}
function buildMix() {
  const f = docFrame('Mix and match', 'LOOK × THEME', 'Looks and themes combine freely.', 'A few combinations worth naming. Tape, cloth and progress colours come from the theme’s five group colours, and text on them flips between light and dark per theme so it stays readable.', 2240)
  phoneRow(f, [
    phone(NB.board('Midnight'), 'Notebook × Midnight', '“Blueprint” — ruled navy paper.'),
    phone(NB.board('Sepia'), 'Notebook × Sepia', '“Old journal”.'),
    phone(SH_.board('Daylight'), 'Shelf × Daylight', '“Reading room” — bright cloth on a pale wall.'),
    phone(TM.board('Daylight'), 'Terminal × Daylight', '“Printout”.'),
    phone(M.board('Forest'), 'Modern × Forest', 'A dark theme that isn’t navy.')])
  return f
}
