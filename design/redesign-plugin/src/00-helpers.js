/*
 * StackRead — UI redesign sheet, as a Figma development plugin.
 *
 * Why a plugin: the Figma MCP on the Starter plan stops after a handful of
 * calls, and this sheet is ~40 screens. A plugin builds the whole thing in one
 * run with no call limit, and re-running it rebuilds it from scratch (every
 * section it owns is named "NN · …" and is removed first).
 *
 * Built from src/*.js by build.mjs — edit those, not code.js.
 */

// ---------------------------------------------------------------- tokens ---
// 17 roles per app theme. The first nine map onto src/ui/theme.ts
// (bg, surface, surfaceAlt→raised, border→line, fg→ink, fgDim→ink2,
// fgFaint→ink3, accent, danger); the rest are new.
const ROLES = ['bg', 'surface', 'raised', 'line', 'ink', 'ink2', 'ink3', 'accent', 'onAccent', 'danger', 'rule', 'margin', 'g1', 'g2', 'g3', 'g4', 'g5']
const THEMES = {
  Midnight: '0B1020 121A2F 1A2440 26304F EEF1F8 A2ABC3 66708E 8AB0FF 0B1020 FF6B5E 1C2742 5A3346 8AB0FF F2B66D 7DD3B0 E98FB6 B7A0FF',
  Daylight: 'F5F5F1 FFFFFF ECECE7 DFDED8 16171B 5B5D64 94959B 2A57DE FFFFFF D53A2A E6E9EF F0C7C4 2A57DE D07A1E 23926A C2457E 6E4FD6',
  Paper: 'F3EEE2 FFFDF6 E9E2D1 D9CFBA 29251F 675F51 A0978A 2D4C8C FFFFFF BF3A2B CFDCEB E6A6A2 F0CF5A A3D1BC EFAEA8 AFC6EA CDB7E4',
  Sepia: 'EEE3CC F7EED9 E4D5B7 D3BF9B 3A2E21 6C5A43 9F8A6B 9A4719 FFF8EC A33120 DECDAA D9A08A 9A4719 56713D 2F5D7C 8C3D5E B48A2C',
  Forest: '0E1613 15201B 1D2B24 293930 E5EEE8 A1B4A8 6A8074 93D5A2 0E1613 F2775F 17241E 4A3530 93D5A2 E8C46B 82BBD8 E2917C C5A9E2',
  Ember: '15110D 1F1914 2A221B 3A3027 F2E8DA BBA992 85735E E2A653 15110D F06B4F 2A221B 4E2E25 74302C 22405F 2F4F3E 7E5D1F 4E3157',
  Terminal: '0A0C09 10130E 171B14 2A3225 D5E2C4 92A282 5B6A50 A8E361 0A0C09 FF6E5A 141911 3A2A22 A8E361 FFB454 6CC5EA F27DAA C7A3FF',
  OLED: '000000 0C0C0E 161619 242428 F2F2F2 A5A5AC 6A6A71 F4C75B 000000 FF6159 111114 3B2222 F4C75B 8AB0FF 7DD3B0 E98FB6 B7A0FF',
}
const RROLES = ['page', 'ink', 'ink2', 'link', 'code']
const READ = {
  Paper: 'FBF8F1 25221D 6B645A 2D4C8C F0EBDF', Sepia: 'F3E7CF 46382A 7A6650 9A4719 E8DABD', Mist: 'ECF0EA 1E2620 5B665D 2E6B4F DFE5DC',
  Dusk: '1D2130 D6DAE4 9097A8 9DB8FF 262B3D', Night: '131316 C9CBD1 85878F 8AB0FF 1D1D22', OLED: '000000 B9B9BC 76767B F4C75B 121214',
}
const ROLE_DESC = { bg: 'Board / screen background', surface: 'Cards, sheets', raised: 'Inputs, chips, pressed rows', line: 'Hairlines and card borders', ink: 'Primary text', ink2: 'Secondary text', ink3: 'Tertiary text — meta and placeholders only', accent: 'Primary action, focus, selection', onAccent: 'Text and icons on accent', danger: 'Destructive', rule: 'Notebook ruled lines', margin: 'Notebook margin rule', g1: 'Group colour 1', g2: 'Group colour 2', g3: 'Group colour 3', g4: 'Group colour 4', g5: 'Group colour 5' }

