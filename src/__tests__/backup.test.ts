import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Zip, ZipPassThrough, unzipSync, strToU8, strFromU8 } from 'fflate'

/*
 * Export builds the archive incrementally now — one file read, pushed and
 * written before the next is touched — so peak memory is roughly the largest
 * single file rather than the whole library, and the old 400MB cap is gone.
 *
 * This is the one feature whose output a user may depend on to recover
 * everything they own, so "it produced a file" is not good enough: the archive
 * has to actually unzip, with every entry intact. The streaming API is easy to
 * get subtly wrong — a missing `end()`, an entry pushed without its final flag
 * — and each of those yields a *plausible* file that fails only on restore.
 *
 * `storage/backup.ts` cannot be imported here (`expo-file-system`), so the zip
 * construction is mirrored exactly and asserted against fflate's own reader.
 */

/** Mirrors the streaming construction in `exportLibrary`. */
async function buildArchive(entries: Record<string, Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const zip = new Zip()

  let failure: Error | null = null
  let finished!: () => void
  const done = new Promise<void>((resolve) => {
    finished = resolve
  })

  zip.ondata = (err, chunk, final) => {
    if (err) {
      failure ??= err
      finished()
      return
    }
    chunks.push(chunk)
    if (final) finished()
  }

  for (const [name, bytes] of Object.entries(entries)) {
    const entry = new ZipPassThrough(name)
    zip.add(entry)
    entry.push(bytes, true)
  }

  zip.end()
  await done
  if (failure) throw failure

  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

test('a streamed archive unzips with every entry intact', async () => {
  const archive = await buildArchive({
    'library.json': strToU8(JSON.stringify({ groups: [], files: [] })),
    'files/abc.epub': new Uint8Array([1, 2, 3, 4, 5]),
    'files/abc.thumb.jpg': new Uint8Array([9, 8, 7]),
  })

  const back = unzipSync(archive)

  assert.deepEqual(Object.keys(back).sort(), [
    'files/abc.epub',
    'files/abc.thumb.jpg',
    'library.json',
  ])
  assert.deepEqual([...back['files/abc.epub']], [1, 2, 3, 4, 5])
  assert.deepEqual([...back['files/abc.thumb.jpg']], [9, 8, 7])
  assert.deepEqual(JSON.parse(strFromU8(back['library.json'])), { groups: [], files: [] })
})

test('binary content survives the streamed round trip byte-for-byte', async () => {
  /*
   * The payload is PDFs and images, so any accidental text handling would
   * corrupt it. Includes bytes that are invalid UTF-8 and an embedded NUL,
   * which is what a stringifying bug would mangle.
   */
  const payload = new Uint8Array(2048)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) % 256
  payload[0] = 0x00
  payload[1] = 0xff
  payload[2] = 0xfe

  const back = unzipSync(await buildArchive({ 'files/x.pdf': payload }))
  assert.deepEqual([...back['files/x.pdf']], [...payload])
})

test('an archive of many entries stays readable', async () => {
  // The streaming path emits chunks as it goes; a mistake in the accumulation
  // shows up as a truncated central directory once there are enough entries.
  const entries: Record<string, Uint8Array> = {}
  for (let i = 0; i < 60; i++) {
    entries[`files/f${i}.bin`] = new Uint8Array([i, i + 1, i + 2])
  }

  const back = unzipSync(await buildArchive(entries))
  assert.equal(Object.keys(back).length, 60)
  assert.deepEqual([...back['files/f59.bin']], [59, 60, 61])
})

test('an empty library still produces a valid archive', async () => {
  // Backing up before adding anything must not produce a corrupt file.
  const back = unzipSync(
    await buildArchive({ 'library.json': strToU8('{"groups":[],"files":[]}') }),
  )
  assert.ok(back['library.json'])
})

test('stored entries are not compressed', async () => {
  /*
   * `ZipPassThrough` stores rather than deflates, matching the previous
   * `level: 0`. The payload is overwhelmingly already-compressed data, so
   * deflating costs time and saves almost nothing — and this pins that a future
   * switch to `ZipDeflate` is a deliberate choice rather than a silent one.
   */
  const payload = new Uint8Array(1024).fill(0x41) // trivially compressible
  const archive = await buildArchive({ 'files/a.bin': payload })

  // A stored entry means the archive is larger than the payload; a deflated
  // one of 1KB of a single repeated byte would be dramatically smaller.
  assert.ok(
    archive.length > payload.length,
    `expected stored (uncompressed) entry, archive was ${archive.length}b for a ${payload.length}b payload`,
  )
})
