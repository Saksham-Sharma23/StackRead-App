// ================================================================= SHELF ===
// Instrument Serif + DM Sans. Each group is a shelf; its files are a matching
// set of cloth-bound volumes in the group's colour. A ribbon marks "in progress".
const SH_ = {}
SH_.top = (s, sub) => {
  const h = AL('V', { gap: 0, p: [12, 8, 6, 20], n: 'Header' }); add(s, h); fw(h)
  const r = AL('H', { ai: 'CENTER' }); add(h, r); fw(r); add(r, T('StackRead', { f: 'insI', s: 36, ls: -1 })); grow(r); add(r, iconBtn('more', 'ink2'))
  add(h, T(sub, { f: 'dm', s: 13, c: 'ink2' }))
}
SH_.search = (s, text) => { const w = rowH(s, { p: [12, 20, 4, 20] }); const f = AL('H', { h: 44, r: 22, fill: 'raised', p: [0, 16], gap: 10, ai: 'CENTER', n: 'Field' }); add(w, f); fw(f); add(f, I('search', 18, 'ink3'), T(text, { f: 'dm', s: 15, c: 'ink3' })) }
SH_.book = (f, g, h) => {
  const b = FR(116, h, { fill: g.c, n: 'Volume / ' + f.title, fx: [SH(4, 6, 0.35)] })
  b.topLeftRadius = 2; b.bottomLeftRadius = 2; b.topRightRadius = 5; b.bottomRightRadius = 5
  const ink = ON_G[TH]
  at(b, RC(7, h, '#000000', { o: 0.28, n: 'Spine' }), 0, 0); at(b, RC(1, h, '#FFFFFF', { o: 0.14 }), 7, 0)
  at(b, RC(92, h - 20, null, { stroke: ink, so: 0.3, n: 'Blind stamp' }), 16, 10)
  const c = AL('V', { w: 92, h: h - 20, p: [12, 4, 10, 4], gap: 8, ai: 'CENTER', n: 'Cover text' }); at(b, c, 16, 10)
  add(c, T('No. ' + f.no, { f: 'dmM', s: 8, ls: 14, c: ink, o: 0.75, u: true }))
  add(c, T(f.title, { f: 'ins', s: 16, lh: 18, c: ink, w: 84, al: 'CENTER', max: 5 }))
  add(c, RC(20, 1, ink, { o: 0.55 })); grow(c)
  add(c, T(f.p >= 1 ? 'Read' : `${f.fmt} · ${f.size}`, { f: 'dmM', s: 8, ls: 10, c: f.p >= 1 ? 'accent' : ink, o: f.p >= 1 ? 1 : 0.7, u: true }))
  if (f.p > 0 && f.p < 1) at(b, RC(9, 30 + 20 * f.p, 'accent', { n: 'Ribbon' }), 94, 0)
  return b
}
SH_.shelf = (p, g) => {
  const blk = AL('V', { n: 'Shelf / ' + g.name }); add(p, blk); fw(blk)
  const h = AL('H', { gap: 10, ai: 'BASELINE', p: [20, 8, 12, 20] }); add(blk, h); fw(h); add(h, T(g.name, { f: 'ins', s: 24 }), T(`${g.count} files`, { f: 'dmM', s: 11, ls: 8, c: 'ink3', u: true })); grow(h); add(h, iconBtn('more', 'ink3', 20))
  const r = AL('H', { gap: 8, p: [0, 20], ai: 'MAX', n: 'Books' }); add(blk, r)
  const hs = [176, 168, 176, 160]; g.files.forEach((f, i) => add(r, SH_.book(f, g, hs[i])))
  const plus = AL('V', { w: 64, h: 160, ai: 'CENTER', jc: 'CENTER', gap: 4, r: 4, stroke: 'line', dash: [3, 3] }); add(plus, I('plus', 20, 'ink3'), T('Add', { f: 'dm', s: 12, c: 'ink3' })); add(r, plus)
  const pl = AL('V', { n: 'Plank' }); add(blk, pl); fw(pl)
  const top = RC(360, 2, 'line'); add(pl, top); top.layoutSizingHorizontal = 'FILL'
  const face = RC(360, 9, 'raised', { fx: [SH(6, 10, 0.45)] }); add(pl, face); face.layoutSizingHorizontal = 'FILL'
}
SH_.board = (theme, name = 'Library board') => {
  TH = theme; const s = SCR(name); add(s, SB()); SH_.top(s, `${TOTAL} files on ${GROUPS.length} shelves`); SH_.search(s, 'Search the library')
  for (const g of GROUPS) SH_.shelf(s, g)
  GB(s); return s
}
SH_.empty = theme => {
  TH = theme; const s = SCR('Empty board'); add(s, SB()); SH_.top(s, 'An empty library')
  const b = AL('V', { ai: 'CENTER', p: [28, 24, 0, 24] }); add(s, b); fw(b)
  const il = FR(312, 200, { n: 'Empty shelves' })
  for (let i = 0; i < 2; i++) { at(il, RC(312, 2, 'line'), 0, 86 + i * 100); at(il, RC(312, 9, 'raised'), 0, 88 + i * 100) }
  at(il, RC(18, 70, 'g1', { r: 2 }), 30, 16); at(il, RC(22, 64, 'g2', { r: 2 }), 50, 22); at(il, RC(18, 74, 'g4', { r: 2, rot: -14 }), 76, 14)
  at(il, T('room for a paper and its references', { f: 'insI', s: 17, c: 'ink3' }), 60, 150)
  add(b, il); gap(b, 24)
  add(b, T('Every group is a shelf.', { f: 'ins', s: 32, al: 'CENTER' })); gap(b, 8)
  add(b, T('Fill one with related files and read along it — swipe to the next volume without going back to the library.', { f: 'dm', s: 15, lh: 23, c: 'ink2', w: 300, al: 'CENTER' })); gap(b, 28)
  const p = AL('H', { w: 300, h: 50, r: 25, fill: 'accent', jc: 'CENTER', ai: 'CENTER', gap: 8 }); add(b, p); add(p, I('filePlus', 18, 'onAccent'), T('Add files', { f: 'dmS', s: 15, c: 'onAccent' })); gap(b, 10)
  const q = AL('H', { w: 300, h: 50, r: 25, stroke: 'line', jc: 'CENTER', ai: 'CENTER', gap: 8 }); add(b, q); add(q, I('folder', 18, 'ink'), T('Import a folder or ZIP', { f: 'dmM', s: 15 }))
  GB(s); return s
}
SH_.reader = (theme, rt = 'Sepia') => {
  TH = theme; const R = k => `Reading/${rt}/${k}`
  const s = SCR('Reader', R('page')); add(s, SB('ink', 'bg'))
  const top = rowH(s, { h: 62, p: [0, 4, 0, 4], gap: 2, fill: 'bg', n: 'Reader top bar' }); add(top, iconBtn('back', 'ink'))
  const bc = AL('V', { gap: 0 }); add(top, bc); bc.layoutGrow = 1
  const l1 = AL('H', { gap: 6, ai: 'CENTER' }); add(bc, l1); add(l1, RC(6, 10, 'g1', { r: 1 }), T('JavaSpringBootNotes', { f: 'dmM', s: 10, ls: 10, c: 'ink2', u: true }))
  const l2 = T('Install JDK and Tools', { f: 'insI', s: 21, max: 1 }); add(bc, l2); fw(l2)
  add(top, textBtn('Aa', 'ins', 'ink', 20), iconBtn('more', 'ink'))
  add(s, readingBody(rt, { h: 'nrS', p: 'nr', size: 18, lh: 29, h1: 32 }))
  const b = AL('V', { w: 360, h: 120, fill: 'bg', p: [14, 20, 0, 20], gap: 12, n: 'Reader bottom bar' }); add(b)
  const nx = AL('H', { ai: 'CENTER' }); add(b, nx); fw(nx); add(nx, T('‹  Prerequisites', { f: 'insI', s: 15, c: 'ink2' })); grow(nx); add(nx, T('Your first Spring app  ›', { f: 'insI', s: 15, c: 'ink2' }))
  const tr = FR(320, 10, { clip: false, n: 'Progress' }); add(b, tr); at(tr, RC(320, 1, 'ink3'), 0, 5); at(tr, RC(320 * 2 / 106 + 4, 3, 'accent'), 0, 4); at(tr, RC(2, 10, 'accent'), 320 * 2 / 106 + 3, 0)
  add(b, T('VOLUME 2 OF 106  ·  PAGE 3 OF 9', { f: 'dmM', s: 9, ls: 14, c: 'ink3', al: 'CENTER', w: 320 }))
  at(s, b, 0, 680); GB(s); return s
}

