// ============================================================== NOTEBOOK ===
// Fraunces for headings, Literata for text, IBM Plex Mono for labels, Caveat
// only for hand-written notes (counts, progress). Ruled paper, washi tape,
// index cards that sit on a second sheet — the "stack" in StackRead.
const NB = {}
const RULE = 28 // board rule spacing; card rules are 18
NB.paper = (s, top = 76, margin = 40) => {
  const p = FR(360, 800, { n: 'Paper', clip: true })
  for (let y = top; y < 800; y += RULE) at(p, RC(360, 1, 'rule'), 0, y)
  at(p, RC(1.5, 800, 'margin'), margin, 0)
  behind(s, p, 0, 0); return p
}
NB.tape = (text, g, rot = -2, o = {}) => {
  const t = AL('H', { p: [4, 10], fill: g, fo: 0.88, rot, n: 'Tape' })
  add(t, T(text, { f: 'plexS', s: o.s || 10, ls: 8, c: ON_G[TH], u: true }))
  return t
}
NB.top = (s, sub) => {
  const h = AL('V', { gap: 2, p: [10, 8, 8, 56], n: 'Header' }); add(s, h); fw(h)
  const r = AL('H', { ai: 'CENTER' }); add(h, r); fw(r); add(r, T('StackRead', { f: 'frSI', s: 30, ls: -2 })); grow(r); add(r, iconBtn('more', 'ink2'))
  add(h, T(sub, { f: 'plexM', s: 10, ls: 10, c: 'ink2', u: true }))
  return h
}
NB.search = (s, text) => {
  const w = rowH(s, { p: [10, 24, 6, 56] })
  const f = AL('H', { h: 40, gap: 10, ai: 'CENTER', n: 'Field' }); add(w, f); fw(f)
  f.strokes = F('ink', 0.55); f.strokeWeight = 0; f.strokeBottomWeight = 1.25; f.strokeTopWeight = 0; f.strokeLeftWeight = 0; f.strokeRightWeight = 0
  add(f, I('search', 18, 'ink2'), T(text, { f: 'litI', s: 15, c: 'ink3' }))
}
NB.groupHead = (p, g, i) => {
  const h = rowH(p, { p: [22, 8, 8, 56], gap: 12, n: 'Group / ' + g.name })
  add(h, NB.tape(g.name, g.c, i % 2 ? 1.5 : -2)); add(h, T(`${g.count} files`, { f: 'cav', s: 20, c: 'ink2' })); grow(h); add(h, iconBtn('more', 'ink3', 20))
}
NB.card = (f, g, i = 0) => {
  const w = FR(144, 200, { n: 'Index card / ' + f.title, clip: false })
  at(w, RC(132, 178, 'surface', { stroke: 'line', rot: i % 2 ? 2.5 : -2, n: 'Sheet behind' }), i % 2 ? 6 : 8, i % 2 ? 12 : 16)
  const c = AL('V', { w: 132, h: 180, fill: 'surface', stroke: 'line', p: [0, 0, 8, 0], clip: true, fx: [SH(1, 0, 0.06)], n: 'Card' })
  at(w, c, 2, 12)
  // ruled lines behind the text: 18px pitch, matching the snippet's line-height
  const rules = FR(132, 180, { n: 'Rules' }); for (let y = 56; y < 172; y += 18) at(rules, RC(132, 1, 'rule'), 0, y); behind(c, rules, 0, 0)
  const hd = AL('H', { h: 34, p: [0, 10, 0, 12], ai: 'CENTER' }); add(c, hd); fw(hd); add(hd, T(f.no, { f: 'frSI', s: 20, c: 'accent' })); grow(hd); add(hd, T(f.fmt.toLowerCase(), { f: 'plexM', s: 10, ls: 4, c: 'ink3' }))
  const m = RC(132, 1.25, 'margin'); add(c, m); m.layoutSizingHorizontal = 'FILL'
  const b = AL('V', { p: [4, 12, 0, 12] }); add(c, b); fw(b)
  const t = T(f.title, { f: 'frS', s: 15, lh: 18, max: 2 }); add(b, t); fw(t)
  const sn = T(f.snip, { f: 'lit', s: 11, lh: 18, c: 'ink2', max: 3 }); add(b, sn); fw(sn)
  grow(c)
  const ft = AL('H', { p: [0, 12], ai: 'CENTER' }); add(c, ft); fw(ft)
  add(ft, T(f.p >= 1 ? 'finished!' : f.p > 0 ? `${Math.round(f.p * 100)}% read` : 'not started', { f: 'cav', s: 16, c: f.p >= 1 ? 'accent' : 'ink3' })); grow(ft)
  // the group's tape holds the card to the page
  at(w, RC(40, 14, g.c, { o: 0.85, rot: i % 2 ? -5 : 4 }), 48, 4)
  return w
}
NB.addTile = () => { const a = AL('V', { w: 110, h: 180, r: 2, stroke: 'ink3', dash: [3, 4], ai: 'CENTER', jc: 'CENTER', gap: 2, n: 'Add tile' }); add(a, T('+', { f: 'cav', s: 30, c: 'ink2' }), T('add files', { f: 'cav', s: 18, c: 'ink2' })); const w = AL('V', { p: [12, 0, 0, 0] }); add(w, a); return w }
NB.row = (p, g) => { const r = AL('H', { gap: 6, p: [0, 20, 0, 48], n: 'Cards' }); add(p, r); g.files.forEach((f, i) => add(r, NB.card(f, g, i))); add(r, NB.addTile()); return r }
NB.board = (theme, name = 'Library board') => {
  TH = theme; const s = SCR(name); NB.paper(s); add(s, SB())
  NB.top(s, `${TOTAL} files · ${GROUPS.length} groups`); NB.search(s, `search ${TOTAL} files…`)
  GROUPS.forEach((g, i) => { NB.groupHead(s, g, i); NB.row(s, g) })
  GB(s); return s
}
NB.empty = theme => {
  TH = theme; const s = SCR('Empty board'); NB.paper(s); add(s, SB()); NB.top(s, 'nothing here yet')
  const il = FR(300, 220, { n: 'Sketch', clip: false })
  const mini = (x, y, rot, g, title) => { const c = FR(84, 104, { fill: 'surface', stroke: 'line', rot, n: 'mini card', fx: [SH(2, 4, 0.08)] }); at(c, RC(84, 1, 'margin'), 0, 24); for (let yy = 38; yy < 104; yy += 12) at(c, RC(84, 1, 'rule'), 0, yy); at(c, T(title, { f: 'frSI', s: 12, c: 'ink' }), 8, 6); at(il, c, x, y); at(il, RC(30, 10, g, { o: 0.85, rot: rot * 2 }), x + 28, y - 4) }
  mini(16, 40, -3, 'g1', 'paper.pdf'); mini(108, 36, 2, 'g1', 'ref 1'); mini(200, 42, -1.5, 'g1', 'ref 2')
  at(il, I('swipe', 26, 'accent'), 136, 156)
  at(il, T('swipe between them →', { f: 'cav', s: 20, c: 'accent' }), 100, 182)
  at(il, T('one row = one group', { f: 'cav', s: 20, c: 'ink2' }), 22, 0)
  const b = AL('V', { ai: 'CENTER', p: [20, 24, 0, 48], n: 'Empty state' }); add(s, b); fw(b)
  add(b, il); gap(b, 18)
  add(b, T('A board, not a folder.', { f: 'frS', s: 28, ls: -2, al: 'CENTER' })); gap(b, 10)
  add(b, T('Put related files on one row — a paper and its references, say — then read them side by side by swiping.', { f: 'lit', s: 15, lh: 24, c: 'ink2', w: 280, al: 'CENTER' })); gap(b, 22)
  const p = AL('H', { w: 280, h: 50, fill: 'accent', r: 3, jc: 'CENTER', ai: 'CENTER', gap: 10, fx: [SH(3, 0, 0.18)] }); add(b, p); add(p, I('filePlus', 18, 'onAccent'), T('Add your first files', { f: 'plexS', s: 12, ls: 6, c: 'onAccent', u: true })); gap(b, 16)
  add(b, T('or import a folder / ZIP as a group', { f: 'litI', s: 15, c: 'accent', deco: 'UNDERLINE' }))
  GB(s); return s
}
NB.reader = (theme, rt = 'Paper') => {
  TH = theme; const R = k => `Reading/${rt}/${k}`
  const s = SCR('Reader', R('page')); add(s, SB('ink', 'bg'))
  const top = rowH(s, { h: 60, p: [0, 4, 0, 4], gap: 2, fill: 'bg', n: 'Reader top bar' })
  top.strokes = F('line'); top.strokeWeight = 0; top.strokeBottomWeight = 1; top.strokeTopWeight = 0; top.strokeLeftWeight = 0; top.strokeRightWeight = 0
  add(top, iconBtn('back', 'ink'))
  const bc = AL('V', { gap: 2 }); add(top, bc); bc.layoutGrow = 1
  const l1 = AL('H', { gap: 6, ai: 'CENTER' }); add(bc, l1); add(l1, RC(14, 8, 'g1', { o: 0.9 }), T('JavaSpringBootNotes', { f: 'plexM', s: 9, ls: 8, c: 'ink2', u: true }))
  const l2 = T('Install JDK and Tools', { f: 'frSI', s: 18, max: 1 }); add(bc, l2); fw(l2)
  add(top, textBtn('Aa', 'frS', 'ink', 17), iconBtn('more', 'ink'))
  add(s, readingBody(rt, { h: 'frS', bullet: '–', code: 'plex', codeR: 0, codeRule: 'margin' }))
  // bottom: previous/next in italics, and a ruler for pages in this file
  const b = AL('V', { w: 360, h: 128, fill: 'bg', p: [12, 24, 0, 24], gap: 6, n: 'Reader bottom bar' })
  b.strokes = F('line'); b.strokeWeight = 0; b.strokeTopWeight = 1; b.strokeBottomWeight = 0; b.strokeLeftWeight = 0; b.strokeRightWeight = 0
  const nx = AL('H', { ai: 'CENTER' }); add(b, nx); fw(nx); add(nx, T('← Prerequisites', { f: 'litI', s: 13, c: 'ink2' })); grow(nx); add(nx, T('Your first Spring app →', { f: 'litI', s: 13, c: 'ink2' }))
  const ru = FR(312, 40, { n: 'Ruler', clip: false }); add(b, ru)
  at(ru, RC(312, 1, 'ink2', { o: 0.6 }), 0, 30)
  for (let i = 0; i <= 36; i++) { const major = i % 4 === 0; at(ru, RC(1, major ? 10 : 5, 'ink2', { o: major ? 0.8 : 0.45 }), i * (312 / 36), 30 - (major ? 10 : 5)) }
  at(ru, RC(2, 26, 'danger'), 2 * 4 * (312 / 36), 6)
  at(ru, T('p. 3 of 9', { f: 'cav', s: 17, c: 'danger' }), 2 * 4 * (312 / 36) + 6, 0)
  at(ru, T('file 02 / 106', { f: 'plexM', s: 10, ls: 4, c: 'ink2' }), 228, 4)
  at(s, b, 0, 672); GB(s); return s
}
NB.jump = (theme, rt = 'Paper') => {
  const s = NB.reader(theme, rt); scrim(s, 0.4); const sh = sheet(s, 560, 'surface', 6)
  const rules = FR(360, 560, { n: 'Rules' }); for (let y = 106; y < 560; y += 44) at(rules, RC(360, 1, 'rule'), 0, y); at(rules, RC(1.5, 560, 'margin'), 52, 0); behind(sh, rules, 0, 0)
  const h = AL('V', { gap: 6, p: [4, 20, 16, 64] }); add(sh, h); fw(h); add(h, T('Jump to file', { f: 'frSI', s: 26, ls: -2 }))
  const sub = AL('H', { gap: 10, ai: 'CENTER' }); add(h, sub); add(sub, NB.tape('JavaSpringBootNotes', 'g1', -1.5, { s: 9 }), T('106 files', { f: 'cav', s: 18, c: 'ink2' }))
  const files = [['01', 'Prerequisites', '3.2 KB'], ['02', 'Install JDK and Tools', '7.2 KB'], ['03', 'Your first Spring app', '6.8 KB'], ['04', 'How to use these notes', '5.8 KB'], ['05', 'Syntax and data types', '8.5 KB'], ['06', 'Control flow and methods', '6.9 KB'], ['07', 'OOP: classes and objects', '9.7 KB'], ['08', 'Inheritance and polymorphism', '7.8 KB'], ['09', 'Interfaces and abstract classes', '7.9 KB']]
  files.forEach(([no, title, size], i) => {
    const r = rowH(sh, { h: 44, gap: 14, p: [0, 20, 0, 18] })
    add(r, T(no, { f: 'frI', s: 15, c: 'ink3', w: 26 }))
    const tw = AL('H', { p: [0, 0] }); add(r, tw); tw.layoutGrow = 1
    const t = T(title, { f: i === 1 ? 'litS' : 'lit', s: 15, max: 1 }); add(tw, t); fw(t)
    if (i === 1) { const hl = RC(200, 14, 'g1', { o: 0.55, n: 'Highlighter' }); behind(tw, hl, -4, 9) }
    add(r, T(size, { f: 'plex', s: 11, c: 'ink3' }))
  })
  return s
}