let VM = {}
let TH = 'Midnight'
let MODE = null
const hx = h => { h = h.replace('#', ''); return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 } }
const toHex = c => '#' + [c.r, c.g, c.b].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('').toUpperCase()

async function ensureTokens() {
  const cols = await figma.variables.getLocalVariableCollectionsAsync()
  let col = cols.find(c => c.name === 'StackRead colour')
  if (!col) { col = figma.variables.createVariableCollection('StackRead colour'); col.renameMode(col.modes[0].modeId, 'Value') }
  MODE = col.modes[0].modeId
  const existing = {}
  for (const v of await figma.variables.getLocalVariablesAsync('COLOR')) if (v.variableCollectionId === col.id) existing[v.name] = v
  const put = (name, hex, scopes, desc) => {
    const v = existing[name] || figma.variables.createVariable(name, col, 'COLOR')
    v.setValueForMode(MODE, hx(hex)); v.scopes = scopes; v.description = desc; VM[name] = v
  }
  for (const [t, s] of Object.entries(THEMES)) s.split(' ').forEach((h, i) => put(`${t}/${ROLES[i]}`, h, ['ALL_FILLS', 'STROKE_COLOR', 'EFFECT_COLOR'], ROLE_DESC[ROLES[i]]))
  for (const [t, s] of Object.entries(READ)) s.split(' ').forEach((h, i) => put(`Reading/${t}/${RROLES[i]}`, h, ['ALL_FILLS', 'STROKE_COLOR'], 'Reader page theme — ' + RROLES[i]))
}
// A paint from a token ("ink" → current theme, "Paper/ink", "Reading/Night/page") or a raw "#hex".
const P = (k, o = 1) => {
  if (k[0] === '#') return { type: 'SOLID', color: hx(k), opacity: o }
  const v = VM[k.includes('/') ? k : TH + '/' + k]
  if (!v) throw new Error('no token ' + k)
  return figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: o }, 'color', v)
}
const F = (k, o) => [P(k, o)]
const tokenHex = name => toHex(VM[name].valuesByMode[MODE])

// ----------------------------------------------------------------- fonts ---
const FN = {
  ui: ['Geist', 'Regular'], uiM: ['Geist', 'Medium'], uiS: ['Geist', 'SemiBold'], uiB: ['Geist', 'Bold'], uiL: ['Geist', 'Light'],
  mono: ['Geist Mono', 'Regular'], monoM: ['Geist Mono', 'Medium'],
  fr: ['Fraunces', 'Regular'], frI: ['Fraunces', 'Italic'], frS: ['Fraunces', 'SemiBold'], frSI: ['Fraunces', 'SemiBold Italic'], frL: ['Fraunces', 'Light'], frLI: ['Fraunces', 'Light Italic'],
  lit: ['Literata', 'Regular'], litI: ['Literata', 'Italic'], litS: ['Literata', 'SemiBold'],
  plex: ['IBM Plex Mono', 'Regular'], plexM: ['IBM Plex Mono', 'Medium'], plexS: ['IBM Plex Mono', 'SemiBold'], plexI: ['IBM Plex Mono', 'Italic'],
  cav: ['Caveat', 'Regular'], cavB: ['Caveat', 'Bold'],
  ins: ['Instrument Serif', 'Regular'], insI: ['Instrument Serif', 'Italic'],
  dm: ['DM Sans', 'Regular'], dmM: ['DM Sans', 'Medium'], dmS: ['DM Sans', 'SemiBold'], dmB: ['DM Sans', 'Bold'],
  jb: ['JetBrains Mono', 'Regular'], jbM: ['JetBrains Mono', 'Medium'], jbB: ['JetBrains Mono', 'Bold'], jbI: ['JetBrains Mono', 'Italic'],
  ss: ['Source Serif 4', 'Regular'], ssS: ['Source Serif 4', 'SemiBold'], ssI: ['Source Serif 4', 'Italic'],
  atk: ['Atkinson Hyperlegible', 'Regular'], atkB: ['Atkinson Hyperlegible', 'Bold'],
  nr: ['Newsreader', 'Regular'], nrI: ['Newsreader', 'Italic'], nrS: ['Newsreader', 'SemiBold'],
}
const loadFonts = () => Promise.all(Object.values(FN).map(([family, style]) => figma.loadFontAsync({ family, style })))

