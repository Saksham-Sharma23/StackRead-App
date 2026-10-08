import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zipSync, unzipSync, strToU8, type Zippable } from 'fflate'

import {
  parkArchive,
  readParked,
  releaseParked,
  zipRead,
} from '../renderers/webview/zipWorklet.ts'

/*
 * `zipWorklet.ts` replaces fflate *on the worker runtime only* — fflate stays
 * the fallback on the JS thread. So the property that matters is that the two
 * agree byte for byte on every archive the app opens. Any disagreement would
 * mean an EPUB that reads differently depending on which thread unzipped it.
 *
 * The `'worklet'` directives are inert strings under Node, so the functions are
 * exercised here exactly as written.
 */

/** Deterministic pseudo-random bytes, so a failure reproduces. */
function noise(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length)
  let x = seed >>> 0 || 1
  for (let i = 0; i < length; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x & 0xff
  }
  return out
}

/** Prose-like text: compressible, with long back-references. */
function prose(paragraphs: number): Uint8Array {
  const words = ['the', 'reader', 'swipes', 'between', 'chapters', 'and', 'files', 'in', 'a', 'group', 'é', '—', 'ü']
  let s = '<html><body>'
  for (let p = 0; p < paragraphs; p++) {
    s += '<p>'
    for (let w = 0; w < 60; w++) s += words[(p * 7 + w * 3) % words.length] + ' '
    s += '</p>\n'
  }
  return strToU8(s + '</body></html>')
}

function assertSameAsFflate(archive: Uint8Array): void {
  const expected = unzipSync(archive)
  const { files, entries } = zipRead(archive, null, false)

  assert.deepEqual(Object.keys(files).sort(), Object.keys(expected).sort())
  for (const name of Object.keys(expected)) {
    assert.deepEqual(files[name], expected[name], `entry ${name} differs from fflate`)
  }

  // The listing must report the sizes fflate's filter sees, in the same order.
  const listed: { name: string; originalSize: number }[] = []
  unzipSync(archive, {
    filter: (f) => {
      listed.push({ name: f.name, originalSize: f.originalSize })
      return false
    },
  })
  assert.deepEqual(entries, listed)
}

test('stored and deflated entries at every level match fflate', () => {
  for (const level of [0, 1, 2, 4, 6, 9] as const) {
    const archive = zipSync(
      {
        'mimetype': [strToU8('application/epub+zip'), { level: 0 }],
        'OEBPS/ch1.xhtml': prose(40),
        'OEBPS/ch2.xhtml': prose(3),
        'OEBPS/img/cover.jpg': noise(20_000, level + 1),
      },
      { level },
    )
    assertSameAsFflate(archive)
  }
})

test('large compressible and incompressible entries match fflate', () => {
  // A long chapter spans many dynamic-Huffman blocks; random bytes at level 9
  // make deflate emit stored blocks *inside* a deflate stream, which is the
  // byte-boundary path in the inflater.
  const archive = zipSync({
    'big.xhtml': prose(4000),
    'random.bin': noise(300_000, 7),
    'tiny.txt': strToU8('x'),
    'empty.txt': new Uint8Array(0),
  }, { level: 9 })
  assertSameAsFflate(archive)
})

test('long runs and short repeats match fflate', () => {
  const runs = new Uint8Array(200_000)
  for (let i = 0; i < runs.length; i++) runs[i] = i % 3 === 0 ? 0x41 : 0x20
  const archive = zipSync({ 'runs.txt': runs, 'zeros.bin': new Uint8Array(70_000) }, { level: 6 })
  assertSameAsFflate(archive)
})

test('UTF-8 and directory entry names decode as fflate decodes them', () => {
  const files: Zippable = {
    'Kapitel/Übersicht.xhtml': prose(2),
    '目次/第一章.xhtml': prose(2),
    'emoji/📚.txt': strToU8('books'),
    'dir/': new Uint8Array(0),
  }
  assertSameAsFflate(zipSync(files))
})

test('only the wanted entries are decompressed', () => {
  const archive = zipSync({ 'a.txt': strToU8('alpha'), 'b.txt': strToU8('beta'), 'c.txt': strToU8('gamma') })
  const { files, entries } = zipRead(archive, ['b.txt', 'missing.txt'], false)

  assert.deepEqual(Object.keys(files), ['b.txt'])
  assert.equal(new TextDecoder().decode(files['b.txt']), 'beta')
  assert.equal(entries.length, 3, 'the listing still covers the whole archive')
})

