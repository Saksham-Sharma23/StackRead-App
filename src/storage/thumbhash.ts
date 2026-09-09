import { unzlibSync } from 'fflate'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import { rgbaToThumbHash } from 'thumbhash'

// Shared rather than re-implemented: one copy of the chunked encoder means the
// 8KB chunk-size constraint cannot be fixed in one place and missed in another,
// which is exactly how it went wrong before (DETAIL.md 6.12).
import { toBase64 } from '../renderers/webview/bytes'

/**
 * Generates a ThumbHash for an image: a ~25-byte string that decodes to a
 * blurred preview in well under a millisecond.
 *
 * ## Why this exists
 *
 * A card with no thumbnail yet is an empty rectangle, and on a cold start with
 * a full library that is the entire board for the first second. A ThumbHash is
 * small enough to live in `library.json` beside the entry — so it is available
 * *before* any image is read from disk — and `expo-image` decodes it natively
 * as a `placeholder`, meaning the card paints a plausible cover on its very
 * first frame and swaps to the real JPEG when that decodes.
 *
 * ## Why a PNG decoder is in here
 *
 * `rgbaToThumbHash` needs raw RGBA pixels, and nothing in the Expo image stack
 * exposes them — `ImageManipulator` returns an encoded JPEG or PNG, and
 * `expo-image` has no pixel readback. So the pipeline is:
 *
 *   downscale to <=100px PNG  ->  decode that PNG here  ->  rgbaToThumbHash
 *
 * The decoder below is deliberately partial. It handles exactly what
 * `ImageManipulator` emits — 8-bit, non-interlaced, RGB or RGBA — and refuses
 * anything else rather than guessing. It is not a general PNG library and must
 * not be used as one; a file that fails to decode simply yields no hash, and
 * the card falls back to its solid placeholder.
 */

/**
 * ThumbHash's hard limit is 100px on either axis.
 *
 * 64 rather than 100 because the hash encodes only a handful of DCT
 * coefficients — the extra input resolution changes the output negligibly while
 * costing four times the pixels to decode here.
 */
const HASH_SIZE = 64

/** PNG's fixed 8-byte signature. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function readU32(bytes: Uint8Array, at: number): number {
  // PNG is big-endian. `>>> 0` keeps the result unsigned.
  return (
    ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
  )
}

interface DecodedPng {
  width: number
  height: number
  /** Row-major RGBA, 4 bytes per pixel. */
  rgba: Uint8Array
}

/**
 * Reverses one PNG scanline filter.
 *
 * Each row carries a filter byte naming how it was encoded relative to its
 * neighbours; undoing it needs the already-reconstructed row above, which is
 * why this runs in place, top to bottom.
 *
 * `bpp` is bytes per pixel, the distance back to pixel `a`.
 */
function unfilterRow(
  type: number,
  row: Uint8Array,
  prev: Uint8Array | null,
  bpp: number,
): void {
  const n = row.length

  switch (type) {
    case 0: // None
      return

    case 1: // Sub — predict from the pixel to the left.
      for (let i = bpp; i < n; i++) row[i] = (row[i] + row[i - bpp]) & 0xff
      return

    case 2: // Up — predict from the pixel above.
      if (!prev) return
      for (let i = 0; i < n; i++) row[i] = (row[i] + prev[i]) & 0xff
      return

    case 3: // Average — mean of left and above.
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? row[i - bpp] : 0
        const up = prev ? prev[i] : 0
        row[i] = (row[i] + ((left + up) >> 1)) & 0xff
      }
      return

    case 4: // Paeth — whichever of left/above/upper-left is closest to their
      // linear estimate. The predictor that makes PNG competitive.
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? row[i - bpp] : 0
        const b = prev ? prev[i] : 0
        const c = prev && i >= bpp ? prev[i - bpp] : 0
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        row[i] = (row[i] + pred) & 0xff
      }
      return

    default:
      throw new Error(`unsupported PNG filter ${type}`)
  }
}

/**
 * Decodes the narrow subset of PNG that `ImageManipulator` produces.
 *
 * Throws on anything outside it — interlaced, paletted, 16-bit, greyscale —
 * rather than returning something plausible but wrong.
 */
function decodePng(bytes: Uint8Array): DecodedPng {
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) throw new Error('not a PNG')
  }

  let width = 0
  let height = 0
  let colorType = -1
  const idat: Uint8Array[] = []

  // Walk the chunk list: length, type, data, CRC. The CRC is not verified —
  // these bytes were produced locally moments ago, so corruption would mean a
  // failing device rather than a bad file.
  let at = 8
  while (at < bytes.length) {
    const len = readU32(bytes, at)
    const type = String.fromCharCode(
      bytes[at + 4],
      bytes[at + 5],
      bytes[at + 6],
      bytes[at + 7],
    )
    const dataAt = at + 8

    if (type === 'IHDR') {
      width = readU32(bytes, dataAt)
      height = readU32(bytes, dataAt + 4)
      const bitDepth = bytes[dataAt + 8]
      colorType = bytes[dataAt + 9]
      const interlace = bytes[dataAt + 12]
      if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`)
      if (interlace !== 0) throw new Error('interlaced PNG unsupported')
      // 2 = RGB, 6 = RGBA. Palette and greyscale are not emitted here.
      if (colorType !== 2 && colorType !== 6) {
        throw new Error(`unsupported PNG color type ${colorType}`)
      }
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dataAt, dataAt + len))
    } else if (type === 'IEND') {
      break
    }

    at = dataAt + len + 4 // + CRC
  }

  if (!width || !height || !idat.length) throw new Error('PNG missing image data')

  // IDAT may be split across chunks; the zlib stream spans all of them.
  let compressed: Uint8Array
  if (idat.length === 1) {
    compressed = idat[0]
  } else {
    let total = 0
    for (const part of idat) total += part.length
    compressed = new Uint8Array(total)
    let off = 0
    for (const part of idat) {
      compressed.set(part, off)
      off += part.length
    }
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
    // Copy so unfiltering does not mutate the inflated buffer under `prev`.
    const row = raw.slice(src, src + stride)
    src += stride
    if (row.length !== stride) throw new Error('PNG scanline truncated')

    unfilterRow(filter, row, prev, channels)

    // Widen RGB to RGBA; ThumbHash always wants four channels.
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

/**
 * Computes a base64 ThumbHash for an image on disk.
 *
 * Returns null on any failure. A missing hash costs nothing — the card shows a
 * plain placeholder until the real thumbnail decodes — so this must never
 * surface an error or block thumbnail generation.
 */
export async function thumbHashFor(imageUri: string): Promise<string | null> {
  try {
    const ctx = ImageManipulator.manipulate(imageUri)
    // `resize` with only a width preserves aspect ratio, so the taller axis of
    // a portrait cover could exceed ThumbHash's 100px limit. Constrain both.
    ctx.resize({ width: HASH_SIZE, height: HASH_SIZE })
    const rendered = await ctx.renderAsync()

    // PNG, not JPEG: JPEG is lossy and, more importantly, would need a second
    // decoder here. PNG at 64x64 is a few KB.
    const saved = await rendered.saveAsync({ format: SaveFormat.PNG, base64: true })
    if (!saved.base64) return null

    const binary = globalThis.atob(saved.base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

    const { width, height, rgba } = decodePng(bytes)
    if (width > 100 || height > 100) return null

    return toBase64(rgbaToThumbHash(width, height, rgba))
  } catch {
    // Unsupported PNG variant, a decode failure, a missing file — all mean the
    // same thing to the caller.
    return null
  }
}