// --------------------------------------------------------------- builders ---
// T: text. o = { f font key, s size, lh line height, ls letter-spacing %, c colour token, o opacity,
//   w fixed width (wraps), max max lines, al align, u uppercase, n name, deco }
const T = (s, o = {}) => {
  const t = figma.createText(); const [family, style] = FN[o.f || 'ui']
  t.fontName = { family, style }; t.characters = s; t.fontSize = o.s || 14
  if (o.lh) t.lineHeight = { unit: 'PIXELS', value: o.lh }
  if (o.ls != null) t.letterSpacing = { unit: 'PERCENT', value: o.ls }
  t.fills = F(o.c || 'ink', o.o)
  if (o.al) t.textAlignHorizontal = o.al
  if (o.u) t.textCase = 'UPPER'
  if (o.deco) t.textDecoration = o.deco
  if (o.w) { t.resize(o.w, Math.max(1, t.height)); t.textAutoResize = 'HEIGHT' }
  if (o.max) { t.textAutoResize = 'HEIGHT'; t.textTruncation = 'ENDING'; t.maxLines = o.max }
  t.name = o.n || s.slice(0, 28)
  return t
}
const pad = (f, p) => { const a = Array.isArray(p) ? (p.length === 2 ? [p[0], p[1], p[0], p[1]] : p) : [p, p, p, p];[f.paddingTop, f.paddingRight, f.paddingBottom, f.paddingLeft] = a }
const strokeIt = (f, o) => { if (o.stroke) { f.strokes = F(o.stroke, o.so); f.strokeWeight = o.sw || 1; f.strokeAlign = 'INSIDE'; if (o.dash) f.dashPattern = o.dash } }
// AL: auto-layout frame. 'H' | 'V'. Hugs both axes unless w/h given.
const AL = (d, o = {}) => {
  const f = figma.createFrame(); f.layoutMode = d === 'H' ? 'HORIZONTAL' : 'VERTICAL'
  f.primaryAxisSizingMode = 'AUTO'; f.counterAxisSizingMode = 'AUTO'; f.clipsContent = !!o.clip
  f.fills = o.fill ? F(o.fill, o.fo) : []; f.itemSpacing = o.gap ?? 0
  if (o.p != null) pad(f, o.p)
  if (o.r != null) f.cornerRadius = o.r
  strokeIt(f, o)
  if (o.ai) f.counterAxisAlignItems = o.ai
  if (o.jc) f.primaryAxisAlignItems = o.jc
  f.name = o.n || 'stack'
  if (o.w != null || o.h != null) {
    f.resize(o.w ?? Math.max(1, f.width), o.h ?? Math.max(1, f.height)); const H = d === 'H'
    if (o.w == null) { if (H) f.primaryAxisSizingMode = 'AUTO'; else f.counterAxisSizingMode = 'AUTO' }
    if (o.h == null) { if (H) f.counterAxisSizingMode = 'AUTO'; else f.primaryAxisSizingMode = 'AUTO' }
  }
  if (o.fx) f.effects = o.fx
  if (o.rot) f.rotation = o.rot
  return f
}
// FR: plain frame, children positioned absolutely.
const FR = (w, h, o = {}) => { const f = figma.createFrame(); f.resize(w, h); f.fills = o.fill ? F(o.fill, o.fo) : []; if (o.r != null) f.cornerRadius = o.r; strokeIt(f, o); f.name = o.n || 'frame'; f.clipsContent = o.clip !== false; if (o.fx) f.effects = o.fx; if (o.rot) f.rotation = o.rot; return f }
const RC = (w, h, fill, o = {}) => { const r = figma.createRectangle(); r.resize(w, h); r.fills = fill ? F(fill, o.o) : []; if (o.r != null) r.cornerRadius = o.r; strokeIt(r, o); r.name = o.n || 'rect'; if (o.rot) r.rotation = o.rot; if (o.fx) r.effects = o.fx; return r }
const EL = (d, fill, o = {}) => { const e = figma.createEllipse(); e.resize(d, d); e.fills = fill ? F(fill, o.o) : []; strokeIt(e, o); e.name = o.n || 'dot'; return e }
const add = (p, ...cs) => { for (const c of cs) if (c) p.appendChild(c); return p }
const fw = n => { if (n.type === 'TEXT') n.textAutoResize = 'HEIGHT'; n.layoutSizingHorizontal = 'FILL'; return n }
const fh = n => { n.layoutSizingVertical = 'FILL'; return n }
// spacer that takes the remaining room on the parent's main axis
const grow = p => { const s = figma.createFrame(); s.fills = []; s.name = 'spacer'; s.resize(1, 1); p.appendChild(s); s.layoutGrow = 1; return s }
const gap = (p, n) => { const s = figma.createFrame(); s.fills = []; s.name = 'gap'; s.resize(n, n); p.appendChild(s); return s }
// place a child absolutely inside any frame (auto-layout or not)
const at = (p, n, x, y) => { p.appendChild(n); if (p.layoutMode && p.layoutMode !== 'NONE') n.layoutPositioning = 'ABSOLUTE'; n.x = x; n.y = y; return n }
const SH = (y, blur, a, col = '#000000', x = 0, spread = 0) => ({ type: 'DROP_SHADOW', color: { ...hx(col), a }, offset: { x, y }, radius: blur, spread, visible: true, blendMode: 'NORMAL' })

