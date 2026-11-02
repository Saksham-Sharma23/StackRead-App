// ================================================= PAGE 1 · FOUNDATIONS ===
function buildCover() {
  const cover = AL('V', { n: 'Cover', w: 1600, p: 96, gap: 56, fill: D.bg })
  add(cover, T('STACKREAD  ·  ANDROID  ·  UI REDESIGN  ·  NOVEMBER 2026', { f: 'monoM', s: 13, ls: 8, c: D.acc }))
  const title = T('A reader that looks like\nwhat you are reading.', { f: 'frL', s: 84, lh: 88, ls: -2, c: D.ink, n: 'Title' })
  title.setRangeFontName(25, title.characters.length, { family: 'Fraunces', style: 'Light Italic' }); add(cover, title)
  add(cover, T('Nothing about how StackRead works changes here: the board, groups-as-labels, swiping between files in a row, the reader, the sheets. This file changes how it looks, and adds one new screen — Appearance — where you pick a look and a colour theme. Every colour is a variable in the “StackRead colour” collection, and the first nine roles of each theme map one-to-one onto src/ui/theme.ts.', { s: 19, lh: 30, c: D.dim, w: 920 }))
  const how = AL('H', { n: 'How to read', gap: 24 }); add(cover, how); fw(how)
  for (const [k, h, b] of [
    ['Page 1', 'Direction & foundations', 'What reads as generic today and why, the eight colour themes, type for each look, icons, format marks and group colours.'],
    ['Page 2', 'Looks & screens', 'The four looks side by side on the same library, then every screen — board, empty board, search, menus, sheets, reader — in each look.'],
    ['Page 3', 'Reading, themes & appearance', 'The reading surface, six page themes and five reading fonts, the Display sheet, the Appearance picker, and the board in every colour theme.']]) {
    const c = AL('V', { gap: 10, p: [24, 24, 28, 24], stroke: D.line, r: 4, fill: D.card, n: k }); add(how, c); c.layoutGrow = 1; fh(c)
    add(c, T(k.toUpperCase(), { f: 'monoM', s: 12, ls: 6, c: D.acc }), T(h, { f: 'frS', s: 26, lh: 32, c: D.ink })); const bt = T(b, { s: 15, lh: 23, c: D.dim }); add(c, bt); fw(bt)
  }
  add(cover, T('Four principles', { f: 'frS', s: 34, c: D.ink }))
  const pr = AL('H', { gap: 32, n: 'Principles' }); add(cover, pr); fw(pr)
  for (const [n, h, b] of [
    ['01', 'The file is the cover', 'A card shows the document’s own position, title and format — not a grey paragraph and a blue pill. You find “03 · Your first Spring app” by its number, not by reading a snippet.'],
    ['02', 'Every group has a colour', 'A group picks one of five colours. It marks the group label, the progress on its cards and the breadcrumb in the reader, so you always know which row you are in.'],
    ['03', 'Reading chrome steps back', 'The reader’s top bar becomes one breadcrumb. Position is a thin scrubber that says “2 / 106” instead of a row of twelve dots.'],
    ['04', 'Character from type, not effects', 'Each look commits to a type pairing and a material — paper, cloth, phosphor. No glass, no glow, no gradients: personality comes from typography, rules and colour.']]) {
    const c = AL('V', { gap: 12, n: 'Principle ' + n }); add(pr, c); c.layoutGrow = 1
    add(c, RC(40, 3, D.acc), T(n, { f: 'mono', s: 13, c: D.dim }), T(h, { f: 'frS', s: 22, lh: 28, c: D.ink })); const bt = T(b, { s: 15, lh: 23, c: D.dim }); add(c, bt); fw(bt)
  }
  return cover
}
function buildCritique() {
  const cr = docFrame('Critique', 'WHAT READS AS GENERIC TODAY', 'Ten things from the current screenshots, each with the change that replaces it.', '“Feels AI-generated” is mostly a lack of decisions: system font, default blue, every element the same weight. Each item below is a decision the redesign makes instead.')
  const items = [
    ['Cards are interchangeable', 'Every card is a grey block of snippet text with a blue “MD” pill. In a 106-file row nothing stands out, so you read paragraphs to find a file.', 'Big position number, clean title, format as a small typographic mark. The snippet drops to three lines of secondary text.'],
    ['File names break mid-word', '“02-install-jdk-and-t / ools.md” — the raw slug wraps wherever the width runs out.', 'Show “Install JDK and Tools”: the first heading, else the file name without number, dashes and extension. The real name stays in the card menu.'],
    ['Groups have no identity', '“JavaSpringBootNotes 106” is a line of text; both rows on the board look identical.', 'A colour per group: a chip or tape on the label, the progress bar on each card, the dot in the reader’s breadcrumb.'],
    ['The header takes a third of the screen', 'A 34pt wordmark, a subtitle and a search field before the first card.', 'A compact top bar. The count moves into the search placeholder: “Search 167 files”.'],
    ['The reader’s top bar reads like a form', '“File [01-prerequisites… ▾]  Group [JavaS… ▾]” — two labelled dropdowns, both names truncated.', 'One breadcrumb: group dot · group name over the file title. The group opens Switch group, the title opens Jump to file — same sheets as today.'],
    ['Page dots don’t scale', 'Twelve dots stand in for 106 files and sit on top of the text.', 'A thin scrubber, “2 / 106”, with the previous and next file named either side. It shows and hides with the rest of the chrome.'],
    ['Sheets mark state with words', '“01-prerequisites.md  (current)” in grey; sizes in a proportional font that can’t align.', 'The current row gets an accent bar and a check; sizes right-aligned in mono; the group colour leads the header.'],
    ['The empty board looks like it’s loading', 'Eight empty grey tiles read as a skeleton screen, not an illustration.', 'A small drawn board that shows rows and the swipe, then two clear actions: Add files, Import a folder or ZIP.'],
    ['Default type and colour', 'Roboto + #4C8DFF on near-black is the platform’s default dark template — the strongest “generated” signal there is.', 'Each look commits to its own pairing: Geist, Fraunces + Literata, Instrument Serif + DM Sans, JetBrains Mono.'],
    ['Icons are text glyphs', 'The search icon is ⌕ (U+2315) and the chevron ⌄ (U+2304); neither is in Roboto, so they fall back to a symbol font and need nudging.', 'One 24dp stroke icon set at 1.75 stroke, drawn for this app (see Icons, below).'],
  ]
  const grid = AL('V', { gap: 20, n: 'Critique grid' }); add(cr, grid); fw(grid)
  for (let i = 0; i < items.length; i += 2) {
    const row = AL('H', { gap: 20, n: 'row' }); add(grid, row); fw(row)
    for (const j of [i, i + 1]) {
      const it = items[j]
      const c = AL('H', { gap: 24, p: 28, stroke: D.line, r: 4, fill: D.card, n: 'Issue ' + (j + 1) }); add(row, c); c.layoutGrow = 1; fh(c)
      add(c, T(String(j + 1).padStart(2, '0'), { f: 'frL', s: 44, lh: 44, c: D.acc }))
      const col = AL('V', { gap: 10, n: 'text' }); add(c, col); col.layoutGrow = 1
      add(col, T(it[0], { f: 'frS', s: 22, lh: 28, c: D.ink }))
      for (const [lab, txt, colr] of [['TODAY', it[1], D.dim], ['CHANGE', it[2], D.ink]]) {
        const l = AL('H', { gap: 12 }); add(col, l); fw(l)
        const lt = T(lab, { f: 'monoM', s: 11, ls: 6, c: lab === 'TODAY' ? D.dim : D.acc, w: 64 }); add(l, lt)
        const t = T(txt, { s: 14, lh: 21, c: colr }); add(l, t); t.layoutGrow = 1; t.textAutoResize = 'HEIGHT'
      }
    }
  }
  return cr
}
function buildThemes() {
  const sec = docFrame('Colour themes', 'COLOUR THEMES', 'Eight app themes. Any look works with any theme.', 'A theme is the same 17 roles every time. theme.ts already has nine of them (bg, surface, surfaceAlt → raised, border → line, fg → ink, fgDim → ink2, fgFaint → ink3, accent, danger). New: onAccent, rule and margin (Notebook’s ruled lines) and five group colours. Each look has a home theme, but the picker lets you combine freely — Notebook in Midnight reads as blueprint paper.')
  const META = {
    Midnight: ['Default dark · Modern', 'The navy sampled from the splash tile, carried into the board so launch and library feel like one surface.'],
    Daylight: ['Default light · Modern', 'Warm off-white instead of blue-grey, so white cards read as paper rather than a web form.'],
    Paper: ['Home of Notebook', 'Cream stock, ink-blue accent, washi-tape pastels for group colours.'],
    Sepia: ['Low-glare light', 'For long evening sessions. Rust accent, earthy group colours, nothing pure white.'],
    Forest: ['Dark, not blue', 'Moss greens with warm group colours, for anyone tired of navy dark modes.'],
    Ember: ['Home of Shelf', 'Walnut dark with a gold accent; group colours are book-cloth — oxblood, navy, bottle green.'],
    Terminal: ['Home of Terminal', 'Phosphor green on near-black. Made for the code notes this library is full of.'],
    OLED: ['True black', 'Pixels off on AMOLED. Amber accent keeps blue light down for reading in bed.'],
  }
  const sets = [['bg', 'surface', 'raised', 'line', 'rule'], ['ink', 'ink2', 'ink3', 'accent', 'danger'], ['g1', 'g2', 'g3', 'g4', 'g5']]
  const sw = role => { const c = AL('V', { gap: 5, n: role }); add(c, RC(54, 40, role, { r: 6, stroke: '#000000', so: 0.08 }), T(role, { f: 'monoM', s: 10, c: D.ink }), T(tokenHex(TH + '/' + role), { f: 'mono', s: 10, c: D.dim })); return c }
  const grid = AL('V', { gap: 24, n: 'Theme grid' }); add(sec, grid); fw(grid)
  let row
  Object.keys(META).forEach((name, i) => {
    TH = name
    if (i % 4 === 0) { row = AL('H', { gap: 24, n: 'row' }); add(grid, row); fw(row) }
    const card = AL('V', { gap: 16, p: [20, 20, 24, 20], stroke: D.line, r: 6, fill: D.card, n: 'Theme / ' + name }); add(row, card); card.layoutGrow = 1; fh(card)
    const s = AL('V', { gap: 10, p: 16, r: 4, fill: 'bg', clip: true, n: 'Live sample' }); add(card, s); fw(s)
    const gh = AL('H', { gap: 8, ai: 'CENTER' }); add(s, gh); add(gh, RC(10, 10, 'g1', { r: 3 }), T('JavaSpringBootNotes', { f: 'uiS', s: 13 }), T('106', { f: 'mono', s: 11, c: 'ink3' }))
    const cards = AL('H', { gap: 8 }); add(s, cards)
    for (const [n, t, p] of [['01', 'Prerequisites', 1], ['02', 'Install JDK and Tools', 0.35], ['03', 'Your first Spring app', 0]]) {
      const c = AL('V', { gap: 4, p: [10, 8, 0, 8], w: 96, h: 92, r: 8, fill: 'surface', stroke: 'line', clip: true, n: 'card ' + n }); add(cards, c)
      add(c, T(n, { f: 'mono', s: 10, c: 'ink3' })); const tt = T(t, { f: 'uiS', s: 11, lh: 14 }); add(c, tt); fw(tt)
      if (p > 0) { at(c, RC(96, 3, 'line'), 0, 89); at(c, RC(96 * p, 3, 'g1'), 0, 89) }
    }
    const bt = AL('H', { gap: 8 }); add(s, bt)
    const b1 = AL('H', { p: [8, 14], r: 999, fill: 'accent' }); add(b1, T('Add files', { f: 'uiS', s: 12, c: 'onAccent' }))
    const b2 = AL('H', { p: [8, 14], r: 999, fill: 'raised', stroke: 'line' }); add(b2, T('Remove', { f: 'uiM', s: 12, c: 'danger' })); add(bt, b1, b2)
    const hd = AL('V', { gap: 4 }); add(card, hd); fw(hd)
    const tr = AL('H', { gap: 10, ai: 'BASELINE' }); add(hd, tr); add(tr, T(name, { f: 'frS', s: 24, c: D.ink }), T(META[name][0].toUpperCase(), { f: 'monoM', s: 10, ls: 5, c: D.acc }))
    const d = T(META[name][1], { s: 13, lh: 19, c: D.dim }); add(hd, d); fw(d)
    for (const set of sets) { const r = AL('H', { gap: 10 }); add(card, r); fw(r); set.forEach(k => add(r, sw(k))) }
  })
  subhead(sec, 'Reading themes', 'Page colours for the reader, kept separate from the app theme because they serve the document, not the brand. Today’s four (Light, Sepia, Dark, Black) become six; “Auto” still follows the system. These are the existing reader themes in WebViewRenderer, re-tuned — not new rendering.')
  const rr = AL('H', { gap: 20, n: 'Reading themes' }); add(sec, rr); fw(rr)
  for (const [n, note] of [['Paper', 'was Light — off-white, not #FFF'], ['Sepia', 'kept, slightly less yellow'], ['Mist', 'new · grey-green, softer than white'], ['Dusk', 'new · blue-grey dark'], ['Night', 'was Dark'], ['OLED', 'was Black — ink lowered to cut glare']]) {
    const k = x => `Reading/${n}/${x}`
    const c = AL('V', { gap: 10, p: [20, 18, 22, 18], r: 6, fill: k('page'), stroke: '#000000', so: 0.1, n: 'Reading / ' + n }); add(rr, c); c.layoutGrow = 1
    add(c, T('Aa', { f: 'lit', s: 40, lh: 44, c: k('ink') }))
    const b = T('Before installing anything, make sure you have the right mental model.', { f: 'lit', s: 13, lh: 20, c: k('ink') }); add(c, b); fw(b)
    const l = AL('H', { gap: 6, ai: 'CENTER' }); add(c, l); add(l, T('a link', { f: 'litS', s: 12, c: k('link'), deco: 'UNDERLINE' })); const code = AL('H', { p: [2, 6], r: 4, fill: k('code') }); add(code, T('JAVA_HOME', { f: 'mono', s: 11, c: k('ink') })); add(l, code)
    add(c, T(n, { f: 'uiS', s: 13, c: k('ink') }), T(note, { f: 'mono', s: 10, lh: 14, c: k('ink2'), w: 180 }))
  }
  return sec
}
function buildType() {
  const sec = docFrame('Typography', 'TYPOGRAPHY', 'One type system per look — each a decision, none of them the system default.', 'Every family here is free (SIL OFL) and ships with expo-font, about 1.4 MB for all of them; a look only loads its own. Sizes sit on the 7-role scale from the earlier token proposal (display, title, heading, body, label, meta), so the four looks differ in voice, not in structure.')
  const looks = [
    ['Modern', 'Geist · Geist Mono', 'Geometric but warm; the mono carries numbers and formats so they align in columns.', [
      ['Display', 'StackRead', 'uiS', 28, 34, -2, 'Geist SemiBold 28/34'], ['Heading', 'JavaSpringBootNotes', 'uiS', 17, 22, -1, 'Geist SemiBold 17/22'], ['Card title', 'Install JDK and Tools', 'uiS', 15, 19, -1, 'Geist SemiBold 15/19'], ['Body', 'Step-by-step install instructions for Windows, macOS and Linux.', 'ui', 13, 19, 0, 'Geist Regular 13/19'], ['Meta', '02  ·  MD  ·  7.2 KB', 'monoM', 11, 14, 6, 'Geist Mono Medium 11/14 +6%'], ['Button', 'Add files', 'uiS', 15, 20, 0, 'Geist SemiBold 15']]],
    ['Notebook', 'Fraunces · Literata · IBM Plex Mono · Caveat', 'A soft serif for titles, a book face for text sitting on 18px rules, a typewriter mono for labels — and handwriting only for notes in the margin.', [
      ['Display', 'StackRead', 'frSI', 30, 36, -2, 'Fraunces SemiBold Italic 30/36'], ['Tape label', 'JAVASPRINGBOOTNOTES', 'plexS', 11, 14, 8, 'IBM Plex Mono SemiBold 11 caps +8%'], ['Card title', 'Install JDK and Tools', 'frS', 15, 18, 0, 'Fraunces SemiBold 15/18'], ['Body', 'Step-by-step install instructions for Windows, macOS and Linux.', 'lit', 11, 18, 0, 'Literata Regular 11/18 — on the rule'], ['Meta', 'md  ·  7.2 KB', 'plexM', 10, 14, 4, 'IBM Plex Mono Medium 10'], ['Margin note', '35% read', 'cav', 18, 20, 0, 'Caveat Regular 16–20 — notes only']]],
    ['Shelf', 'Instrument Serif · DM Sans', 'A display serif with real contrast for the covers; a plain grotesque so the chrome never competes with them.', [
      ['Display', 'StackRead', 'insI', 36, 40, -1, 'Instrument Serif Italic 36/40'], ['Shelf name', 'JavaSpringBootNotes', 'ins', 24, 28, 0, 'Instrument Serif Regular 24'], ['Cover title', 'Install JDK and Tools', 'ins', 18, 20, 0, 'Instrument Serif 18/20, centred'], ['Body', 'Step-by-step install instructions for Windows, macOS and Linux.', 'dm', 13, 19, 0, 'DM Sans Regular 13/19'], ['Meta', 'MD · 7.2 KB', 'dmM', 9, 12, 12, 'DM Sans Medium 8–9 caps +12%'], ['Button', 'Add files', 'dmS', 15, 20, 0, 'DM Sans SemiBold 15']]],
    ['Terminal', 'JetBrains Mono', 'One family, four weights. Raw file names stay raw — in this look they are the point.', [
      ['Prompt', '~/stackread $ ls', 'jbB', 16, 20, 0, 'JetBrains Mono Bold 16'], ['Group', '[JavaSpringBootNotes]', 'jbB', 14, 18, 0, 'JetBrains Mono Bold 14'], ['Card title', '02-install-jdk-and-tools.md', 'jbM', 11, 15, 0, 'JetBrains Mono Medium 11/15'], ['Body', '// Step-by-step install instructions for Windows, macOS and Linux.', 'jb', 10, 15, 0, 'JetBrains Mono Regular 10/15'], ['Progress', '[███·····] 35%', 'jb', 11, 14, 0, 'block characters, group colour'], ['Status', 'READ  02/106', 'jbB', 11, 14, 0, 'JetBrains Mono Bold 11']]],
  ]
  const r = AL('H', { gap: 24, n: 'Columns' }); add(sec, r); fw(r)
  for (const [name, fams, why, roles] of looks) {
    const c = AL('V', { gap: 18, p: 28, fill: D.card, stroke: D.line, r: 6, n: 'Type / ' + name }); add(r, c); c.layoutGrow = 1; fh(c)
    add(c, T(name, { f: 'frS', s: 28, c: D.ink })); const fm = T(fams, { f: 'monoM', s: 11, lh: 16, ls: 4, c: D.acc }); add(c, fm); fw(fm)
    const wt = T(why, { s: 13, lh: 20, c: D.dim }); add(c, wt); fw(wt)
    add(c, RC(10, 1, D.line)); c.children[c.children.length - 1].layoutSizingHorizontal = 'FILL'
    for (const [role, sample, f, s, lh, ls, spec] of roles) {
      const row = AL('V', { gap: 4 }); add(c, row); fw(row)
      add(row, T(role.toUpperCase(), { f: 'monoM', s: 10, ls: 8, c: D.dim }))
      const t = T(sample, { f, s, lh, ls, c: D.ink }); add(row, t); fw(t)
      add(row, T(spec, { f: 'mono', s: 10, c: D.dim }))
    }
  }
  return sec
}
function buildIcons() {
  const sec = docFrame('Icons & marks', 'ICONS, MARKS, GROUP COLOUR, SHAPE', 'The small things that make it feel drawn rather than assembled.', null)
  subhead(sec, 'Icons', 'One stroke set on a 24dp grid, 1.75 stroke, round caps and joins. They replace the text glyphs (⌕ ⌄ ☰ ⋯) so nothing falls back to a symbol font. In code: react-native-svg paths, one component, colour from the theme. Shown at 28dp.')
  const g = AL('H', { gap: 12, n: 'Icon grid' }); add(sec, g); fw(g); g.layoutWrap = 'WRAP'; g.counterAxisSpacing = 12
  for (const k of Object.keys(IC)) { const t = AL('V', { w: 108, h: 96, gap: 10, ai: 'CENTER', jc: 'CENTER', fill: D.card, stroke: D.line, r: 6, n: 'Icon / ' + k }); add(t, I(k, 28, D.ink), T(k, { f: 'mono', s: 11, c: D.dim })); add(g, t) }
  subhead(sec, 'Format marks', 'The format is metadata, so it is set like metadata: small, in the look’s label face, never a coloured pill. Colour is reserved for the group.')
  const fm = AL('V', { gap: 0, fill: D.card, stroke: D.line, r: 6, n: 'Format marks' }); add(sec, fm); fw(fm)
  const fmts = ['PDF', 'EPUB', 'MD', 'DOCX', 'XLSX', 'CBZ', 'IMG', 'ZIP', 'TXT', 'HTML']
  const looks = [['Modern', 'monoM', x => x, 6], ['Notebook', 'plexM', x => x.toLowerCase(), 4], ['Shelf', 'dmM', x => x, 14], ['Terminal', 'jbM', x => '.' + x.toLowerCase(), 0]]
  for (const [name, f, tx, ls] of looks) { const r = AL('H', { gap: 0, p: [16, 24], ai: 'CENTER', n: name }); add(fm, r); fw(r); add(r, T(name, { f: 'frS', s: 18, c: D.ink, w: 160 })); for (const x of fmts) add(r, T(tx(x), { f, s: 12, ls, c: D.ink, w: 104 })) }
  subhead(sec, 'Group colour — one choice, three places', 'A group gets a colour when it is created (next free of five; changeable from the group’s ⋯ menu). It is the only colour on the board that is not the accent, so it carries identity without competing with actions.')
  const gr = AL('H', { gap: 24, n: 'Group colour uses' }); add(sec, gr); fw(gr)
  TH = 'Midnight'
  const ex = (title, build) => { const c = AL('V', { gap: 14, p: 24, fill: D.card, stroke: D.line, r: 6 }); add(gr, c); c.layoutGrow = 1; const stage = AL('H', { p: 20, r: 6, fill: 'bg', h: 232, ai: 'CENTER', jc: 'CENTER', n: 'stage' }); add(c, stage); fw(stage); build(stage); add(c, T(title, { f: 'uiS', s: 15, c: D.ink })) }
  ex('1 · The group label', st => { const h = AL('H', { gap: 10, ai: 'CENTER' }); add(st, h); add(h, RC(10, 10, 'g1', { r: 3 }), T('JavaSpringBootNotes', { f: 'uiS', s: 17 }), T('106', { f: 'mono', s: 12, c: 'ink3' })) })
  ex('2 · Progress on every card', st => { add(st, M.card(GROUPS[0].files[2], GROUPS[0])) })
  ex('3 · The breadcrumb while reading', st => { const v = AL('V', { gap: 2 }); add(st, v); const l = AL('H', { gap: 6, ai: 'CENTER' }); add(v, l); add(l, EL(7, 'g1'), T('JavaSpringBootNotes', { f: 'uiM', s: 12, c: 'ink2' }), I('down', 14, 'ink2')); add(v, T('02 · Install JDK and Tools', { f: 'uiS', s: 15 })) })
  ex('Five per theme, tuned to it', st => { const r = AL('H', { gap: 8 }); add(st, r); for (const k of ['g1', 'g2', 'g3', 'g4', 'g5']) add(r, RC(32, 32, k, { r: 8 })) })
  subhead(sec, 'Shape, space, motion', 'Spacing stays on the 4pt grid from the earlier token proposal. Radius belongs to the look: soft for Modern, almost none for paper and terminal. Motion keeps today’s springs; only press feedback is unified.')
  const sp = AL('H', { gap: 24, n: 'Shape' }); add(sec, sp); fw(sp)
  const box = (title, build) => { const c = AL('V', { gap: 14, p: 24, fill: D.card, stroke: D.line, r: 6 }); add(sp, c); c.layoutGrow = 1; fh(c); add(c, T(title, { f: 'frS', s: 20, c: D.ink })); build(c) }
  box('Spacing · 4pt', c => { for (const n of [4, 8, 12, 16, 20, 24, 32]) { const r = AL('H', { gap: 12, ai: 'CENTER' }); add(c, r); add(r, T(String(n), { f: 'mono', s: 11, c: D.dim, w: 24 }), RC(n * 4, 10, D.acc, { r: 2 })) } })
  box('Radius by look', c => { for (const [n, rr] of [['Modern · card 14 · field 12 · chip 999', 14], ['Shelf · cover 2/5 · pill 999', 5], ['Notebook · 0–3', 2], ['Terminal · 2', 2]]) { const r = AL('H', { gap: 12, ai: 'CENTER' }); add(c, r); add(r, RC(40, 40, null, { r: rr, stroke: D.ink, sw: 1.5 }), T(n, { s: 13, c: D.dim })) } })
  box('Motion', c => { for (const [k, v] of [['Press', 'scale 0.97 · 100 ms · every tappable'], ['Selection', 'border + lift, 180 ms spring'], ['Sheets', 'existing spring, unchanged'], ['Pager', 'existing gesture, unchanged'], ['Reduced motion', 'cross-fade only']]) { const r = AL('H', { gap: 12 }); add(c, r); fw(r); add(r, T(k, { f: 'uiS', s: 13, c: D.ink, w: 110 })); const t = T(v, { s: 13, c: D.dim }); add(r, t); t.layoutGrow = 1; t.textAutoResize = 'HEIGHT' } })
  return sec
}
