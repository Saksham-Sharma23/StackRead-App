import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zipSync, unzipSync, strToU8, type Zippable } from 'fflate'

import { findComicCover, findEpubCover, MAX_COVER_BYTES } from '../storage/coverSelect.ts'
import { zipRead } from '../renderers/webview/zipWorklet.ts'

/*
 * AUDIT4 A6. Cover extraction used to unzip a whole book — every chapter and
 * every illustration — to keep one image, for each uncovered card on the board.
 * These run the real selection code against real archives through a reader
 * that records what was asked for, and pin that only the locator documents and
 * the cover itself are ever decompressed.
 */

/** A reader over an archive that logs every entry requested. */
function recordingReader(archive: Uint8Array) {
  const requested: string[] = []
  const read = async (names: string[]) => {
    requested.push(...names)
    const set = new Set(names)
    return unzipSync(archive, { filter: (f) => set.has(f.name) })
  }
  return { read, requested, entries: zipRead(archive, null, true).entries }
}

const CONTAINER = strToU8(
  '<?xml version="1.0"?><container><rootfiles>' +
    '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
    '</rootfiles></container>',
)

function opf(manifest: string, metadata = '', spine = '<itemref idref="ch1"/>'): Uint8Array {
  return strToU8(
    `<package><metadata>${metadata}</metadata><manifest>${manifest}</manifest>` +
      `<spine>${spine}</spine></package>`,
  )
}

/** A book with forty illustrated chapters, the shape that made the old path expensive. */
function bigBook(extra: Zippable, opfBytes: Uint8Array): Uint8Array {
  const files: Zippable = {
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': opfBytes,
    ...extra,
  }
  for (let i = 0; i < 40; i++) {
    files[`OEBPS/ch${i}.xhtml`] = strToU8(`<html><body><p>chapter ${i}</p></body></html>`)
    files[`OEBPS/img/plate${i}.jpg`] = new Uint8Array(1000 + i)
  }
  return zipSync(files)
}

test('EPUB 3 cover-image: reads container, OPF and the cover — nothing else', async () => {
  const cover = new Uint8Array([1, 2, 3, 4])
  const book = bigBook(
    { 'OEBPS/img/cover.jpg': cover },
    opf(
      '<item id="c" href="img/cover.jpg" media-type="image/jpeg" properties="cover-image"/>' +
        '<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>',
    ),
  )
  const { read, requested, entries } = recordingReader(book)

  const found = await findEpubCover(entries, read)
  assert.deepEqual(found && [...found.bytes], [1, 2, 3, 4])
  assert.equal(found?.ext, 'jpg')
  assert.deepEqual(requested, ['META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/img/cover.jpg'])
})

test('EPUB 2 meta cover, in either attribute order', async () => {
  for (const meta of [
    '<meta name="cover" content="cov"/>',
    '<meta content="cov" name="cover"/>',
  ]) {
    const book = bigBook(
      { 'OEBPS/cover.png': new Uint8Array([9]) },
      opf('<item id="cov" href="cover.png" media-type="image/png"/>', meta),
    )
    const { read, requested, entries } = recordingReader(book)
    const found = await findEpubCover(entries, read)
    assert.equal(found?.ext, 'png')
    assert.equal(requested.length, 3)
  }
})

test('no declared cover: falls back to the first chapter\'s image, reading only that chapter', async () => {
  const book = bigBook(
    {
      'OEBPS/title.xhtml': strToU8('<html><body><img src="img/front.jpg"/></body></html>'),
      'OEBPS/img/front.jpg': new Uint8Array([7, 7]),
    },
    opf(
      '<item id="t" href="title.xhtml" media-type="application/xhtml+xml"/>',
      '',
      '<itemref idref="t"/>',
    ),
  )
  const { read, requested, entries } = recordingReader(book)

  const found = await findEpubCover(entries, read)
  assert.deepEqual(found && [...found.bytes], [7, 7])
  assert.deepEqual(requested, [
    'META-INF/container.xml',
    'OEBPS/content.opf',
    'OEBPS/title.xhtml',
    'OEBPS/img/front.jpg',
  ])
})

test('an oversized cover is refused from the listing, without decompressing it', async () => {
  const book = zipSync({
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': opf(
      '<item id="c" href="huge.jpg" media-type="image/jpeg" properties="cover-image"/>',
    ),
    // Highly compressible, so the archive stays small while declaring a size
    // past the cap — the central directory is what decides.
    'OEBPS/huge.jpg': new Uint8Array(MAX_COVER_BYTES + 1),
  })
  const { read, requested, entries } = recordingReader(book)

  assert.equal(await findEpubCover(entries, read), null)
  assert.ok(!requested.includes('OEBPS/huge.jpg'), 'the oversized cover must never be read')
})

test('an SVG cover is not a cover', async () => {
  const book = zipSync({
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': opf(
      '<item id="c" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/>',
    ),
    'OEBPS/cover.svg': strToU8('<svg/>'),
  })
  const { read, requested, entries } = recordingReader(book)
  assert.equal(await findEpubCover(entries, read), null)
  assert.ok(!requested.includes('OEBPS/cover.svg'))
})

test('not an EPUB: no container, nothing read beyond the attempt', async () => {
  const { read, requested, entries } = recordingReader(zipSync({ 'a.txt': strToU8('a') }))
  assert.equal(await findEpubCover(entries, read), null)
  assert.deepEqual(requested, [], 'an entry the listing lacks is not even requested')
})

test('comic: the naturally-first page is the only entry read', async () => {
  const files: Zippable = {}
  for (const n of [10, 2, 1, 33]) files[`pages/page${n}.jpg`] = new Uint8Array([n])
  files['__MACOSX/pages/._page0.jpg'] = new Uint8Array([0])
  files['notes.txt'] = strToU8('credits')
  const { read, requested, entries } = recordingReader(zipSync(files))

  const found = await findComicCover(entries, read)
  assert.deepEqual(found && [...found.bytes], [1])
  assert.deepEqual(requested, ['pages/page1.jpg'])
})

test('comic: an oversized first page is skipped from the listing, not decompressed', async () => {
  const { read, requested, entries } = recordingReader(
    zipSync({
      'p01.jpg': new Uint8Array(MAX_COVER_BYTES + 1),
      'p02.jpg': new Uint8Array([2]),
    }),
  )
  const found = await findComicCover(entries, read)
  assert.deepEqual(found && [...found.bytes], [2])
  assert.deepEqual(requested, ['p02.jpg'])
})
