import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { zipSync, strToU8, type Zippable } from 'fflate'

import {
  ImportCancelled,
  ImportLimitError,
  MAX_IMPORT_FILES,
  groupTitleFor,
  isJunkPath,
  naturalCompare,
  summaryMessage,
  verdictFor,
} from '../storage/bulkImportRules.ts'
import { unpackZipEntries, type ZipTarget } from '../storage/zipUnpack.ts'

/*
 * "Import folder as group" and "Import ZIP as group".
 *
 * The ZIP path takes arbitrary archives from anywhere, so it is exercised here
 * on real ones — built with fflate, streamed through the same core the app
 * runs, with storage in memory.
 */

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
}

class MemoryTarget implements ZipTarget {
  chunks: Uint8Array[] = []
  closed = false
  removed = false
  readonly name: string
  // A plain field, not a parameter property: the test runner strips types only.
  constructor(name: string) {
    this.name = name
  }
  write(chunk: Uint8Array) {
    assert.ok(!this.closed, 'no write after close')
    this.chunks.push(chunk.slice())
  }
  close() {
    this.closed = true
  }
  remove() {
    this.removed = true
    this.chunks = []
  }
  get text() {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

async function unpack(
  zip: Uint8Array,
  options: { budget?: number; chunk?: number; cancelAfterReads?: number } = {},
) {
  const created: MemoryTarget[] = []
  let offset = 0
  let reads = 0
  const chunk = options.chunk ?? 64 * 1024
  const run = unpackZipEntries<MemoryTarget>({
    read: () => {
      reads += 1
      const out = zip.subarray(offset, offset + chunk)
      offset += out.length
      return out
    },
    create: (name) => {
      const t = new MemoryTarget(name)
      created.push(t)
      return t
    },
    budget: options.budget ?? 1024 * 1024 * 1024,
    cancelled: () => options.cancelAfterReads !== undefined && reads >= options.cancelAfterReads,
    pause: async () => {},
  })
  return { run, created }
}

test('natural order: vol2 before vol10, folders kept together, case ignored', () => {
  const names = ['Vol 10/01.png', 'vol 2/10.png', 'Vol 2/2.png', 'b.pdf', 'A.pdf', 'Vol 1/01.png']
  assert.deepEqual([...names].sort(naturalCompare), [
    'A.pdf',
    'b.pdf',
    'Vol 1/01.png',
    'Vol 2/2.png',
    'vol 2/10.png',
    'Vol 10/01.png',
  ])
  assert.ok(naturalCompare('page001', 'page1') > 0, 'equal value: fewer leading zeros first')
  assert.ok(naturalCompare('9'.repeat(40), '1' + '0'.repeat(40)) < 0, 'long digit runs do not overflow')
})

test('clutter is skipped silently; only renderable formats are imported', () => {
  assert.ok(isJunkPath('__MACOSX/Comics/._01.png'))
  assert.ok(isJunkPath('Comics/.DS_Store') && isJunkPath('.hidden/book.pdf'))
  assert.ok(isJunkPath('scans/Thumbs.db') && isJunkPath('desktop.ini'))
  assert.equal(verdictFor('Comics/01.png'), 'import')
  assert.equal(verdictFor('notes/setup.exe'), 'unsupported')
  assert.equal(verdictFor('scan.tiff'), 'unsupported', 'known but not renderable')
  assert.equal(verdictFor('inner.zip'), 'import', 'a nested ZIP is one file, not unpacked again')
  assert.equal(verdictFor('vol1.cbz'), 'import')
})

test('the group is named after the source, and never clashes', () => {
  assert.equal(groupTitleFor('Comics.zip', []), 'Comics')
  assert.equal(groupTitleFor('Comics.ZIP', []), 'Comics')
  assert.equal(groupTitleFor('primary:Download/Thesis refs', []), 'Thesis refs', 'Android picker names')
  assert.equal(groupTitleFor('Comics.zip', ['Comics']), 'Comics (2)')
  assert.equal(groupTitleFor('comics', ['Comics', 'COMICS (2)']), 'comics (3)', 'case-insensitive')
  assert.equal(groupTitleFor('.zip', []), 'Imported')
  assert.equal(groupTitleFor('a\u0000b', []), 'ab')
  assert.ok(groupTitleFor('x'.repeat(200), []).length <= 60)
})

test('the summary names each kind of problem, and nothing when there is none', () => {
  const base = { groupTitle: 'G', added: 3, unsupported: 0, failed: 0, overLimit: 0 }
  assert.equal(summaryMessage(base), null)
  const msg = summaryMessage({ ...base, unsupported: 2, failed: 1, overLimit: 5 })
  assert.ok(msg?.includes('2 file(s) skipped') && msg.includes('1 file(s)') && msg.includes('5 more'))
})

test('a ZIP unpacks to its supported files, flattened, without clutter', async () => {
  const files: Zippable = {
    'Comics/Vol 1/01.png': strToU8('png-1'),
    'Comics/Vol 1/02.png': [strToU8('png-2'), { level: 0 }], // stored, not deflated
    'Comics/readme.md': strToU8('# hi'),
    'Comics/setup.exe': strToU8('MZ'),
    '__MACOSX/Comics/._01.png': strToU8('junk'),
    'Comics/.DS_Store': strToU8('junk'),
    'Comics/inner.cbz': zipSync({ 'p.png': strToU8('x') }),
  }
  const { run, created } = await unpack(zipSync(files), { chunk: 7 })
  const result = await run

  assert.deepEqual(result.written.map((w) => w.name).sort(), ['01.png', '02.png', 'inner.cbz', 'readme.md'])
  assert.equal(result.unsupported, 1, 'setup.exe')
  assert.equal(result.failed, 0)
  const byName = Object.fromEntries(result.written.map((w) => [w.name, w.target.text]))
  assert.equal(byName['01.png'], 'png-1')
  assert.equal(byName['02.png'], 'png-2')
  assert.ok(created.every((t) => t.closed), 'every handle closed')
  // The full path is kept for ordering only.
  assert.ok(result.written.some((w) => w.path === 'Comics/Vol 1/01.png'))
})

test('a crafted entry name cannot point outside the library', async () => {
  const { run, created } = await unpack(
    zipSync({
      '../../../data/evil.pdf': strToU8('%PDF'),
      'a\\..\\b.txt': strToU8('t'),
      '/data/data/com.stackread.app/x.pdf': strToU8('%PDF'),
      'C:\\Windows\\y.txt': strToU8('y'),
    }),
  )
  const result = await run
  // Traversal entries are dropped outright, before a target exists for them.
  assert.ok(!created.some((t) => t.name === 'evil.pdf' || t.name === 'b.txt'))
  // Absolute paths keep only their last segment, as a display name.
  assert.deepEqual(result.written.map((w) => w.name).sort(), ['x.pdf', 'y.txt'])
  for (const w of result.written) assert.doesNotMatch(w.name, /[\\/]/)
})

test('a ZIP bomb stops at the byte budget, and everything written is removed', async () => {
  const zeros = new Uint8Array(8 * 1024 * 1024) // deflates to a few KB
  const zip = zipSync({ 'a.txt': strToU8('fine'), 'bomb.txt': zeros })
  assert.ok(zip.length < 100 * 1024)
  const { run, created } = await unpack(zip, { budget: 1024 * 1024 })
  await assert.rejects(run, (err: unknown) => err instanceof ImportLimitError)
  assert.ok(created.length > 0 && created.every((t) => t.removed), 'nothing left behind')
})

test(`at most ${MAX_IMPORT_FILES} files per import; the rest are counted`, async () => {
  const files: Zippable = {}
  for (let i = 0; i < MAX_IMPORT_FILES + 7; i++) files[`f${i}.txt`] = strToU8(String(i))
  const { run } = await unpack(zipSync(files, { level: 0 }), { chunk: 1024 * 1024 })
  const result = await run
  assert.equal(result.written.length, MAX_IMPORT_FILES)
  assert.equal(result.overLimit, 7)
})

test('a truncated ZIP keeps only the files that arrived whole', async () => {
  const big = new Uint8Array(200_000).map((_, i) => (i * 31) % 251) // barely compressible
  const zip = zipSync({ 'first.txt': strToU8('complete'), 'second.pdf': big }, { level: 0 })
  const { run, created } = await unpack(zip.subarray(0, zip.length - 120_000))
  const result = await run.catch((err: unknown) => {
    assert.ok(err instanceof ImportLimitError, 'or refused as unreadable')
    return null
  })
  if (result) {
    assert.deepEqual(result.written.map((w) => w.name), ['first.txt'])
    assert.equal(result.written[0].target.text, 'complete')
    assert.equal(result.failed, 1, 'the cut-off file')
  }
  const cut = created.find((t) => t.name === 'second.pdf')
  assert.ok(!cut || cut.removed, 'a partial file is never kept')
})

test('cancelling removes everything written so far', async () => {
  const files: Zippable = {}
  for (let i = 0; i < 50; i++) files[`f${i}.txt`] = strToU8('x'.repeat(5000))
  const { run, created } = await unpack(zipSync(files, { level: 0 }), { chunk: 4096, cancelAfterReads: 10 })
  await assert.rejects(run, (err: unknown) => err instanceof ImportCancelled)
  assert.ok(created.length > 0 && created.every((t) => t.removed))
})

test('something that is not a ZIP imports nothing', async () => {
  const { run } = await unpack(strToU8('this is not a zip file at all'.repeat(100)))
  const result = await run.catch((err: unknown) => {
    assert.ok(err instanceof ImportLimitError)
    return null
  })
  assert.ok(!result || result.written.length === 0)
})

test('the library changes only at the end, and the board offers both imports', () => {
  const bulk = source('src/storage/bulkImport.ts')
  const commit = bulk.slice(bulk.indexOf('function commit('), bulk.indexOf('function logFailure'))
  assert.ok(/if \(written\.length\) \{[^]*addGroup\(groupTitle\)[^]*addFiles\(/.test(commit), 'one group, added last')
  assert.equal(bulk.match(/addGroup\(/g)?.length, 1, 'no other path creates the group')
  // A cancelled folder import discards what it copied.
  assert.ok(/if \(control\.cancelled\) \{\s*discard\(written\)\s*throw new ImportCancelled\(\)/.test(bulk))
  // Received copies go through the native background copier when it exists.
  assert.ok(bulk.includes('await Incoming.copyTo(file.uri, slot.target.uri)'))
  // The fallback copy is async too; un-awaited, an entry would commit mid-write.
  assert.ok(bulk.includes('await file.copy(slot.target)'))
  assert.doesNotMatch(bulk, /[^t] file\.copy\(/, 'no un-awaited copy')

  const screen = source('src/screens/LibraryScreen.tsx')
  assert.ok(screen.includes("label: 'Import folder as group…'") && screen.includes("label: 'Import ZIP as group…'"))
  assert.ok(screen.includes("await import('../storage/bulkImport')"), 'loaded on first use, not at startup')
  assert.ok(/bulkControl\.current\.cancelled = true/.test(screen), 'Cancel reaches the import')
  // A plain "Add files" still adds a .zip as one file.
  assert.doesNotMatch(source('src/storage/files.ts'), /bulkImport|unpackZip/)
})
