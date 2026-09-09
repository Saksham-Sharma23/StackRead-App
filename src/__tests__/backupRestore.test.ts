import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  Unzip,
  UnzipInflate,
  UnzipPassThrough,
  Zip,
  ZipPassThrough,
  strToU8,
  strFromU8,
} from 'fflate'

/*
 * The restore half of `storage/backup.ts`.
 *
 * Restore is the last line of defence for a user's library, and until R1 it was
 * the most dangerous code in the app: it decompressed the entire archive into
 * memory, deleted `LIBRARY_DIR`, and only then wrote the files. The likely
 * failure was therefore an OOM kill *after* the delete and partway through the
 * writes, leaving the directory gone, the new one half-populated and the index
 * still describing the old library ([AUDIT2 §1.1](../../AUDIT2.md),
 * [AUDIT §1.2](../../AUDIT.md)).
 *
 * Kept in its own file rather than appended to `backup.test.ts`, which covers
 * export: the two halves are different operations with different failure modes,
 * and the export file's own header explains its mirroring at length.
 *
 * `storage/backup.ts` cannot be imported here — it pulls in
 * `expo-file-system` — so the streaming unpack is mirrored exactly, the same
 * way `backup.test.ts` mirrors the streaming export. What that can and cannot
 * prove is worth being honest about:
 *
 *  - It **does** pin the pure logic: every entry recovered byte-for-byte, one
 *    entry buffered at a time, a malformed index refused, path traversal
 *    refused, and the commit last.
 *  - It **cannot** prove the real function calls `File.write` in the right
 *    order, or that a process kill mid-restore is survivable. That remains a
 *    device check, and [TASKS2 R1-2](../../TASKS2.md) spells it out.
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

  return concat(chunks)
}

/** Mirrors the helper of the same name in `storage/backup.ts`. */
function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

interface UnpackResult {
  library: unknown
  /** Basename to bytes, standing in for the writes the real function performs. */
  written: Map<string, Uint8Array>
  /** Peak entries buffered at once. Must never exceed one. */
  peakBuffered: number
  /** What happened, in order. */
  log: string[]
}

/**
 * Mirrors `unpackArchive`, with disk writes recorded rather than performed.
 *
 * The archive is pushed in small chunks, as a file reader would deliver it, so
 * the multi-chunk paths through fflate are actually exercised rather than the
 * degenerate single-push one.
 */
function unpackArchive(archive: Uint8Array): UnpackResult {
  let indexJson: string | null = null
  const written = new Map<string, Uint8Array>()
  const log: string[] = []
  let failure: Error | null = null
  let buffered = 0
  let peakBuffered = 0

  const unzip = new Unzip()
  unzip.register(UnzipPassThrough)
  unzip.register(UnzipInflate)

  unzip.onfile = (entry) => {
    if (entry.name === 'library.json') {
      const parts: Uint8Array[] = []
      entry.ondata = (err, chunk, final) => {
        if (err) {
          failure ??= err
          return
        }
        parts.push(chunk)
        if (final) {
          indexJson = strFromU8(concat(parts))
          log.push('read-index')
        }
      }
      entry.start()
      return
    }

    if (!entry.name.startsWith('files/')) return
    const name = entry.name.slice('files/'.length)
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return

    const parts: Uint8Array[] = []
    buffered += 1
    peakBuffered = Math.max(peakBuffered, buffered)

    entry.ondata = (err, chunk, final) => {
      if (err) {
        failure ??= err
        return
      }
      parts.push(chunk)
      if (!final) return
      written.set(name, concat(parts))
      parts.length = 0
      buffered -= 1
      log.push('write:' + name)
    }
    entry.start()
  }

  const CHUNK = 512
  for (let at = 0; at < archive.length; at += CHUNK) {
    unzip.push(archive.subarray(at, Math.min(at + CHUNK, archive.length)), false)
    if (failure) break
  }
  unzip.push(new Uint8Array(0), true)

  if (failure) throw new Error('This backup could not be read')
  if (indexJson === null) throw new Error('This is not a StackRead backup')

  let library: unknown
  try {
    const parsed = JSON.parse(indexJson) as { groups?: unknown; files?: unknown }
    if (!Array.isArray(parsed.groups) || !Array.isArray(parsed.files)) throw new Error('shape')
    library = parsed
  } catch {
    throw new Error('This backup index is unreadable')
  }
  log.push('commit')

  return { library, written, peakBuffered, log }
}

const EMPTY_INDEX = strToU8('{"groups":[],"files":[]}')

