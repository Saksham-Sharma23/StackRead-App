import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { buildViewerHtml } from '../renderers/webview/viewerHtml.ts'
import { formatOf, isKnownExtension, isRenderable } from '../storage/formats.ts'

/*
 * AUDIT4 B3–B8. B1 is pinned in `viewerSearch.test.ts` beside the restore path
 * it fixes; B2 in `archiveOffload.test.ts` with the phase-2 memo.
 *
 * Where a property can be run, it is: the viewer's link resolver is lifted out
 * of the emitted script, and the FTS index is exercised on Node's own SQLite
 * with the schema and upsert read straight out of `db.ts`, so neither can drift
 * from what ships.
 */

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

const THEME = {
  bg: '#000', fg: '#fff', fgDim: '#888', accent: '#09f',
  border: '#333', surfaceAlt: '#111', surface: '#222', gutter: '#0a0a0a',
}

function viewerScript(): string {
  const match = buildViewerHtml(THEME, 0).match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)
  assert.ok(match, 'viewer HTML contains no script block')
  return match[1]
}

/** A named function from the emitted viewer script, as a callable. */
function viewerFunction<T extends (...args: never[]) => unknown>(name: string): T {
  const script = viewerScript()
  const start = script.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `viewer has no function ${name}`)
  let depth = 0
  let end = script.indexOf('{', start)
  for (; end < script.length; end++) {
    if (script[end] === '{') depth++
    else if (script[end] === '}' && --depth === 0) break
  }
  return new Function(`${script.slice(start, end + 1)}; return ${name};`)() as T
}

/* ==================== B3: images after chapter 3 ==================== */

test('B3: the image thunk waits for phase 2 and reads the live image map', () => {
  const epub = source('renderers/webview/epub.ts')
  const fetch = epub.slice(epub.indexOf('const fetchImages'), epub.indexOf('let imagesInFlight'))

  const rest = fetch.indexOf('await loadRest()')
  const read = fetch.indexOf('for (const [token, image] of images)')
  assert.ok(rest > 0 && read > rest, 'phase 2 must register its images before the list is read')
  assert.doesNotMatch(fetch, /imageList/, 'the phase-1 snapshot must not decide what is fetched')

  assert.ok(
    /loadImages: mayHaveImages \? loadImages : undefined/.test(epub),
    'a book whose images start after the first paint must still get an image thunk',
  )
})

/* ==================== B4: partial failures ==================== */

test('B4: a failed image or batch is a warning, not a failed open', () => {
  const script = viewerScript()
  assert.ok(script.includes("post({ type: 'warn', message: 'image: '"))
  assert.ok(script.includes("post({ type: 'warn', message: 'batch decode failed: '"))
  assert.doesNotMatch(script, /type: 'error', message: '(image|batch)/)

  const renderer = source('renderers/WebViewRenderer.tsx')
  const warn = renderer.slice(renderer.indexOf("msg.type === 'warn'"), renderer.indexOf("msg.type === 'link'"))
  assert.ok(warn.length > 0)
  assert.doesNotMatch(warn, /setError/, 'a warning must never replace the document')
})

/* ==================== B5: zoom lock ==================== */

test('B5: the zoom lock is cleared when the active file changes, before the new renderer reports', () => {
  const pager = source('components/HorizontalPager.tsx')
  assert.ok(
    /useLayoutEffect\(\(\) => \{\s*zoomed\.value = false\s*\n\s*setIsZoomed\(false\)\s*\n\s*\}, \[activeId, zoomed\]\)/.test(pager),
    'a layout effect keyed on the active file must reset both halves of the lock',
  )
})

/* ==================== B6: links ==================== */

test('B6: in-book hrefs resolve against the chapter they appear in', () => {
  const resolve = viewerFunction<(base: string, href: string) => string>('resolveHref')

  assert.equal(resolve('OEBPS/Text/ch1.xhtml', '#note3'), 'OEBPS/Text/ch1.xhtml#note3', 'fragment-only stays in its chapter')
  assert.equal(resolve('OEBPS/Text/ch1.xhtml', 'ch2.xhtml#n1'), 'OEBPS/Text/ch2.xhtml#n1')
  assert.equal(resolve('OEBPS/Text/ch1.xhtml', '../Notes/notes.xhtml#n1'), 'OEBPS/Notes/notes.xhtml#n1')
  assert.equal(resolve('OEBPS/Text/ch1.xhtml', './ch3.xhtml'), 'OEBPS/Text/ch3.xhtml')
  assert.equal(resolve('OEBPS/Text/ch1.xhtml', 'My%20Chapter.xhtml'), 'OEBPS/Text/My Chapter.xhtml', 'percent-encoding is decoded')
  assert.equal(resolve('', '#top'), '#top', 'a document with no chapters keeps its fragment')
  assert.equal(resolve('OEBPS/ch1.xhtml', '/OEBPS/ch9.xhtml'), 'OEBPS/ch9.xhtml', 'root-relative drops the slash')
  // Malformed escapes are kept as written rather than throwing out of the click.
  assert.equal(resolve('a/b.xhtml', '%E0%A4%A.xhtml'), 'a/%E0%A4%A.xhtml')
})

test('B6: every link tap is intercepted; external ones go to the host, never to a navigation', () => {
  const script = viewerScript()
  const handler = script.slice(script.indexOf("start.closest('a, area')") - 200, script.indexOf('function render('))
  assert.ok(handler.includes("closest('a, area')"), 'image-map areas and SVG anchors must be caught too')
  assert.ok(handler.includes('e.preventDefault();'), 'the browser must never follow a document link')
  assert.ok(/post\(\{ type: 'link', href: href\.slice\(0, 2048\) \}\)/.test(handler))
  assert.ok(/\}, true\);/.test(handler), 'capture phase, so nothing sees the click first')

  const renderer = source('renderers/WebViewRenderer.tsx')
  const offer = renderer.slice(renderer.indexOf('function offerExternalLink'), renderer.indexOf('function allowOnlyBundledContent'))
  assert.ok(/if \(!\/\^https\?:\\\/\\\/\/i\.test\(url\)\)/.test(offer), 'only web links may be offered')
  assert.ok(
    offer.indexOf('Alert.alert(') < offer.indexOf('Linking.openURL'),
    'the user must be asked before anything opens',
  )
})