// ============================================================== TERMINAL ===
// JetBrains Mono everywhere. Raw file names are a feature here, not a bug.
const TM = {}
TM.top = (s, cmd = 'ls') => {
  const h = AL('V', { gap: 4, p: [10, 8, 8, 16], n: 'Header' }); add(s, h); fw(h)
  const r = AL('H', { ai: 'CENTER' }); add(h, r); fw(r)
  const p = T('~/stackread $ ' + cmd, { f: 'jbB', s: 16 }); p.setRangeFills(0, 11, F('accent')); p.setRangeFills(11, 13, F('ink3')); add(r, p); add(r, RC(9, 18, 'accent', { n: 'cursor' })); grow(r); add(r, iconBtn('more', 'ink2'))
  return h
}
TM.search = (s, text) => { const w = rowH(s, { p: [6, 16, 6, 16] }); const f = AL('H', { h: 40, r: 2, stroke: 'line', p: [0, 12], gap: 8, ai: 'CENTER', n: 'Field' }); add(w, f); fw(f); add(f, T('>', { f: 'jbB', s: 14, c: 'accent' }), T(text, { f: 'jb', s: 13, c: 'ink3' })) }
TM.bar = (p, n = 10) => { const k = Math.round(p * n); return '█'.repeat(k) + '·'.repeat(n - k) }
TM.card = (f, g) => {
  const c = AL('V', { w: 152, h: 172, r: 2, fill: 'surface', stroke: 'line', p: [10, 10, 10, 10], gap: 6, clip: true, n: 'Card / ' + f.file })
  const t = T(f.file, { f: 'jbM', s: 11, lh: 15, max: 2 }); add(c, t); fw(t)
  const d = RC(10, 1, 'line'); add(c, d); d.layoutSizingHorizontal = 'FILL'
  const sn = T('// ' + f.snip, { f: 'jb', s: 10, lh: 15, c: 'ink3', max: 5 }); add(c, sn); fw(sn)
  grow(c)
  add(c, T(f.p >= 1 ? '[' + TM.bar(1, 8) + '] done' : `[${TM.bar(f.p, 8)}] ${String(Math.round(f.p * 100)).padStart(2, ' ')}%`, { f: 'jb', s: 10, c: f.p > 0 ? g.c : 'ink3' }))
  const ft = AL('H'); add(c, ft); fw(ft); add(ft, T(f.fmt.toLowerCase(), { f: 'jbM', s: 10, c: g.c })); grow(ft); add(ft, T(f.size.replace(' ', ''), { f: 'jb', s: 10, c: 'ink3' }))
  return c
}
TM.board = (theme, name = 'Library board') => {
  TH = theme; const s = SCR(name); add(s, SB()); TM.top(s, 'ls')
  add(rowH(s, { p: [0, 16, 4, 16] }), T(`# ${TOTAL} files · ${GROUPS.length} groups · by name`, { f: 'jb', s: 11, c: 'ink3' }))
  TM.search(s, 'grep -i …')
  for (const g of GROUPS) {
    const h = rowH(s, { p: [16, 8, 8, 16], gap: 8 }); add(h, RC(4, 16, g.c)); const n = T(`[${g.name}]`, { f: 'jbB', s: 14 }); add(h, n); add(h, T(`${g.count}`, { f: 'jb', s: 12, c: 'ink3' })); grow(h); add(h, iconBtn('more', 'ink3', 18))
    const r = AL('H', { gap: 8, p: [0, 16] }); add(s, r); for (const f of g.files) add(r, TM.card(f, g))
    const a = AL('V', { w: 80, h: 172, r: 2, stroke: 'line', dash: [2, 3], ai: 'CENTER', jc: 'CENTER' }); add(a, T('[+] add', { f: 'jb', s: 12, c: 'ink2' })); add(r, a)
  }
  GB(s); return s
}
TM.empty = theme => {
  TH = theme; const s = SCR('Empty board'); add(s, SB()); TM.top(s, 'ls')
  const b = AL('V', { gap: 6, p: [8, 16, 0, 16] }); add(s, b); fw(b)
  const L = (t, c = 'ink2', f = 'jb') => { const x = T(t, { f, s: 13, lh: 20, c, w: 328 }); add(b, x); return x }
  L('total 0', 'ink3'); gap(b, 10)
  L('# A board, not a folder.', 'accent', 'jbB')
  L('# Put related files in one group — a paper and its references, say.', 'ink2')
  L('# Swipe sideways to move between them while you read.', 'ink2')
  L('# A group is just a label: moving a file never touches it.', 'ink3'); gap(b, 18)
  const box = AL('V', { gap: 0, stroke: 'line', r: 2 }); add(b, box); fw(box)
  for (const [k, t, d] of [['a', 'add files', 'pick files to copy in'], ['f', 'import folder', 'a folder becomes a group'], ['z', 'import zip', 'unpacked into a new group']]) {
    const r = AL('H', { h: 52, p: [0, 14], gap: 12, ai: 'CENTER' }); add(box, r); fw(r)
    const key = AL('H', { w: 26, h: 26, r: 2, fill: k === 'a' ? 'accent' : 'raised', jc: 'CENTER', ai: 'CENTER' }); add(key, T(k, { f: 'jbB', s: 13, c: k === 'a' ? 'onAccent' : 'ink' })); add(r, key)
    const v = AL('V', { gap: 2 }); add(r, v); v.layoutGrow = 1; add(v, T(t, { f: 'jbM', s: 14 }), T(d, { f: 'jb', s: 10, c: 'ink3' }))
  }
  gap(b, 18); const pr = T('~/stackread $ ', { f: 'jbB', s: 14, c: 'accent' }); add(b, pr)
  GB(s); return s
}
TM.reader = (theme, rt) => {
  TH = theme; const s = SCR('Reader'); add(s, SB())
  const top = rowH(s, { h: 44, p: [0, 4, 0, 4], gap: 4, fill: 'surface' }); add(top, iconBtn('back', 'accent', 20))
  const pth = T('javaspringbootnotes/02-install-jdk-and-tools.md', { f: 'jb', s: 12, c: 'ink2', max: 1 }); add(top, pth); pth.layoutGrow = 1
  add(top, textBtn('Aa', 'jbB', 'ink', 14))
  const body = AL('V', { gap: 12, p: [20, 18, 120, 18] }); add(s, body); fw(body)
  const L = (t, f = 'jb', c = 'ink', size = 14, lh = 23) => { const x = T(t, { f, s: size, lh, c, w: 324 }); add(body, x); return x }
  const h1 = L('# Install JDK and Tools', 'jbB', 'ink', 19, 26); h1.setRangeFills(0, 1, F('accent'))
  L('Step-by-step install instructions for Windows, macOS and Linux. After this file you’ll have a working Java 21 + Maven + Docker + IDE setup.', 'jb', 'ink2')
  const h2 = L('## What you’ll learn', 'jbB', 'ink', 15, 24); h2.setRangeFills(0, 2, F('accent'))
  L('- How to install Java 21 (Eclipse Temurin) and set JAVA_HOME.\n- How to install IntelliJ IDEA.\n- How to verify everything works.', 'jb', 'ink')
  const code = AL('V', { p: [10, 12], fill: 'raised' }); add(body, code); fw(code); code.strokes = F('accent'); code.strokeWeight = 0; code.strokeLeftWeight = 2; code.strokeTopWeight = 0; code.strokeRightWeight = 0; code.strokeBottomWeight = 0
  add(code, T('$ java -version\nopenjdk 21.0.4 2024-07-16 LTS', { f: 'jb', s: 12, lh: 19, c: 'g1' }))
  const st = AL('H', { w: 360, h: 26, fill: 'accent', p: [0, 10], gap: 12, ai: 'CENTER', n: 'Status line' })
  add(st, T('READ', { f: 'jbB', s: 11, c: 'onAccent' }), T('02/106', { f: 'jbM', s: 11, c: 'onAccent' })); grow(st); add(st, T('p3/9  [███······] 33%', { f: 'jbM', s: 11, c: 'onAccent' }))
  at(s, st, 0, 726)
  const nx = AL('H', { w: 360, h: 48, fill: 'bg', p: [6, 10, 0, 10] }); add(nx, T('← 01-prerequisites', { f: 'jb', s: 11, c: 'ink3' })); grow(nx); add(nx, T('03-your-first… →', { f: 'jb', s: 11, c: 'ink3' }))
  at(s, nx, 0, 752)
  GB(s); return s
}