// ----------------------------------------------------------------- icons ---
// One stroke set: 24 grid, 1.75 stroke, round caps. Drawn for this app.
const IC = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.6" fill="#000" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="#000" stroke="none"/><circle cx="18.5" cy="12" r="1.6" fill="#000" stroke="none"/>',
  back: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
  down: '<path d="M7 10l5 5 5-5"/>',
  right: '<path d="M10 7l5 5-5 5"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  check: '<path d="M5.5 12.5l4 4 9-9.5"/>',
  toc: '<path d="M9 7h11M9 12h11M9 17h11"/><circle cx="4.75" cy="7" r="1.1" fill="#000" stroke="none"/><circle cx="4.75" cy="12" r="1.1" fill="#000" stroke="none"/><circle cx="4.75" cy="17" r="1.1" fill="#000" stroke="none"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  zip: '<path d="M4.5 8.5h15v10a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5zM3.5 4.5h17v4h-17zM10 12h4"/>',
  file: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/>',
  filePlus: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5M12 11v6M9 14h6"/>',
  move: '<path d="M5 8.5h13.5M15 5l3.5 3.5L15 12M19 15.5H5.5M9 12l-3.5 3.5L9 19"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/>',
  open: '<path d="M7 17L17 7M9 7h8v8"/>',
  contrast: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="#000"/>',
  board: '<rect x="4" y="4.5" width="16" height="4.5" rx="1.5"/><rect x="4" y="11" width="7" height="8.5" rx="1.5"/><rect x="13" y="11" width="7" height="8.5" rx="1.5"/>',
  upload: '<path d="M12 15.5V4.5M7.5 9L12 4.5 16.5 9M5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  restore: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4"/>',
  find: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="M15 15l5 5M8 10.5h5"/>',
  bookmark: '<path d="M7 4.5h10v15.5l-5-3.6-5 3.6z"/>',
  swipe: '<path d="M4 12h16M15.5 7.5L20 12l-4.5 4.5M8.5 7.5L4 12l4.5 4.5"/>',
  arrowDown: '<path d="M12 4.5v15M7 14.5l5 5 5-5"/>',
  sun: '<circle cx="12" cy="12" r="3.75"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  type: '<path d="M3.5 18.5L8.5 5.5h1l5 13M5.3 14h7.4M15 18.5l2.9-7.5h.6l2.9 7.5M15.9 16h4.6"/>',
  spacing: '<path d="M5 6.5h14M5 12h14M5 17.5h14"/>',
  margins: '<path d="M4.5 4.5v15M19.5 4.5v15M8.5 8h7M8.5 12h7M8.5 16h4"/>',
  edit: '<path d="M5 19h3.5L19 8.5 15.5 5 5 15.5z"/>',
  grid: '<rect x="4.5" y="4.5" width="6" height="6" rx="1.2"/><rect x="13.5" y="4.5" width="6" height="6" rx="1.2"/><rect x="4.5" y="13.5" width="6" height="6" rx="1.2"/><rect x="13.5" y="13.5" width="6" height="6" rx="1.2"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.2-1-1.6-1-2.6 0-.9.7-1.6 1.7-1.6h2.2a3.8 3.8 0 0 0 3.8-3.8C20.5 6.9 16.7 3.5 12 3.5z"/><circle cx="7.8" cy="11" r="1.1" fill="#000" stroke="none"/><circle cx="10.5" cy="7.6" r="1.1" fill="#000" stroke="none"/><circle cx="14.8" cy="7.8" r="1.1" fill="#000" stroke="none"/>',
}
const svgNode = (inner, w, h, vb, c, sw = 1.75) => {
  const n = figma.createNodeFromSvg(`<svg width="${w}" height="${h}" viewBox="${vb}" fill="none" stroke="#000" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`)
  n.fills = []; n.clipsContent = false
  for (const v of n.findAll(() => true)) {
    if ('strokes' in v && v.strokes.length) v.strokes = F(c)
    if ('fills' in v && v.fills.length && v.type !== 'FRAME') v.fills = F(c)
  }
  return n
}
const I = (k, sz = 20, c = 'ink', sw = 1.75) => { const n = svgNode(IC[k], sz, sz, '0 0 24 24', c, sw); n.name = 'icon/' + k; return n }
const SYS = '<path d="M1 12h2.5v-3H1zM5 12h2.5V7H5zM9 12h2.5V4.5H9zM13 12h2.5V2H13z" fill="#000" stroke="none"/><path d="M21 5.2a8 8 0 0 1 11 0M23.2 7.6a4.8 4.8 0 0 1 6.6 0" stroke-width="1.6"/><circle cx="26.5" cy="10.4" r="1.2" fill="#000" stroke="none"/><rect x="37.5" y="2.5" width="13" height="9" rx="2.2" stroke-width="1.2"/><rect x="39.3" y="4.3" width="8.2" height="5.4" rx="1" fill="#000" stroke="none"/><path d="M52.3 5.6v2.8" stroke-width="1.4"/>'

