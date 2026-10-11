import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { INCOMING_MIME_TYPES, extensionForMime } from '../storage/formats.ts'
import { UNNAMED, canReceive, findExisting, incomingFileName } from '../storage/incomingName.ts'

/*
 * "Open with" and "Share to StackRead".
 *
 * Before this the system picker was the only way in: tapping a PDF in Files,
 * Gmail or WhatsApp could never open StackRead. Received files are copied into
 * an "Opened files" group and opened.
 */

const require = createRequire(import.meta.url)

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
}

test('a received name is made safe to show, keeping its extension', () => {
  assert.equal(incomingFileName('Report.pdf', 'application/pdf'), 'Report.pdf')
  // Path separators are the sender's, never ours.
  assert.equal(incomingFileName('../../evil/notes.md', null), 'notes.md')
  assert.equal(incomingFileName('C:\\Users\\x\\book.epub', null), 'book.epub')
  assert.equal(incomingFileName('bad\u0000\u0007name.txt', null), 'badname.txt')
  assert.equal(incomingFileName('  spaced   out .pdf ', null), 'spaced out .pdf')

  const long = `${'a'.repeat(400)}.epub`
  const capped = incomingFileName(long, null)
  assert.ok(capped.length <= 160)
  assert.ok(capped.endsWith('.epub'), 'the cap keeps the extension')
})

test('a name without an extension takes one from the declared type', () => {
  assert.equal(incomingFileName('Invoice', 'application/pdf'), 'Invoice.pdf')
  assert.equal(incomingFileName(null, 'application/epub+zip'), `${UNNAMED}.epub`)
  assert.equal(incomingFileName('', null), UNNAMED)
  // Aliases senders use, and parameters on the type.
  assert.equal(incomingFileName('README', 'text/x-markdown'), 'README.md')
  assert.equal(incomingFileName('log', 'text/plain; charset=utf-8'), 'log.txt')
  // A type StackRead cannot render adds nothing, so the file is declined.
  assert.equal(incomingFileName('scan', 'image/tiff'), 'scan')
  assert.equal(extensionForMime('image/tiff'), undefined)
  assert.equal(extensionForMime('application/octet-stream'), undefined)
})

test('only renderable formats are received', () => {
  assert.ok(canReceive('a.pdf') && canReceive('b.cbz') && canReceive('c.docx'))
  assert.ok(!canReceive('scan.tiff'), 'known but not renderable')
  assert.ok(!canReceive('setup.exe') && !canReceive(UNNAMED))
})

test('a file already in the library is opened, not added again — by name and size', () => {
  const files = [
    { id: 'a', name: 'invoice.pdf', size: 1000 },
    { id: 'b', name: 'book.epub', size: 5000 },
  ]
  assert.equal(findExisting(files, 'invoice.pdf', 1000)?.id, 'a')
  assert.equal(findExisting(files, 'invoice.pdf', 1001), undefined, 'two different invoice.pdf files')
  assert.equal(findExisting(files, 'invoice.pdf', null), undefined, 'no size, no guess')
  assert.equal(findExisting(files, 'other.pdf', 1000), undefined)
})

test('the intent filters offer exactly the types StackRead can open', () => {
  const config = require('../../app.config.js')
  assert.deepEqual(config.INCOMING_MIME_TYPES, INCOMING_MIME_TYPES, 'app.config.js mirrors formats.ts')
  assert.ok(config.VIEW_TYPES.includes('application/octet-stream'), 'file managers send epub/cbz untyped')
  assert.ok(!config.SHARE_TYPES.includes('text/plain'), 'never in every text-sharing sheet')
  assert.ok(!config.SHARE_TYPES.includes('application/octet-stream'))

  const out = config({ config: { version: '0.0.0', android: { versionCode: 1, package: 'x' } } })
  const filters: Array<{ action: string; data: Array<Record<string, string>> }> = out.android.intentFilters
  const byAction = Object.fromEntries(filters.map((f) => [f.action, f]))
  assert.ok(byAction.VIEW.data.some((d) => d.scheme === 'content'))
  assert.ok(!byAction.VIEW.data.some((d) => d.scheme === 'file'), 'file:// is refused natively; never ask for it')
  // A type-only intent only matches a filter with no scheme.
  for (const action of ['SEND', 'SEND_MULTIPLE']) {
    assert.ok(byAction[action], `${action} filter present`)
    assert.ok(byAction[action].data.every((d) => !d.scheme && d.mimeType))
  }
})

test('the native side accepts only content URIs, once, and writes only inside the app', () => {
  const kt = source('modules/incoming-files/android/src/main/java/expo/modules/incomingfiles/IncomingFilesModule.kt')
  assert.ok(/\.filter \{ it\.scheme == ContentResolver\.SCHEME_CONTENT \}/.test(kt), 'extraction keeps content:// only')
  assert.ok(/if \(uri\.scheme != ContentResolver\.SCHEME_CONTENT\)/.test(kt), 'and every call re-checks')
  assert.ok(kt.includes('FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY'), 'a relaunch from recents is not a new file')
  assert.ok(/activity\.intent = Intent\(Intent\.ACTION_MAIN\)/.test(kt), 'a consumed launch intent is replaced')
  assert.ok(/target\.path\.startsWith\(root\.path \+ File\.separator\)/.test(kt), 'destination confined to filesDir')
  assert.ok(/catch \(error: Throwable\) \{\s*target\.delete\(\)/.test(kt), 'a partial copy is deleted')
})

test('receiving checks for a duplicate and for space before copying, off the JS thread', () => {
  const incoming = source('src/storage/incoming.ts')
  const loop = incoming.slice(incoming.indexOf('for (const item of items)'))
  const order = ['canReceive(name)', 'findExisting(', 'availableDiskSpace', 'Incoming.copyTo(']
  const at = order.map((s) => loop.indexOf(s))
  assert.ok(at.every((i) => i >= 0), 'all four steps present')
  assert.deepEqual([...at].sort((a, b) => a - b), at, `in this order: ${order.join(' → ')}`)
  assert.doesNotMatch(incoming, /copySync/, 'never a synchronous copy of a received file')
  // AUDIT4 D6: titles are personal; logs carry the extension only.
  assert.doesNotMatch(incoming, /console\.warn\([^)]*\$\{name\}/)
  // The inbox is found by id, so renaming it keeps it working.
  assert.ok(incoming.includes('storage.getString(INBOX_GROUP_KEY)'))
})

test('a received file waits for the library, and for a loading PDF before replacing it', () => {
  const app = source('App.tsx')
  assert.ok(app.includes('useIncomingFiles(loaded, openReceived)'), 'gated on the library having loaded')
  const open = app.slice(app.indexOf('const openReceived'), app.indexOf('const receiving'))
  assert.ok(/if \(current\) await whenPdfiumSettled\(PDF_CLOSE_GRACE_MS\)/.test(open), 'AUDIT4 A8')

  const hook = source('src/ui/useIncomingFiles.ts')
  assert.ok(hook.includes('chain = chain.then('), 'drains are serial')
  assert.ok(hook.includes('chain = chain.catch('), 'and one failure does not stop the next')
  assert.ok(hook.includes('Incoming.onIncoming(drain)'), 'warm arrivals are drained too')
})