/* ==================== B7: the FTS index stays in step ==================== */

/** The schema `getDb()` runs, read from db.ts. */
function schemaSql(): string {
  const db = source('storage/db.ts')
  const start = db.indexOf('opened.execSync(`') + 'opened.execSync(`'.length
  return db.slice(start, db.indexOf('`)', start))
}

/** `applyDiff`'s file upsert, assembled from its string pieces in db.ts. */
function upsertSql(): string {
  const db = source('storage/db.ts')
  const apply = db.slice(db.indexOf('export function applyDiff'))
  const stmt = apply.slice(apply.indexOf("'INSERT INTO files'"), apply.indexOf('[', apply.indexOf("'INSERT INTO files'")))
  return [...stmt.matchAll(/'([^']*)'/g)].map((m) => m[1]).join('')
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql())
  return db
}

function upsert(db: DatabaseSync, id: string, name: string, groupId = 'g1'): void {
  db.prepare(upsertSql()).run(id, name, `${id}.epub`, 'epub', groupId, 0, null, null, null, null, 100, 1)
}

function search(db: DatabaseSync, term: string): string[] {
  return (
    db.prepare(
      'SELECT f.id FROM files_fts JOIN files f ON f.rowid = files_fts.rowid WHERE files_fts MATCH ?',
    ).all(`"${term}"*`) as { id: string }[]
  ).map((r) => r.id)
}

test('B7: a renamed file stops matching its old name', () => {
  const db = freshDb()
  upsert(db, 'a', 'Moby Dick')
  upsert(db, 'a', 'Treasure Island')

  assert.deepEqual(search(db, 'Moby'), [], 'the old name must leave the index')
  assert.deepEqual(search(db, 'Treasure'), ['a'])
})

test('B7: re-saving a file does not duplicate its search hit', () => {
  const db = freshDb()
  upsert(db, 'a', 'Moby Dick')
  // A move, a reorder, a cover landing: the row is saved again, name unchanged.
  upsert(db, 'a', 'Moby Dick', 'g2')
  upsert(db, 'a', 'Moby Dick', 'g3')

  assert.deepEqual(search(db, 'Moby'), ['a'], 'one file, one hit')
  const counted = (db.prepare('SELECT count(*) AS n FROM files_fts WHERE files_fts MATCH ?').get('"Moby"*') as { n: number }).n
  assert.equal(counted, 1, 'the total searchFiles reports must count the file once')
  const integrity = db.prepare("INSERT INTO files_fts (files_fts) VALUES ('integrity-check')")
  assert.doesNotThrow(() => integrity.run(), 'the FTS index must stay consistent with its content table')
})