// ================================================================= MINIS ===
// 154×112 previews of each look in its home theme, for the Appearance picker.
const MINI = {}
MINI.Modern = () => {
  TH = 'Midnight'; const f = FR(154, 112, { fill: 'bg', n: 'Preview / Modern' })
  at(f, RC(10, 10, 'accent', { r: 2.5 }), 10, 10); at(f, RC(44, 6, 'ink', { r: 3, o: 0.85 }), 24, 12)
  at(f, RC(134, 14, 'raised', { r: 5 }), 10, 28)
  at(f, RC(6, 6, 'g1', { r: 1.5 }), 10, 50); at(f, RC(40, 4, 'ink', { r: 2, o: 0.7 }), 20, 51)
  for (let i = 0; i < 4; i++) { at(f, RC(38, 48, 'surface', { r: 6, stroke: 'line' }), 10 + i * 42, 60); at(f, RC(24, 4, 'ink', { r: 2, o: 0.8 }), 15 + i * 42, 70); at(f, RC(20, 3, 'ink2', { r: 2, o: 0.6 }), 15 + i * 42, 78); if (i < 2) at(f, RC(38 * (i ? 0.4 : 1), 2, i ? 'g1' : 'g1'), 10 + i * 42, 106) }
  return f
}
MINI.Notebook = () => {
  TH = 'Paper'; const f = FR(154, 112, { fill: 'bg', n: 'Preview / Notebook' })
  for (let y = 22; y < 112; y += 10) at(f, RC(154, 1, 'rule'), 0, y)
  at(f, RC(1, 112, 'margin'), 16, 0)
  at(f, T('StackRead', { f: 'frSI', s: 11, c: 'ink' }), 22, 4)
  at(f, RC(46, 8, 'g1', { o: 0.9, rot: -3 }), 22, 30)
  for (let i = 0; i < 3; i++) { at(f, RC(38, 54, 'surface', { stroke: 'line', rot: i % 2 ? 3 : -2 }), 26 + i * 44, 50); at(f, RC(38, 54, 'surface', { stroke: 'line', fx: [SH(1, 0, 0.08)] }), 22 + i * 44, 46); at(f, RC(38, 1, 'margin'), 22 + i * 44, 58); at(f, RC(16, 6, i === 1 ? 'g2' : 'g1', { o: 0.85, rot: 4 }), 33 + i * 44, 42) }
  return f
}
MINI.Shelf = () => {
  TH = 'Ember'; const f = FR(154, 112, { fill: 'bg', n: 'Preview / Shelf' })
  at(f, T('StackRead', { f: 'insI', s: 14, c: 'ink' }), 10, 4)
  const cols = ['g1', 'g2', 'g3']
  cols.forEach((g, j) => { for (let i = 0; i < 4; i++) at(f, RC(24, j === 1 ? 32 : 34 - (i % 2) * 4, g, { r: 1.5 }), 10 + i * 27, j === 1 ? 70 : 30 + (i % 2) * 4) })
  at(f, RC(154, 4, 'raised'), 0, 64); at(f, RC(154, 4, 'raised'), 0, 102)
  at(f, RC(4, 12, 'accent'), 26, 30)
  return f
}
MINI.Terminal = () => {
  TH = 'Terminal'; const f = FR(154, 112, { fill: 'bg', n: 'Preview / Terminal' })
  const p = T('~/stackread $', { f: 'jbB', s: 9, c: 'accent' }); at(f, p, 8, 6); at(f, RC(5, 10, 'accent'), 82, 7)
  at(f, RC(138, 14, null, { stroke: 'line', r: 1 }), 8, 22)
  for (let j = 0; j < 2; j++) { at(f, RC(3, 8, j ? 'g2' : 'g1'), 8, 44 + j * 34); at(f, RC(54, 4, 'ink', { o: 0.8 }), 14, 46 + j * 34); for (let i = 0; i < 3; i++) { at(f, RC(44, 20, 'surface', { stroke: 'line', r: 1 }), 8 + i * 48, 56 + j * 34); at(f, RC(28, 3, 'ink2', { o: 0.7 }), 12 + i * 48, 61 + j * 34); at(f, RC(18, 2, j ? 'g2' : 'g1'), 12 + i * 48, 70 + j * 34) } }
  return f
}