test('listOnly decompresses nothing', () => {
  const archive = zipSync({ 'a.txt': prose(10) })
  const { files, entries } = zipRead(archive, null, true)
  assert.deepEqual(files, {})
  assert.equal(entries[0].name, 'a.txt')
  assert.equal(entries[0].originalSize, prose(10).length)
})

test('stored results own their buffer rather than viewing the archive', () => {
  /*
   * Serialising a typed-array view copies its *whole* backing buffer
   * (`createSerializableArrayBufferView`). A stored entry returned as a
   * subarray would carry the entire archive back across the boundary.
   */
  const archive = zipSync({ 'a.txt': [strToU8('alpha'), { level: 0 }] })
  const { files } = zipRead(archive, null, false)
  assert.equal(files['a.txt'].buffer.byteLength, files['a.txt'].length)
})

test('unsupported or corrupt archives throw instead of returning partial data', () => {
  const archive = zipSync({ 'a.txt': prose(20) }, { level: 6 })

  // Not a zip at all.
  assert.throws(() => zipRead(strToU8('not a zip file, just text'), null, false))

  // An unknown compression method, written into both headers.
  const odd = archive.slice()
  const central = findSignature(odd, 0x02014b50)
  odd[central + 10] = 12 // bzip2
  odd[4 + 4] = 12
  assert.throws(() => zipRead(odd, null, false), /method/)

  // A central directory that claims a larger size than the stream inflates to.
  const lying = archive.slice()
  lying[central + 24] += 1
  assert.throws(() => zipRead(lying, null, false))

  // A truncated deflate stream.
  const local = 0
  const nameLength = archive[local + 26] | (archive[local + 27] << 8)
  const dataStart = local + 30 + nameLength
  const broken = archive.slice()
  broken.fill(0xff, dataStart, dataStart + 40)
  assert.throws(() => zipRead(broken, null, false))
})

function findSignature(data: Uint8Array, signature: number): number {
  for (let i = data.length - 4; i >= 0; i--) {
    const v = (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)) >>> 0
    if (v === signature) return i
  }
  throw new Error('signature not found')
}

/* ==================== the resident store ==================== */

test('a parked archive is read by name without being passed again', () => {
  releaseParked(null)
  const archive = zipSync({ 'META-INF/container.xml': strToU8('<container/>'), 'ch1.xhtml': prose(5) })

  const listing = parkArchive('book-1', archive, 2)
  assert.deepEqual(listing.map((e) => e.name), ['META-INF/container.xml', 'ch1.xhtml'])

  const files = readParked('book-1', ['ch1.xhtml'])
  assert.ok(files)
  assert.deepEqual(files['ch1.xhtml'], prose(5))
  releaseParked(null)
})

test('the store keeps at most maxResident archives, evicting the least recently used', () => {
  releaseParked(null)
  const a = zipSync({ 'a.txt': strToU8('a') })
  const b = zipSync({ 'b.txt': strToU8('b') })
  const c = zipSync({ 'c.txt': strToU8('c') })

  parkArchive('a', a, 2)
  parkArchive('b', b, 2)
  // Touching `a` makes `b` the least recently used.
  assert.ok(readParked('a', ['a.txt']))
  parkArchive('c', c, 2)

  assert.ok(readParked('a', ['a.txt']), 'recently read archive must survive')
  assert.equal(readParked('b', ['b.txt']), null, 'least recently used must be evicted')
  assert.ok(readParked('c', ['c.txt']))
  releaseParked(null)
})

test('a missing archive reads as null, so the caller can park it again', () => {
  releaseParked(null)
  assert.equal(readParked('never-parked', ['x']), null)

  const archive = zipSync({ 'x.txt': strToU8('x') })
  parkArchive('k', archive, 2)
  releaseParked('k')
  assert.equal(readParked('k', ['x.txt']), null, 'a released archive must not be readable')
})

test('an unreadable archive is never parked', () => {
  releaseParked(null)
  assert.throws(() => parkArchive('bad', strToU8('nope'), 2))
  assert.equal(readParked('bad', []), null)
})