test('B7: a deleted file\'s old name never attaches to a later file', () => {
  const db = freshDb()
  upsert(db, 'a', 'Alpha')
  upsert(db, 'b', 'Secret Diary')
  upsert(db, 'b', 'Renamed')
  db.prepare('DELETE FROM files WHERE id = ?').run('b')
  upsert(db, 'c', 'Cookbook')
  assert.deepEqual(search(db, 'Secret'), [], 'no orphan may outlive its row')
  assert.deepEqual(search(db, 'Cookbook'), ['c'])
})

test('B7: the upsert updates in place rather than replacing the row', () => {
  const sql = upsertSql()
  assert.ok(/ON CONFLICT\(id\) DO UPDATE SET/.test(sql))
  assert.doesNotMatch(sql, /OR REPLACE/)

  const db = freshDb()
  upsert(db, 'a', 'First')
  const before = (db.prepare('SELECT rowid FROM files WHERE id = ?').get('a') as { rowid: number }).rowid
  upsert(db, 'b', 'Second')
  upsert(db, 'a', 'Renamed')
  const after = (db.prepare('SELECT rowid FROM files WHERE id = ?').get('a') as { rowid: number }).rowid
  assert.equal(after, before, 'a replaced row gets a new rowid; an updated one keeps it')
})

test('B7: the bug being fixed is real — INSERT OR REPLACE leaves orphans that surface', () => {
  /*
   * Recorded so the next reader does not "simplify" the upsert back, and
   * stated precisely, because the obvious claim is wrong. A REPLACEd row gets a
   * new rowid, so its stale index entry points at a row that no longer exists
   * and a JOIN hides it: a renamed file does *not* visibly keep its old name.
   * The orphans do surface in two ways, both pinned here.
   */
  const db = freshDb()
  const replace = db.prepare(
    'INSERT OR REPLACE INTO files (id, name, storedName, format, groupId, orderInGroup, lastScroll, lastProgress, thumb, thumbhash, size, addedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const save = (id: string, name: string) =>
    replace.run(id, name, `${id}.epub`, 'epub', 'g1', 0, null, null, null, null, 100, 1)

  save('a', 'Moby Dick')
  save('a', 'Moby Dick') // re-saved: a move, a reorder, a cover landing
  save('a', 'Moby Dick')

  // 1. `searchFiles` counts on the FTS table alone, so orphans inflate "N results".
  const counted = (db.prepare('SELECT count(*) AS n FROM files_fts WHERE files_fts MATCH ?').get('"Moby"*') as { n: number }).n
  assert.ok(counted > 1, `one file, but the total says ${counted}`)

  // 2. An orphan's rowid can be handed to an unrelated file, which then matches
  //    a name it never had. Here: `b` is renamed (orphaning its rowid), deleted,
  //    and `c` is created into the freed rowid.
  const fresh = freshDb()
  const rep2 = fresh.prepare(
    'INSERT OR REPLACE INTO files (id, name, storedName, format, groupId, orderInGroup, addedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  rep2.run('a', 'Alpha', 'a', 'epub', 'g', 0, 1)
  rep2.run('b', 'Secret Diary', 'b', 'epub', 'g', 1, 1)
  rep2.run('b', 'Renamed', 'b', 'epub', 'g', 1, 1)
  fresh.prepare('DELETE FROM files WHERE id = ?').run('b')
  rep2.run('c', 'Cookbook', 'c', 'epub', 'g', 2, 1)
  assert.deepEqual(search(fresh, 'Secret'), ['c'], 'a cookbook now matches a deleted file\'s old name')
})

test('B7: existing installs rebuild the index once', () => {
  const db = source('storage/db.ts')
  assert.ok(/const FTS_INDEX_VERSION = '2'/.test(db))
  assert.ok(/getMetaFrom\(opened, 'ftsBuilt'\) !== FTS_INDEX_VERSION/.test(db))
})

/* ==================== B8: prototype keys ==================== */

test('B8: prototype property names are not file formats', () => {
  for (const name of ['notes.constructor', 'x.__proto__', 'a.toString', 'b.hasOwnProperty', 'c.valueOf']) {
    assert.equal(isKnownExtension(name), false, `${name} must not be importable`)
    assert.equal(formatOf(name), 'text', `${name} must fall back, not resolve to Object.prototype`)
    assert.equal(isRenderable(name), false)
  }
  // Real formats are unaffected.
  assert.equal(isKnownExtension('book.epub'), true)
  assert.equal(formatOf('book.EPUB'), 'epub')
})