// ------------------------------------------------------------ data model ---
// The board shown in every look. The first two groups are the real library
// in the screenshots; the third shows the non-Markdown formats.
const GROUPS = [
  {
    name: 'JavaSpringBootNotes', count: 106, c: 'g1', files: [
      { no: '01', title: 'Prerequisites', file: '01-prerequisites.md', fmt: 'MD', size: '3.2 KB', p: 1, snip: 'Before installing anything, make sure you have the right mental model and tools in place.' },
      { no: '02', title: 'Install JDK and Tools', file: '02-install-jdk-and-tools.md', fmt: 'MD', size: '7.2 KB', p: 0.35, snip: 'Step-by-step install instructions for Windows, macOS and Linux.' },
      { no: '03', title: 'Your first Spring app', file: '03-your-first-spring-app.md', fmt: 'MD', size: '6.8 KB', p: 0.6, snip: 'Build, run and call a “Hello World” REST API in under ten minutes.' },
      { no: '04', title: 'How to use these notes', file: '04-how-to-use-these-notes.md', fmt: 'MD', size: '5.8 KB', p: 0, snip: 'How the modules fit together, and the order to read them in.' }]
  },
  {
    name: 'SQLnotes', count: 54, c: 'g2', files: [
      { no: '01', title: 'SQL FAQ (PostgreSQL)', file: 'faq.md', fmt: 'MD', size: '12 KB', p: 0.08, snip: 'Forty-plus short answers. Primary dialect: PostgreSQL.' },
      { no: '02', title: 'Glossary, A–Z', file: 'glossary.md', fmt: 'MD', size: '9.4 KB', p: 0, snip: 'Terms used throughout SQL Mastery Notes. ACID — Atomicity, Consistency…' },
      { no: '03', title: 'Logical execution order', file: 'sql-execution-order.md', fmt: 'MD', size: '4.1 KB', p: 0.4, snip: 'SQL is declarative: you describe the result set; the engine chooses how.' },
      { no: '04', title: 'Window functions', file: 'window-functions.md', fmt: 'MD', size: '8.0 KB', p: 0, snip: 'OVER, PARTITION BY and frames, with a running-total example.' }]
  },
  {
    name: 'Thesis references', count: 7, c: 'g3', files: [
      { no: '01', title: 'Attention Is All You Need', file: 'vaswani-2017.pdf', fmt: 'PDF', size: '2.1 MB', p: 0.7, snip: '15 pages · Vaswani et al., 2017' },
      { no: '02', title: 'Designing Data-Intensive Applications', file: 'ddia.epub', fmt: 'EPUB', size: '8.4 MB', p: 0.22, snip: 'Chapter 3 · Storage and Retrieval' },
      { no: '03', title: 'Results — draft 3', file: 'results-draft-3.docx', fmt: 'DOCX', size: '340 KB', p: 0, snip: '4.2 Throughput under contention' },
      { no: '04', title: 'Benchmarks', file: 'benchmarks.xlsx', fmt: 'XLSX', size: '88 KB', p: 0, snip: '3 sheets · 1,204 rows' }]
  },
]
const TOTAL = 167