test('a streamed restore recovers every entry byte-for-byte', async () => {
  // Bytes that a stringifying bug would mangle: invalid UTF-8 and a NUL.
  const payload = new Uint8Array(4096)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 13) % 256
  payload[0] = 0x00
  payload[1] = 0xff

  const archive = await buildArchive({
    'library.json': strToU8(
      JSON.stringify({ groups: [{ id: 'g', title: 'G', order: 0 }], files: [] }),
    ),
    'files/abc.pdf': payload,
    'files/abc.thumb.jpg': new Uint8Array([1, 2, 3]),
  })

  const { written } = unpackArchive(archive)

  assert.deepEqual([...written.keys()].sort(), ['abc.pdf', 'abc.thumb.jpg'])
  assert.deepEqual([...written.get('abc.pdf')!], [...payload])
  assert.deepEqual([...written.get('abc.thumb.jpg')!], [1, 2, 3])
})

test('only one entry is ever buffered, whatever the library size', async () => {
  /*
   * The point of the whole rewrite.
   *
   * The previous version held the archive plus every decompressed entry at
   * once, so peak memory scaled with the library — which is why a library that
   * exported successfully could not necessarily be restored on the device that
   * made it. Peak must be one entry regardless of how many there are.
   */
  const entries: Record<string, Uint8Array> = { 'library.json': EMPTY_INDEX }
  for (let i = 0; i < 40; i++) entries['files/f' + i + '.bin'] = new Uint8Array(1024).fill(i)

  const { written, peakBuffered } = unpackArchive(await buildArchive(entries))

  assert.equal(written.size, 40)
  assert.equal(
    peakBuffered,
    1,
    'more than one entry buffered at a time — peak memory is scaling with the library again',
  )
})

test('the commit happens last, after the index has parsed', async () => {
  /*
   * The ordering property, and the one three audits have asked for.
   *
   * `exportLibrary` writes `library.json` first, so in practice it is validated
   * before a single file is touched — asserted below because it is what makes
   * a malformed backup cost nothing. What must hold unconditionally is the
   * weaker and more important half: nothing is committed until the index has
   * been proven readable.
   */
  const { log } = unpackArchive(
    await buildArchive({
      'library.json': EMPTY_INDEX,
      'files/a.bin': new Uint8Array([1]),
      'files/b.bin': new Uint8Array([2]),
    }),
  )

  assert.equal(log[0], 'read-index', 'our own exports put the index first, so it is read first')
  assert.equal(log[log.length - 1], 'commit', 'the commit must be the last thing that happens')
  assert.deepEqual(log, ['read-index', 'write:a.bin', 'write:b.bin', 'commit'])
})

test('an archive with no index is refused', async () => {
  const archive = await buildArchive({ 'files/a.bin': new Uint8Array([1]) })
  assert.throws(() => unpackArchive(archive), /not a StackRead backup/)
})

test('an archive whose index is malformed is refused', async () => {
  const missingFiles = await buildArchive({ 'library.json': strToU8('{"groups":[]}') })
  assert.throws(() => unpackArchive(missingFiles), /index is unreadable/)

  const notJson = await buildArchive({ 'library.json': strToU8('not json at all') })
  assert.throws(() => unpackArchive(notJson), /index is unreadable/)
})

test('a crafted archive cannot write outside the library directory', async () => {
  /*
   * Path traversal. The guard predates this rewrite and is carried through it
   * unchanged — which is exactly the kind of thing a rewrite drops silently,
   * because nothing else in the file would fail.
   */
  const { written } = unpackArchive(
    await buildArchive({
      'library.json': EMPTY_INDEX,
      'files/../../evil.txt': new Uint8Array([1]),
      'files/nested/evil.txt': new Uint8Array([2]),
      'files/': new Uint8Array([3]),
      'files/ok.bin': new Uint8Array([4]),
    }),
  )

  assert.deepEqual([...written.keys()], ['ok.bin'], 'only the flat, in-directory entry survives')
})

test('a deflated archive restores as well as a stored one', async () => {
  /*
   * Our own exports use ZipPassThrough, but a user can hand us any zip — one
   * repacked by a desktop tool, say. An unregistered compression method makes
   * fflate throw inside start(), which would surface as an unreadable backup
   * for a file that is perfectly fine.
   */
  const { ZipDeflate } = await import('fflate')

  const chunks: Uint8Array[] = []
  const zip = new Zip()
  let finished!: () => void
  const done = new Promise<void>((resolve) => {
    finished = resolve
  })
  zip.ondata = (_err, chunk, final) => {
    chunks.push(chunk)
    if (final) finished()
  }

  const index = new ZipDeflate('library.json')
  zip.add(index)
  index.push(EMPTY_INDEX, true)

  const payload = new Uint8Array(2048).fill(0x41)
  const file = new ZipDeflate('files/a.bin')
  zip.add(file)
  file.push(payload, true)

  zip.end()
  await done

  const { written } = unpackArchive(concat(chunks))
  assert.deepEqual([...written.get('a.bin')!], [...payload])
})
