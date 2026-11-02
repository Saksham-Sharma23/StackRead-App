// ---------------------------------------------------------- phone chrome ---
const SCR = (name, fill = 'bg') => AL('V', { n: name, w: 360, h: 800, fill, clip: true })
const SB = (c = 'ink', fill) => { const b = AL('H', { w: 360, h: 32, p: [0, 20], ai: 'CENTER', n: 'Status bar', fill }); add(b, T('9:41', { f: 'uiM', s: 13, c })); grow(b); add(b, svgNode(SYS, 54, 14, '0 0 54 14', c)); return b }
// Android gesture handle, drawn over whatever is at the bottom.
const GB = (s, c = 'ink') => { const bar = FR(360, 20, { n: 'Gesture bar' }); at(bar, RC(108, 4, c, { r: 2, o: 0.45 }), 126, 8); at(s, bar, 0, 780); return bar }
const iconBtn = (k, c = 'ink2', sz = 22) => { const b = AL('H', { w: 44, h: 44, ai: 'CENTER', jc: 'CENTER', n: 'Button / ' + k }); add(b, I(k, sz, c)); return b }
const textBtn = (label, font, c, s = 16) => { const b = AL('H', { w: 44, h: 44, ai: 'CENTER', jc: 'CENTER', n: 'Button / ' + label }); add(b, T(label, { f: font, s, c })); return b }
// put something behind the content of an auto-layout frame
const behind = (p, n, x, y) => { p.insertChild(0, n); n.layoutPositioning = 'ABSOLUTE'; n.x = x; n.y = y; return n }
const scrim = (s, a = 0.55) => at(s, RC(360, 800, '#000000', { o: a, n: 'Scrim' }), 0, 0)
// bottom sheet shell with a fixed height, so its position never depends on layout timing
const sheet = (s, h, fill = 'surface', r = 24) => {
  const sh = AL('V', { w: 360, h, fill, n: 'Sheet', clip: true })
  sh.topLeftRadius = r; sh.topRightRadius = r; sh.bottomLeftRadius = 0; sh.bottomRightRadius = 0
  at(s, sh, 0, 800 - h)
  const hd = AL('H', { jc: 'CENTER', p: [10, 0, 6, 0], n: 'Handle' }); add(sh, hd); fw(hd); add(hd, RC(36, 4, 'ink3', { r: 2, o: 0.6 }))
  return sh
}
const rowH = (p, o = {}) => { const r = AL('H', { ai: 'CENTER', gap: o.gap ?? 14, p: o.p ?? [0, 20], h: o.h, fill: o.fill, n: o.n || 'Row' }); add(p, r); fw(r); return r }
const toggle = (on = true) => { const t = FR(44, 26, { fill: on ? 'accent' : 'raised', r: 13, n: 'Switch', stroke: on ? null : 'line' }); at(t, EL(20, on ? 'onAccent' : 'ink3'), on ? 21 : 3, 3); return t }
// Light text on dark group colours, dark text on light ones — per theme.
const ON_G = { Paper: '#1B1A17', Midnight: '#0B1020', Sepia: '#FFF8EC', Daylight: '#FFFFFF', Forest: '#0E1613', Ember: '#F4ECDF', Terminal: '#0A0C09', OLED: '#000000' }
const readerText = [
  ['h1', 'Install JDK and Tools'],
  ['p', 'Step-by-step install instructions for Windows, macOS and Linux. After this file you’ll have a working Java 21 + Maven + Docker + IDE setup.'],
  ['h2', 'What you’ll learn'],
  ['li', 'How to install Java 21 (Eclipse Temurin) and set JAVA_HOME.'],
  ['li', 'How to install IntelliJ IDEA and point it at the JDK.'],
  ['li', 'How to verify everything works.'],
  ['code', '$ java -version\nopenjdk 21.0.4 2024-07-16 LTS'],
  ['p', 'If the version printed is older than 21, an earlier JDK is first on your PATH. Fix that before going on.'],
]
// render the shared reading sample with a set of fonts, onto reading tokens rt
const readingBody = (rt, o = {}) => {
  const R = k => `Reading/${rt}/${k}`
  const f = { h: o.h || 'litS', p: o.p || 'lit', code: o.code || 'jb', bullet: o.bullet || '•' }
  const c = AL('V', { gap: o.gap ?? 14, p: o.pad ?? [24, 24, 140, 24], n: 'Reading body' })
  const W = 360 - (o.pad ? o.pad[1] + o.pad[3] : 48)
  for (const [k, s] of readerText) {
    if (k === 'h1') { const t = T((o.h1prefix || '') + s, { f: f.h, s: o.h1 || 30, lh: (o.h1 || 30) + 6, c: R('ink'), w: W, ls: -1 }); if (o.h1prefix) t.setRangeFills(0, o.h1prefix.length, F(R('link'))); add(c, t) }
    if (k === 'h2') { const t = T((o.h2prefix || '') + s, { f: f.h, s: o.h2 || 21, lh: (o.h2 || 21) + 7, c: R('ink'), w: W }); if (o.h2prefix) t.setRangeFills(0, o.h2prefix.length, F(R('link'))); gap(c, 4); add(c, t) }
    if (k === 'p') add(c, T(s, { f: f.p, s: o.size || 17, lh: o.lh || 28, c: R('ink'), w: W }))
    if (k === 'li') {
      const r = AL('H', { gap: 10, n: 'li' }); add(c, r); fw(r); add(r, T(f.bullet, { f: f.p, s: o.size || 17, lh: o.lh || 28, c: R('ink2') }))
      const t = T(s, { f: f.p, s: o.size || 17, lh: o.lh || 28, c: R('ink') }); add(r, t); t.layoutGrow = 1; t.textAutoResize = 'HEIGHT'
      const i = s.indexOf('JAVA_HOME'); if (i >= 0) { t.setRangeFontName(i, i + 9, { family: FN[f.code][0], style: FN[f.code][1] }); t.setRangeFills(i, i + 9, F(R('link'))) }
    }
    if (k === 'code') { const b = AL('V', { p: [12, 14], r: o.codeR ?? 10, fill: R('code'), n: 'Code' }); add(c, b); fw(b); if (o.codeRule) { b.strokes = F(o.codeRule); b.strokeWeight = 0; b.strokeLeftWeight = 3; b.strokeTopWeight = 0; b.strokeRightWeight = 0; b.strokeBottomWeight = 0 } add(b, T(s, { f: f.code, s: 13, lh: 20, c: R('ink') })) }
  }
  return c
}