// ------------------------------------------------------------- doc chrome ---
// The sheet's own presentation (not app UI) uses a fixed neutral palette.
const D = { bg: '#FAF8F3', ink: '#1B1A17', dim: '#6E6A62', line: '#E6E1D6', acc: '#C8502A', card: '#FFFFFF' }
const docFrame = (name, kicker, title, desc, w = 1600) => {
  const f = AL('V', { n: name, w, p: 96, gap: 40, fill: D.bg })
  add(f, T(kicker, { f: 'monoM', s: 13, ls: 8, c: D.acc }))
  add(f, T(title, { f: 'fr', s: 40, lh: 48, c: D.ink, w: Math.min(1200, w - 192) }))
  if (desc) add(f, T(desc, { s: 17, lh: 27, c: D.dim, w: Math.min(1000, w - 192) }))
  return f
}
const subhead = (p, title, desc, w = 1000) => { add(p, T(title, { f: 'frS', s: 30, lh: 36, c: D.ink })); if (desc) add(p, T(desc, { s: 16, lh: 25, c: D.dim, w })) }
// A phone with its caption underneath.
const phone = (screen, title, note) => {
  const c = AL('V', { gap: 14, n: 'Phone / ' + title })
  screen.cornerRadius = 28; screen.strokes = F('#000000', 0.12); screen.strokeWeight = 1; screen.strokeAlign = 'OUTSIDE'
  screen.effects = [SH(24, 48, 0.12), SH(2, 6, 0.08)]
  add(c, screen)
  add(c, T(title, { f: 'uiS', s: 15, lh: 20, c: D.ink, w: 360 }))
  if (note) add(c, T(note, { s: 13, lh: 19, c: D.dim, w: 360 }))
  return c
}
const phoneRow = (p, items, g = 48) => { const r = AL('H', { gap: g, n: 'Phones' }); add(p, r); for (const it of items) add(r, it); return r }
// place a doc frame on the current page, wrapped in a named section
const SECTIONS = []
const place = (name, frame, x, y) => {
  const s = figma.createSection(); s.name = name; s.x = x; s.y = y
  s.appendChild(frame); frame.x = 0; frame.y = 0
  s.resizeWithoutConstraints(frame.width, frame.height)
  SECTIONS.push(s)
  return s
}
