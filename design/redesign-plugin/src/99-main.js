// ================================================================== MAIN ===
const PAGE_NAMES = ['1 · Direction & Foundations', '2 · Looks & Screens', '3 · Reading, Themes & Appearance']
const OWNED = /^\d\d · /

async function ensurePages() {
  const pages = [...figma.root.children]
  while (pages.length < 3) pages.push(figma.createPage())
  pages.slice(0, 3).forEach((p, i) => { p.name = PAGE_NAMES[i] })
  return pages
}
// Lay sections out in columns; each column stacks its sections downward.
async function buildPage(page, columns, errors) {
  await figma.setCurrentPageAsync(page)
  await page.loadAsync()
  for (const n of [...page.children]) if (OWNED.test(n.name)) n.remove()
  let x = 0
  for (const col of columns) {
    let y = 0, w = 0
    for (const [name, fn] of col) {
      let frame
      try { frame = fn() } catch (e) { errors.push(`${name}: ${e.message}`); continue }
      place(name, frame, x, y)
      y += frame.height + 240; w = Math.max(w, frame.width)
    }
    x += w + 240
  }
}
async function main() {
  await loadFonts()
  await ensureTokens()
  const pages = await ensurePages()
  const errors = []
  await buildPage(pages[0], [
    [['00 · Read me', buildCover], ['01 · What reads as generic today', buildCritique]],
    [['02 · Colour themes', buildThemes]],
    [['03 · Typography', buildType], ['04 · Icons, marks, shape', buildIcons]],
  ], errors)
  await buildPage(pages[1], [
    [['05 · Four looks', buildLooks], ['06 · Modern — every screen', buildModernScreens], ['07 · Notebook — screens', buildNotebookScreens], ['08 · Shelf & Terminal — screens', buildShelfTerminalScreens]],
  ], errors)
  await buildPage(pages[2], [
    [['09 · Reader anatomy', buildReaderAnatomy], ['10 · Reading themes', buildReadingThemes], ['11 · Reading fonts & Display', buildReadingFonts], ['12 · Appearance', buildAppearance], ['13 · Every theme', buildMatrix], ['14 · Mix and match', buildMix]],
  ], errors)
  await figma.setCurrentPageAsync(pages[0])
  if (figma.viewport) figma.viewport.scrollAndZoomIntoView(pages[0].children)
  return errors
}
main().then(errors => {
  figma.closePlugin(errors.length ? `Built with ${errors.length} problem(s): ${errors.join(' | ')}` : `StackRead redesign sheet built — ${SECTIONS.length} sections.`)
}).catch(e => figma.closePlugin('StackRead sheet failed: ' + (e && e.message)))
