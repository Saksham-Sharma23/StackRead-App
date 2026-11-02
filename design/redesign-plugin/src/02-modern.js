// ================================================================ MODERN ===
// Geist + Geist Mono. Flat surfaces, hairlines, one accent, colour per group.
const M = {}
M.logo = () => { const f = FR(22, 22, { n: 'Logo', clip: false }); at(f, RC(13, 17, 'ink', { r: 3.5, o: 0.3 }), 8, 1); at(f, RC(13, 17, 'accent', { r: 3.5 }), 2, 4); return f }
M.top = (s, title = 'StackRead') => { const b = rowH(s, { h: 56, p: [0, 8, 0, 20], gap: 10, n: 'Top bar' }); add(b, M.logo(), T(title, { f: 'uiS', s: 19, ls: -1 })); grow(b); add(b, iconBtn('more')); return b }
M.search = (s, text, focused) => {
  const w = rowH(s, { p: [4, 20, 10, 20], n: 'Search' })
  const f = AL('H', { h: 46, r: 12, fill: 'raised', p: [0, 14], gap: 10, ai: 'CENTER', n: 'Field', stroke: focused ? 'accent' : null, sw: 1.5 }); add(w, f); fw(f)
  add(f, I('search', 18, focused ? 'ink2' : 'ink3')); add(f, T(text, { s: 15, c: focused ? 'ink' : 'ink3' }))
  return f
}
M.groupHead = (p, g) => { const h = rowH(p, { p: [18, 8, 10, 20], gap: 10, n: 'Group / ' + g.name }); add(h, RC(10, 10, g.c, { r: 3 }), T(g.name, { f: 'uiS', s: 17, ls: -1 }), T(String(g.count), { f: 'mono', s: 12, c: 'ink3' })); grow(h); add(h, iconBtn('more', 'ink3', 20)); return h }
M.card = (f, g) => {
  const c = AL('V', { w: 132, h: 188, r: 14, fill: 'surface', stroke: 'line', p: [12, 12, 14, 12], gap: 6, clip: true, n: 'Card / ' + f.title })
  const top = AL('H', { ai: 'CENTER' }); add(c, top); fw(top); add(top, T(f.no, { f: 'monoM', s: 11, c: 'ink3' })); grow(top); add(top, I('more', 16, 'ink3'))
  const t = T(f.title, { f: 'uiS', s: 15, lh: 19, ls: -1, max: 3 }); add(c, t); fw(t)
  if (f.snip) { const sn = T(f.snip, { s: 11, lh: 15, c: 'ink2', max: 3 }); add(c, sn); fw(sn) }
  grow(c)
  const ft = AL('H', { ai: 'CENTER', gap: 4 }); add(c, ft); fw(ft); add(ft, T(f.fmt, { f: 'monoM', s: 10, ls: 6, c: 'ink3' })); grow(ft)
  if (f.p >= 1) { add(ft, I('check', 12, g.c, 2.2), T('Read', { f: 'monoM', s: 10, c: g.c })) } else add(ft, T(f.size, { f: 'mono', s: 10, c: 'ink3' }))
  if (f.p > 0) { at(c, RC(132, 3, 'line'), 0, 185); at(c, RC(Math.max(3, 132 * Math.min(1, f.p)), 3, g.c), 0, 185) }
  return c
}
M.addTile = () => { const a = AL('V', { w: 96, h: 188, r: 14, stroke: 'line', dash: [4, 4], ai: 'CENTER', jc: 'CENTER', gap: 6, n: 'Add tile' }); add(a, I('plus', 22, 'ink3'), T('Add files', { s: 12, c: 'ink3' })); return a }
M.row = (p, g) => { const r = AL('H', { gap: 12, p: [0, 20], n: 'Cards' }); add(p, r); for (const f of g.files) add(r, M.card(f, g)); add(r, M.addTile()); return r }
M.board = (theme, name = 'Library board') => {
  TH = theme; const s = SCR(name); add(s, SB()); M.top(s); M.search(s, `Search ${TOTAL} files`)
  for (const g of GROUPS) { M.groupHead(s, g); M.row(s, g); gap(s, 6) }
  GB(s); return s
}
M.btn = (p, label, icon, primary = true, w = 312) => {
  const b = AL('H', { w, h: 50, r: 14, fill: primary ? 'accent' : null, stroke: primary ? null : 'line', jc: 'CENTER', ai: 'CENTER', gap: 8, n: 'Button / ' + label }); add(p, b)
  if (icon) add(b, I(icon, 20, primary ? 'onAccent' : 'ink')); add(b, T(label, { f: 'uiS', s: 15, c: primary ? 'onAccent' : 'ink' })); return b
}
M.illus = () => {
  const f = FR(312, 176, { fill: 'surface', r: 20, stroke: 'line', n: 'Illustration' })
  const cs = ['g1', 'g2', 'g3']
  cs.forEach((g, i) => {
    const y = 20 + i * 50
    at(f, RC(8, 8, g, { r: 2 }), 20, y + 1); at(f, RC(i === 0 ? 70 : 50, 6, 'ink3', { r: 3, o: 0.6 }), 34, y + 2)
    for (let j = 0; j < 6; j++) { const r = RC(42, 26, i === 0 && j === 1 ? 'raised' : 'bg', { r: 6, stroke: i === 0 && j === 1 ? 'accent' : 'line', sw: i === 0 && j === 1 ? 1.5 : 1 }); at(f, r, 20 + j * 48, y + 14) }
  })
  at(f, I('swipe', 20, 'accent'), 272, 14)
  const tag = AL('H', { p: [3, 8], r: 999, fill: 'accent', n: 'tag' }); add(tag, T('swipe between files', { f: 'uiM', s: 10, c: 'onAccent' })); at(f, tag, 164, 13)
  return f
}
M.empty = theme => {
  TH = theme; const s = SCR('Empty board'); add(s, SB()); M.top(s)
  const b = AL('V', { ai: 'CENTER', p: [16, 24, 0, 24], n: 'Empty state' }); add(s, b); fw(b)
  add(b, M.illus()); gap(b, 28)
  add(b, T('A board, not a folder', { f: 'uiS', s: 24, ls: -2, al: 'CENTER' })); gap(b, 10)
  add(b, T('Put related files in one row — a paper and its references, say. Swipe sideways to move between them while you read; scroll down for your other rows.', { s: 15, lh: 23, c: 'ink2', w: 312, al: 'CENTER' })); gap(b, 10)
  add(b, T('A group is only a label, so moving a file between groups never touches the file.', { s: 13, lh: 19, c: 'ink3', w: 296, al: 'CENTER' })); gap(b, 28)
  M.btn(b, 'Add files', 'filePlus'); gap(b, 10); M.btn(b, 'Import a folder or ZIP', 'folder', false)
  GB(s); return s
}
M.searchScreen = theme => {
  TH = theme; const s = SCR('Search'); add(s, SB())
  const h = rowH(s, { p: [8, 20, 8, 8], gap: 4, n: 'Search bar' }); add(h, iconBtn('back', 'ink'))
  const f = AL('H', { h: 46, r: 12, fill: 'raised', p: [0, 8, 0, 14], gap: 8, ai: 'CENTER', stroke: 'accent', sw: 1.5, n: 'Field' }); add(h, f); f.layoutGrow = 1
  add(f, T('join', { s: 15 }), RC(1.5, 20, 'accent', { n: 'caret' })); grow(f); add(f, I('x', 18, 'ink3'))
  add(rowH(s, { p: [8, 20, 6, 20] }), T('4 FILES IN 2 GROUPS', { f: 'monoM', s: 11, ls: 6, c: 'ink3' }))
  const res = [
    [GROUPS[1], [['MD', 'Joins explained', 'joins-explained.md'], ['MD', 'Self-join patterns', 'self-join-patterns.md'], ['MD', 'Anti-joins with NOT EXISTS', 'anti-join-not-exists.md']]],
    [GROUPS[0], [['MD', 'JPA joins and fetch types', '17-jpa-joins-and-fetch-types.md']]]]
  for (const [g, rows] of res) {
    const gh = rowH(s, { p: [14, 20, 6, 20], gap: 8 }); add(gh, RC(8, 8, g.c, { r: 2 }), T(g.name, { f: 'uiM', s: 13, c: 'ink2' }))
    for (const [fmt, title, file] of rows) {
      const r = rowH(s, { h: 60, gap: 14, n: 'Result' })
      const b = AL('H', { w: 36, h: 44, r: 8, fill: 'raised', jc: 'CENTER', ai: 'CENTER' }); add(r, b); add(b, T(fmt, { f: 'monoM', s: 9, c: 'ink2' }))
      const v = AL('V', { gap: 3 }); add(r, v); v.layoutGrow = 1
      const t = T(title, { f: 'uiM', s: 15, max: 1 }); add(v, t); fw(t)
      const i = title.toLowerCase().indexOf('join'); if (i >= 0) { t.setRangeFills(i, i + 4, F('accent')); t.setRangeFontName(i, i + 4, { family: 'Geist', style: 'SemiBold' }) }
      const fn = T(file, { f: 'mono', s: 11, c: 'ink3', max: 1 }); add(v, fn); fw(fn)
      add(r, I('right', 18, 'ink3'))
    }
  }
  // keyboard
  const kb = AL('V', { w: 360, h: 268, fill: 'raised', p: [10, 4, 0, 4], gap: 10, n: 'Keyboard' })
  const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm']
  rows.forEach((r, i) => { const k = AL('H', { gap: 5, jc: 'CENTER', n: 'keys' }); add(kb, k); fw(k); if (i === 2) add(k, AL('H', { w: 44, h: 44, r: 6, fill: 'line' })); for (const ch of r) { const key = AL('H', { w: 30, h: 44, r: 6, fill: 'surface', jc: 'CENTER', ai: 'CENTER' }); add(key, T(ch, { s: 18 })); add(k, key) } if (i === 2) add(k, AL('H', { w: 44, h: 44, r: 6, fill: 'line' })) })
  const last = AL('H', { gap: 5, jc: 'CENTER' }); add(kb, last); fw(last)
  const k1 = AL('H', { w: 64, h: 44, r: 6, fill: 'line', jc: 'CENTER', ai: 'CENTER' }); add(k1, T('?123', { f: 'uiM', s: 13 }))
  const sp = AL('H', { w: 180, h: 44, r: 6, fill: 'surface' }); const k2 = AL('H', { w: 64, h: 44, r: 6, fill: 'accent', jc: 'CENTER', ai: 'CENTER' }); add(k2, I('search', 18, 'onAccent'))
  add(last, k1, sp, k2)
  at(s, kb, 0, 532); GB(s); return s
}
// one of the reader's bottom sheets / menus sits on top of this
M.reader = (theme, rt = 'Night', o = {}) => {
  TH = theme; const R = k => `Reading/${rt}/${k}`
  const s = SCR('Reader', R('page')); add(s, SB(R('ink')))
  const top = rowH(s, { h: 56, p: [0, 4, 0, 4], gap: 2, fill: R('page'), n: 'Reader top bar' })
  top.strokes = F(R('ink2'), 0.18); top.strokeWeight = 0; top.strokeBottomWeight = 1; top.strokeTopWeight = 0; top.strokeLeftWeight = 0; top.strokeRightWeight = 0
  add(top, iconBtn('back', R('ink')))
  const bc = AL('V', { gap: 1, n: 'Breadcrumb' }); add(top, bc); bc.layoutGrow = 1
  const l1 = AL('H', { gap: 6, ai: 'CENTER' }); add(bc, l1); add(l1, EL(7, 'g1'), T('JavaSpringBootNotes', { f: 'uiM', s: 12, c: R('ink2') }), I('down', 14, R('ink2')))
  const l2 = T('02 · Install JDK and Tools', { f: 'uiS', s: 15, c: R('ink'), max: 1 }); add(bc, l2); fw(l2)
  add(top, textBtn('Aa', 'uiM', R('ink'), 16), iconBtn('more', R('ink')))
  add(s, readingBody(rt))
  // bottom chrome: previous / next file and the position scrubber
  const b = AL('V', { w: 360, h: 128, fill: R('page'), p: [12, 20, 0, 20], gap: 12, n: 'Reader bottom bar' })
  b.strokes = F(R('ink2'), 0.18); b.strokeWeight = 0; b.strokeTopWeight = 1; b.strokeBottomWeight = 0; b.strokeLeftWeight = 0; b.strokeRightWeight = 0
  const nx = AL('H', { ai: 'CENTER', gap: 6 }); add(b, nx); fw(nx)
  add(nx, I('back', 14, R('ink2')), T('Prerequisites', { s: 12, c: R('ink2') })); grow(nx); add(nx, T('Your first Spring app', { s: 12, c: R('ink2') }), I('right', 14, R('ink2')))
  const sc = AL('H', { ai: 'CENTER', gap: 12 }); add(b, sc); fw(sc)
  add(sc, T('2', { f: 'monoM', s: 12, c: R('ink') }))
  const tr = FR(256, 16, { n: 'Scrubber', clip: false }); add(sc, tr)
  at(tr, RC(256, 3, R('ink2'), { r: 2, o: 0.25 }), 0, 6.5); at(tr, RC(8, 3, 'g1', { r: 2 }), 0, 6.5); at(tr, EL(14, 'g1', { stroke: R('page'), sw: 2 }), 2, 1)
  add(sc, T('106', { f: 'mono', s: 12, c: R('ink2') }))
  add(b, T('File 2 of 106  ·  page 3 of 9', { f: 'mono', s: 11, c: R('ink2'), al: 'CENTER', w: 320 }))
  at(s, b, 0, 672)
  GB(s, R('ink'))
  return s
}
M.jumpSheet = (theme, rt) => {
  const s = M.reader(theme, rt); scrim(s); const sh = sheet(s, 600)
  const h = AL('V', { gap: 4, p: [6, 20, 12, 20] }); add(sh, h); fw(h)
  const tr = AL('H', { ai: 'CENTER' }); add(h, tr); fw(tr); add(tr, T('Jump to file', { f: 'uiS', s: 20, ls: -1 })); grow(tr); add(tr, T('106 files', { f: 'mono', s: 12, c: 'ink3' }))
  const sub = AL('H', { gap: 6, ai: 'CENTER' }); add(h, sub); add(sub, EL(8, 'g1'), T('JavaSpringBootNotes', { s: 13, c: 'ink2' }))
  const fwrap = AL('H', { p: [0, 20, 8, 20] }); add(sh, fwrap); fw(fwrap)
  const ff = AL('H', { h: 40, r: 10, fill: 'raised', p: [0, 12], gap: 8, ai: 'CENTER' }); add(fwrap, ff); fw(ff); add(ff, I('search', 16, 'ink3'), T('Filter this group', { s: 14, c: 'ink3' }))
  const files = [['01', 'Prerequisites', '3.2 KB', 1], ['02', 'Install JDK and Tools', '7.2 KB'], ['03', 'Your first Spring app', '6.8 KB'], ['04', 'How to use these notes', '5.8 KB'], ['05', 'Syntax and data types', '8.5 KB'], ['06', 'Control flow and methods', '6.9 KB'], ['07', 'OOP: classes and objects', '9.7 KB'], ['08', 'Inheritance and polymorphism', '7.8 KB'], ['09', 'Interfaces and abstract classes', '7.9 KB'], ['10', 'Exceptions', '7.7 KB']]
  files.forEach(([no, title, size, done], i) => {
    const cur = i === 1
    const r = rowH(sh, { h: 50, gap: 14, fill: cur ? 'raised' : null, n: 'File row' })
    if (cur) at(r, RC(3, 50, 'accent'), 0, 0)
    add(r, T(no, { f: 'mono', s: 12, c: cur ? 'accent' : 'ink3' }))
    const t = T(title, { f: cur ? 'uiS' : 'ui', s: 15, c: cur ? 'accent' : 'ink', max: 1 }); add(r, t); t.layoutGrow = 1
    if (cur) add(r, I('check', 18, 'accent', 2)); else if (done) add(r, T('read', { f: 'mono', s: 11, c: 'g1' }))
    add(r, T(size, { f: 'mono', s: 12, c: 'ink3' }))
  })
  return s
}
M.groupSheet = (theme, rt) => {
  const s = M.reader(theme, rt); scrim(s); const sh = sheet(s, 300)
  const h = AL('V', { gap: 4, p: [6, 20, 14, 20] }); add(sh, h); fw(h); add(h, T('Switch group', { f: 'uiS', s: 20, ls: -1 }), T('Opens the first unread file in that group', { s: 13, c: 'ink2' }))
  GROUPS.forEach((g, i) => {
    const r = rowH(sh, { h: 56, gap: 14, fill: i === 0 ? 'raised' : null }); add(r, RC(12, 12, g.c, { r: 3 }))
    const t = T(g.name, { f: i === 0 ? 'uiS' : 'ui', s: 16 }); add(r, t); t.layoutGrow = 1
    add(r, T(String(g.count), { f: 'mono', s: 12, c: 'ink3' })); if (i === 0) add(r, I('check', 18, 'accent', 2))
  })
  return s
}
// action sheet rows: [icon, title, subtitle?, danger?]
M.actionSheet = (s, h, title, sub, rows) => {
  scrim(s); const sh = sheet(s, h)
  const hd = AL('V', { gap: 4, p: [6, 20, 14, 20] }); add(sh, hd); fw(hd); add(hd, T(title, { f: 'uiS', s: 20, ls: -1 })); if (sub) add(hd, T(sub, { s: 13, c: 'ink2' }))
  for (const [ic, t, d, danger] of rows) {
    const r = rowH(sh, { h: d ? 68 : 54, gap: 14 })
    const tile = AL('H', { w: 44, h: 44, r: 12, fill: 'raised', jc: 'CENTER', ai: 'CENTER' }); add(r, tile); add(tile, I(ic, 22, danger ? 'danger' : 'ink'))
    const v = AL('V', { gap: 2 }); add(r, v); v.layoutGrow = 1
    add(v, T(t, { f: 'uiM', s: 16, c: danger ? 'danger' : 'ink' })); if (d) { const dt = T(d, { s: 13, lh: 18, c: 'ink2' }); add(v, dt); fw(dt) }
    add(r, I('right', 18, 'ink3'))
  }
  return sh
}
M.newGroup = theme => { const s = M.board(theme, 'New group sheet'); M.actionSheet(s, 360, 'New group', 'Start empty, or fill it from a folder or a ZIP', [['plus', 'Empty group', 'Name it now, add files whenever.'], ['folder', 'Import a folder', 'Every file inside becomes a card, subfolders included.'], ['zip', 'Import a ZIP', 'Unpacked into a new group — up to 1,000 files.']]); return s }
M.librarySheet = theme => { const s = M.board(theme, 'Library sheet'); M.actionSheet(s, 330, 'Library', 'Backups include every file and its groups', [['palette', 'Appearance', 'Look, colour theme and reading defaults'], ['upload', 'Back up library…'], ['restore', 'Restore from backup…']]); return s }
M.cardMenu = theme => {
  const s = M.board(theme, 'Card menu'); scrim(s, 0.5)
  const g = GROUPS[0], f = g.files[1]
  const c = M.card(f, g); c.effects = [SH(12, 32, 0.35)]; at(s, c, 164, 200)
  const m = AL('V', { w: 236, r: 16, fill: 'raised', stroke: 'line', p: [6, 0], fx: [SH(16, 40, 0.4)], n: 'Menu' })
  const hd = AL('V', { gap: 2, p: [10, 16, 10, 16] }); add(m, hd); fw(hd); add(hd, T(f.title, { f: 'uiS', s: 14 }), T(f.file, { f: 'mono', s: 11, c: 'ink3' }))
  add(m, RC(236, 1, 'line')); m.children[m.children.length - 1].layoutSizingHorizontal = 'FILL'
  for (const [ic, t, d] of [['open', 'Open'], ['move', 'Move to group…'], ['trash', 'Remove', 1]]) {
    if (d) { const dv = RC(236, 1, 'line'); add(m, dv); dv.layoutSizingHorizontal = 'FILL' }
    const r = AL('H', { h: 46, p: [0, 16], gap: 12, ai: 'CENTER' }); add(m, r); fw(r); add(r, I(ic, 20, d ? 'danger' : 'ink2'), T(t, { f: 'uiM', s: 15, c: d ? 'danger' : 'ink' }))
  }
  at(s, m, 108, 400)
  return s
}
// Appearance — the one new screen. style lets Notebook reuse the layout.
M.appearance = (theme, st = {}) => {
  TH = theme
  const S = Object.assign({ title: 'uiS', label: 'monoM', body: 'ui', name: 'uiS', ls: 8, selLook: 'Modern', selTheme: 'Midnight', r: 14 }, st)
  const s = SCR('Appearance'); if (S.paper) NB.paper(s); add(s, SB())
  const top = rowH(s, { h: 56, p: [0, 20, 0, 4], gap: 4, n: 'Top bar' }); add(top, iconBtn('back', 'ink')); add(top, T('Appearance', { f: S.title, s: S.titleSize || 20, ls: -1 }))
  const body = AL('V', { gap: 12, p: [4, 20, 0, 20], n: 'Body' }); add(s, body); fw(body)
  const label = t => { const l = T(t, { f: S.label, s: 11, ls: S.ls, c: 'ink3', u: true }); add(body, l); return l }
  label('Look')
  const looks = [['Modern', 'Clean and quiet'], ['Notebook', 'Ruled paper, tape'], ['Shelf', 'Books on shelves'], ['Terminal', 'Mono, for code notes']]
  for (let i = 0; i < 4; i += 2) {
    const r = AL('H', { gap: 12 }); add(body, r); fw(r)
    for (const [name, d] of looks.slice(i, i + 2)) {
      const sel = name === S.selLook
      const t = AL('V', { gap: 8, w: 154, n: 'Look / ' + name }); add(r, t)
      const keep = TH; const pv = MINI[name](); TH = keep; pv.cornerRadius = S.r; pv.strokes = F(sel ? 'accent' : 'line'); pv.strokeWeight = sel ? 2.5 : 1; pv.strokeAlign = 'INSIDE'; add(t, pv)
      if (sel) { const ck = AL('H', { w: 22, h: 22, r: 11, fill: 'accent', jc: 'CENTER', ai: 'CENTER' }); add(ck, I('check', 14, 'onAccent', 2.4)); at(pv, ck, 124, 8) }
      const lb = AL('V', { gap: 1 }); add(t, lb); add(lb, T(name, { f: S.name, s: 14, c: sel ? 'accent' : 'ink' }), T(d, { f: S.body, s: 12, c: 'ink3' }))
    }
  }
  gap(body, 6); label('Colour theme')
  const names = Object.keys(THEMES)
  for (let i = 0; i < 8; i += 4) {
    const r = AL('H', { gap: 10 }); add(body, r); fw(r)
    for (const t of names.slice(i, i + 4)) {
      const sel = t === S.selTheme
      const c = AL('V', { gap: 6, w: 72.5, ai: 'CENTER', n: 'Theme / ' + t }); add(r, c)
      const sw = FR(72.5, 52, { fill: t + '/bg', r: 12, stroke: sel ? 'accent' : 'line', sw: sel ? 2.5 : 1, n: 'Swatch' })
      at(sw, RC(34, 24, t + '/surface', { r: 5, stroke: t + '/line' }), 10, 10); at(sw, RC(20, 3, t + '/ink', { r: 2 }), 16, 18); at(sw, EL(12, t + '/accent'), 50, 30); at(sw, RC(8, 8, t + '/g2', { r: 2 }), 12, 38)
      add(c, sw, T(t, { f: S.body, s: 11, c: sel ? 'ink' : 'ink2' }))
    }
  }
  gap(body, 4)
  const tg = (t, d, on) => { const r = AL('H', { gap: 12, ai: 'CENTER', p: [8, 0] }); add(body, r); fw(r); const v = AL('V', { gap: 2 }); add(r, v); v.layoutGrow = 1; add(v, T(t, { f: S.name === 'uiS' ? 'uiM' : S.name, s: 15 }), T(d, { f: S.body, s: 12, c: 'ink3' })); add(r, toggle(on)) }
  tg('Follow system light and dark', 'Daylight by day, ' + S.selTheme + ' at night', true)
  tg('Snippets on cards', 'First lines of the file under its title', true)
  GB(s); return s
}
