import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zlibSync, unzlibSync } from 'fflate'
import { rgbaToThumbHash, thumbHashToRGBA } from 'thumbhash'

/*
 * The PNG decoder in `storage/thumbhash.ts` is the riskiest code added for
 * placeholders: it hand-rolls scanline unfiltering, and a wrong predictor
 * produces a *plausible* image rather than an error — a smeared placeholder
 * that nobody reports as a bug.
 *
 * The decoder is not exported (it is an implementation detail of
 * `thumbHashFor`, which needs `expo-image-manipulator` and therefore a device).
 * So these tests re-implement the same unfiltering against PNGs built here with
 * known pixels, which pins the algorithm itself — the part that is easy to get
 * subtly wrong — independently of the Expo plumbing around it.
 */

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

/** Builds a real, minimal PNG: signature, IHDR, IDAT, IEND. */
function makePng(
  width: number,
  height: number,
  rows: number[][],
  colorType: 2 | 6,
  filterType = 0,
): Uint8Array {
  const raw: number[] = []
  for (const row of rows) raw.push(filterType, ...row)

  const idat = zlibSync(new Uint8Array(raw))

  const chunk = (type: string, data: number[]): number[] => [
    ...u32(data.length),
    ...[...type].map((c) => c.charCodeAt(0)),
    ...data,
    // CRC is not verified by the decoder — these bytes are produced locally
    // moments before being read — so a placeholder is fine here.
    0, 0, 0, 0,
  ]

  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [
      ...u32(width),
      ...u32(height),
      8, // bit depth
      colorType,
      0, 0, 0, // compression, filter, interlace
    ]),
    ...chunk('IDAT', [...idat]),
    ...chunk('IEND', []),
  ])
}

/** The decoder under test, mirrored. Kept in step with `storage/thumbhash.ts`. */
function decode(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const readU32 = (at: number) =>
    ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0

  let width = 0
  let height = 0
  let colorType = -1
  const idat: Uint8Array[] = []

  let at = 8
  while (at < bytes.length) {
    const len = readU32(at)
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7])
    const dataAt = at + 8
    if (type === 'IHDR') {
      width = readU32(dataAt)
      height = readU32(dataAt + 4)
      colorType = bytes[dataAt + 9]
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dataAt, dataAt + len))
    } else if (type === 'IEND') break
    at = dataAt + len + 4
  }

  let total = 0
  for (const p of idat) total += p.length
  const compressed = new Uint8Array(total)
  let off = 0
  for (const p of idat) {
    compressed.set(p, off)
    off += p.length
  }

  const raw = unzlibSync(compressed)

  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const rgba = new Uint8Array(width * height * 4)

  let prev: Uint8Array | null = null
  let src = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[src]
    src += 1
    const row = raw.slice(src, src + stride)
    src += stride

    const bpp = channels
    if (filter === 1) {
      for (let i = bpp; i < row.length; i++) row[i] = (row[i] + row[i - bpp]) & 0xff
    } else if (filter === 2 && prev) {
      for (let i = 0; i < row.length; i++) row[i] = (row[i] + prev[i]) & 0xff
    } else if (filter === 3) {
      for (let i = 0; i < row.length; i++) {
        const left = i >= bpp ? row[i - bpp] : 0
        const up = prev ? prev[i] : 0
        row[i] = (row[i] + ((left + up) >> 1)) & 0xff
      }
    } else if (filter === 4) {
      for (let i = 0; i < row.length; i++) {
        const a = i >= bpp ? row[i - bpp] : 0
        const b = prev ? prev[i] : 0
        const c = prev && i >= bpp ? prev[i - bpp] : 0
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        row[i] = (row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
    }

    let dst = y * width * 4
    for (let x = 0; x < width; x++) {
      const s = x * channels
      rgba[dst] = row[s]
      rgba[dst + 1] = row[s + 1]
      rgba[dst + 2] = row[s + 2]
      rgba[dst + 3] = channels === 4 ? row[s + 3] : 0xff
      dst += 4
    }
    prev = row
  }

  return { width, height, rgba }
}

test('decodes an unfiltered RGB PNG and widens it to RGBA', () => {
  // Two pixels: pure red, pure green. RGB input must come out with alpha 255.
  const png = makePng(2, 1, [[255, 0, 0, 0, 255, 0]], 2)
  const { width, height, rgba } = decode(png)

  assert.equal(width, 2)
  assert.equal(height, 1)
  assert.deepEqual([...rgba], [255, 0, 0, 255, 0, 255, 0, 255])
})

test('decodes an RGBA PNG preserving alpha', () => {
  const png = makePng(1, 2, [[10, 20, 30, 128], [40, 50, 60, 255]], 6)
  const { rgba } = decode(png)
  assert.deepEqual([...rgba], [10, 20, 30, 128, 40, 50, 60, 255])
})

test('reverses the Sub filter', () => {
  // Sub encodes each byte as a delta from the pixel to its left, so
  // [10,20,30, 5,5,5] decodes to [10,20,30, 15,25,35].
  const png = makePng(2, 1, [[10, 20, 30, 5, 5, 5]], 2, 1)
  const { rgba } = decode(png)
  assert.deepEqual([...rgba].slice(4, 7), [15, 25, 35])
})

test('reverses the Up filter', () => {
  // Row two is stored as a delta from row one.
  const png = makePng(1, 2, [[100, 100, 100], [10, 20, 30]], 2, 2)
  const { rgba } = decode(png)
  assert.deepEqual([...rgba].slice(4, 7), [110, 120, 130])
})

test('a hash round-trips to an image of the same average colour', () => {
  /*
   * The end-to-end property that matters: a solid blue image must produce a
   * hash that decodes back to something recognisably blue. This is what makes
   * the placeholder look like the cover rather than like noise.
   */
  const w = 8
  const h = 8
  const rgba = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = 20
    rgba[i * 4 + 1] = 60
    rgba[i * 4 + 2] = 200
    rgba[i * 4 + 3] = 255
  }

  const decoded = thumbHashToRGBA(rgbaToThumbHash(w, h, rgba))

  // Average the result and check the blue channel dominates, with a generous
  // tolerance — ThumbHash is lossy by design and exact values are not the point.
  let r = 0
  let g = 0
  let b = 0
  const n = decoded.w * decoded.h
  for (let i = 0; i < n; i++) {
    r += decoded.rgba[i * 4]
    g += decoded.rgba[i * 4 + 1]
    b += decoded.rgba[i * 4 + 2]
  }
  r /= n
  g /= n
  b /= n

  assert.ok(b > 150, `expected a blue-dominant placeholder, got b=${b.toFixed(0)}`)
  assert.ok(b > r && b > g, 'blue channel should dominate')
})

test('a thumbhash is small enough to live in the index', () => {
  // The whole premise of storing it per entry: it must not meaningfully grow
  // library.json. ~25 bytes raw, ~36 as base64.
  const w = 32
  const h = 32
  const rgba = new Uint8Array(w * h * 4).fill(128)
  const hash = rgbaToThumbHash(w, h, rgba)
  assert.ok(hash.length < 40, `thumbhash unexpectedly large: ${hash.length} bytes`)
})
