/**
 * A ZIP reader that can run on a worklet runtime, and a store that keeps an
 * archive resident there between calls.
 *
 * ## Why this exists rather than calling fflate inside a worklet
 *
 * `offload.ts` used to call fflate's `unzipSync` from inside its worklets. That
 * cannot work in this build. The worklets Babel plugin runs without bundle mode
 * (babel-preset-expo adds it with no options), so a worklet can only call
 * functions that are themselves worklets. `unzipSync` is an ordinary import:
 * it is serialised as a *remote function*, and calling one on a worker runtime
 * throws "Tried to synchronously call a Remote Function"
 * (`react-native-worklets/src/memory/remoteFunctionUnpacker.native.ts`).
 *
 * Every offloaded unzip therefore paid to copy the whole archive across the
 * boundary, threw, and then unzipped on the JS thread in the fallback — the
 * copy bought nothing ([AUDIT4 A2](../../../AUDIT4.md)).
 *
 * Everything below is written as `'worklet'` functions with **no imports and
 * no references to module-level bindings**, so the plugin can ship each one to
 * the worker whole. It covers exactly what the app's archives use — stored and
 * deflated entries, no ZIP64, no encryption — and throws on anything else, so
 * the caller falls back to fflate on the JS thread rather than misreading a
 * file. `zipWorklet.test.ts` pins its output byte-for-byte against fflate.
 *
 * ## Why the archive stays on the worker
 *
 * An EPUB is unzipped in several passes: the listing, `container.xml`, the
 * OPF, the first-paint chapters, then the rest of the book and its images
 * after the first paint. Passing the archive to each pass copied the whole
 * file across the boundary every time. `parkArchive` copies it across once and
 * keeps it in the worker runtime's own global scope; later passes send only
 * entry names, and only the entries asked for come back.
 */

/** One entry's metadata, from the ZIP central directory. */
export interface ZipEntryInfo {
  name: string
  originalSize: number
}

/**
 * A Huffman decoding table: `map[bits]` is `(symbol << 4) | codeLength`, or 0
 * where no code matches. Type only, so a worklet can use it without capturing
 * anything.
 */
interface HuffMap {
  map: Uint16Array
  bits: number
}

export interface ZipReadResult {
  /** Every entry in the archive, in central-directory order. */
  entries: ZipEntryInfo[]
  /** Decompressed entries: the wanted ones, or all of them when `wanted` is null. */
  files: Record<string, Uint8Array>
}

/**
 * Reads a ZIP archive.
 *
 * @param wanted entry names to decompress; `null` decompresses everything.
 * @param listOnly when true, nothing is decompressed and `files` is empty.
 *
 * Throws on a ZIP64 archive, an encrypted entry, a compression method other
 * than stored/deflate, or corrupt data. Each of those is a reason to fall back
 * to fflate, never a reason to return partial data.
 */
export function zipRead(
  data: Uint8Array,
  wanted: readonly string[] | null,
  listOnly: boolean,
): ZipReadResult {
  'worklet'

  function u16(p: number): number {
    return data[p] | (data[p + 1] << 8)
  }

  function u32(p: number): number {
    return (data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24)) >>> 0
  }

  /*
   * Entry names: UTF-8 when general-purpose flag bit 11 is set, Latin-1
   * otherwise. That is the rule fflate applies, so both paths name entries the
   * same way. No TextDecoder: the worker runtime does not have one.
   */
  function decodeName(start: number, length: number, utf8: boolean): string {
    const end = start + length
    let out = ''
    let i = start
    while (i < end) {
      const c = data[i++]
      if (!utf8 || c < 0x80) {
        out += String.fromCharCode(c)
      } else if (c < 0xe0) {
        out += String.fromCharCode(((c & 0x1f) << 6) | (data[i++] & 0x3f))
      } else if (c < 0xf0) {
        out += String.fromCharCode(
          ((c & 0x0f) << 12) | ((data[i++] & 0x3f) << 6) | (data[i++] & 0x3f),
        )
      } else {
        const cp =
          (((c & 0x07) << 18) |
            ((data[i++] & 0x3f) << 12) |
            ((data[i++] & 0x3f) << 6) |
            (data[i++] & 0x3f)) -
          0x10000
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
      }
    }
    return out
  }

  /*
   * Builds a lookup table from canonical Huffman code lengths (RFC 1951 §3.2.2).
   *
   * DEFLATE packs codes starting at the least significant bit, so each code is
   * bit-reversed and written at every index whose low `len` bits match it.
   * One table read then decodes a symbol of any length.
   */
  function buildMap(lengths: Uint8Array, n: number): HuffMap {
    let max = 0
    for (let i = 0; i < n; i++) if (lengths[i] > max) max = lengths[i]
    if (!max) return { map: new Uint16Array(1), bits: 0 }

    const counts = new Uint16Array(16)
    for (let i = 0; i < n; i++) counts[lengths[i]]++
    counts[0] = 0

    const next = new Uint16Array(16)
    let code = 0
    for (let b = 1; b <= 15; b++) {
      code = (code + counts[b - 1]) << 1
      next[b] = code
    }

    const size = 1 << max
    const map = new Uint16Array(size)
    for (let sym = 0; sym < n; sym++) {
      const len = lengths[sym]
      if (!len) continue
      const c = next[len]++
      let reversed = 0
      for (let k = 0; k < len; k++) reversed |= ((c >> k) & 1) << (len - 1 - k)
      const entry = (sym << 4) | len
      for (let i = reversed; i < size; i += 1 << len) map[i] = entry
    }
    return { map, bits: max }
  }

  /*
   * Length and distance tables (RFC 1951 §3.2.5).
   *
   * Declared inside the function on purpose: a worklet can only see what it
   * declares or captures, and capturing a module-level table would copy it
   * across the boundary on every call.
   */
  const LEN_BASE = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
    131, 163, 195, 227, 258,
  ]
  const LEN_EXTRA = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
  ]
  const DIST_BASE = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
  ]
  const DIST_EXTRA = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
  ]
  const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

  let fixedLit: HuffMap | null = null
  let fixedDist: HuffMap | null = null

  /**
   * Inflates `data[start, end)` into `out`, which must be exactly the entry's
   * uncompressed size. A stream that ends short or runs over is corrupt, or
   * has a central directory that lies about its size; both throw.
   */
  function inflate(start: number, end: number, out: Uint8Array): void {
    let pos = start
    let bitBuf = 0
    let bitCnt = 0
    let op = 0
    const outLen = out.length

    function need(n: number): void {
      while (bitCnt < n) {
        // A peek may legitimately run a byte or two past the stream's end,
        // padded with zeros; anything further means the stream is truncated.
        if (pos >= end + 4) throw new Error('inflate: truncated stream')
        const b = pos < end ? data[pos] : 0
        pos++
        bitBuf |= b << bitCnt
        bitCnt += 8
      }
    }

    function bits(n: number): number {
      if (!n) return 0
      need(n)
      const v = bitBuf & ((1 << n) - 1)
      bitBuf >>>= n
      bitCnt -= n
      return v
    }

    function decode(h: HuffMap): number {
      need(h.bits)
      const e = h.map[bitBuf & ((1 << h.bits) - 1)]
      const len = e & 15
      if (!len) throw new Error('inflate: invalid code')
      bitBuf >>>= len
      bitCnt -= len
      return e >> 4
    }

    let final = 0
    do {
      final = bits(1)
      const type = bits(2)

      if (type === 0) {
        // Stored block: skip to the byte boundary, giving back whole bytes the
        // bit reader had already pulled in.
        const drop = bitCnt & 7
        bitBuf >>>= drop
        bitCnt -= drop
        pos -= bitCnt >> 3
        bitBuf = 0
        bitCnt = 0

        const len = u16(pos)
        const nlen = u16(pos + 2)
        pos += 4
        if ((len ^ 0xffff) !== nlen) throw new Error('inflate: bad stored block')
        if (pos + len > end || op + len > outLen) throw new Error('inflate: stored block overrun')
        out.set(data.subarray(pos, pos + len), op)
        op += len
        pos += len
        continue
      }

      let lit: HuffMap
      let dist: HuffMap

      if (type === 1) {
        if (!fixedLit || !fixedDist) {
          const l = new Uint8Array(288)
          for (let i = 0; i < 144; i++) l[i] = 8
          for (let i = 144; i < 256; i++) l[i] = 9
          for (let i = 256; i < 280; i++) l[i] = 7
          for (let i = 280; i < 288; i++) l[i] = 8
          fixedLit = buildMap(l, 288)
          const d = new Uint8Array(32)
          d.fill(5)
          fixedDist = buildMap(d, 32)
        }
        lit = fixedLit
        dist = fixedDist
      } else if (type === 2) {
        const hlit = bits(5) + 257
        const hdist = bits(5) + 1
        const hclen = bits(4) + 4

        const cl = new Uint8Array(19)
        for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3)
        const clMap = buildMap(cl, 19)

        const total = hlit + hdist
        const lens = new Uint8Array(total)
        let i = 0
        while (i < total) {
          const s = decode(clMap)
          if (s < 16) {
            lens[i++] = s
            continue
          }
          let repeat: number
          let value = 0
          if (s === 16) {
            if (!i) throw new Error('inflate: repeat with no previous length')
            value = lens[i - 1]
            repeat = 3 + bits(2)
          } else if (s === 17) {
            repeat = 3 + bits(3)
          } else {
            repeat = 11 + bits(7)
          }
          if (i + repeat > total) throw new Error('inflate: code lengths overrun')
          while (repeat--) lens[i++] = value
        }

        lit = buildMap(lens.subarray(0, hlit), hlit)
        dist = buildMap(lens.subarray(hlit), hdist)
      } else {
        throw new Error('inflate: invalid block type')
      }

      for (;;) {
        const sym = decode(lit)
        if (sym < 256) {
          if (op >= outLen) throw new Error('inflate: output overrun')
          out[op++] = sym
        } else if (sym === 256) {
          break
        } else {
          const li = sym - 257
          if (li >= 29) throw new Error('inflate: invalid length code')
          const length = LEN_BASE[li] + bits(LEN_EXTRA[li])
          const ds = decode(dist)
          if (ds >= 30) throw new Error('inflate: invalid distance code')
          const distance = DIST_BASE[ds] + bits(DIST_EXTRA[ds])
          if (distance > op || op + length > outLen) throw new Error('inflate: bad back-reference')
          for (let k = 0; k < length; k++) {
            out[op] = out[op - distance]
            op++
          }
        }
      }
    } while (!final)

    if (op !== outLen) throw new Error('inflate: size does not match the directory')
  }

  // ---- central directory ----------------------------------------------------

  // The end-of-central-directory record is the last 22 bytes, unless a
  // comment (at most 65535 bytes) follows it.
  let eocd = data.length - 22
  const floor = Math.max(0, data.length - 22 - 0xffff)
  while (eocd >= floor && u32(eocd) !== 0x06054b50) eocd--
  if (eocd < floor) throw new Error('zip: no end-of-central-directory record')

  const count = u16(eocd + 10)
  let p = u32(eocd + 16)
  if (count === 0xffff || p === 0xffffffff) throw new Error('zip: ZIP64 is not supported here')

  const want = wanted ? new Set(wanted) : null
  const entries: ZipEntryInfo[] = []
  const files: Record<string, Uint8Array> = {}

  for (let n = 0; n < count; n++) {
    if (u32(p) !== 0x02014b50) throw new Error('zip: bad central directory entry')

    const flags = u16(p + 8)
    const method = u16(p + 10)
    const compressedSize = u32(p + 20)
    const originalSize = u32(p + 24)
    const nameLength = u16(p + 28)
    const extraLength = u16(p + 30)
    const commentLength = u16(p + 32)
    const localOffset = u32(p + 42)
    const name = decodeName(p + 46, nameLength, (flags & 0x800) !== 0)
    p += 46 + nameLength + extraLength + commentLength

    if (compressedSize === 0xffffffff || originalSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('zip: ZIP64 is not supported here')
    }

    entries.push({ name, originalSize })

    if (listOnly || (want && !want.has(name))) continue
    if (flags & 1) throw new Error('zip: encrypted entries are not supported')
    if (u32(localOffset) !== 0x04034b50) throw new Error('zip: bad local header')

    const begin = localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28)
    const finish = begin + compressedSize
    if (finish > data.length) throw new Error('zip: entry runs past the archive')

    if (method === 0) {
      // `slice`, not `subarray`: a view would drag the whole archive's buffer
      // across the boundary when the result is serialised.
      files[name] = data.slice(begin, finish)
    } else if (method === 8) {
      const out = new Uint8Array(originalSize)
      inflate(begin, finish, out)
      files[name] = out
    } else {
      throw new Error(`zip: compression method ${method} is not supported here`)
    }
  }

  return { entries, files }
}

/** The worker-side store. Lives on the runtime's own `globalThis`. */
interface ParkedStore {
  /** Least recently used first. */
  order: string[]
  byKey: Map<string, Uint8Array>
}

/**
 * Keeps an archive resident on the current runtime under `key`, and returns its
 * listing.
 *
 * The listing is taken first, so an archive this reader cannot parse is never
 * parked. At most `maxResident` archives are kept; the least recently used is
 * dropped to make room. A dropped archive is not an error: `readParked`
 * reports it as missing and the caller parks it again from disk.
 */
export function parkArchive(key: string, data: Uint8Array, maxResident: number): ZipEntryInfo[] {
  'worklet'
  const listing = zipRead(data, [], true).entries

  const g = globalThis as unknown as { __srParked?: ParkedStore }
  if (!g.__srParked) g.__srParked = { order: [], byKey: new Map() }
  const store = g.__srParked

  const at = store.order.indexOf(key)
  if (at >= 0) store.order.splice(at, 1)
  store.order.push(key)
  store.byKey.set(key, data)

  while (store.order.length > maxResident) {
    const evicted = store.order.shift()
    if (evicted !== undefined) store.byKey.delete(evicted)
  }

  return listing
}

/**
 * Decompresses the named entries of a parked archive.
 *
 * Returns `null` when the archive is no longer resident, which the caller
 * answers by parking it again. Throws only for an archive this reader cannot
 * decode.
 */
export function readParked(key: string, wanted: readonly string[]): Record<string, Uint8Array> | null {
  'worklet'
  const store = (globalThis as unknown as { __srParked?: ParkedStore }).__srParked
  const data = store ? store.byKey.get(key) : undefined
  if (!store || !data) return null

  // Mark as recently used, so the archive being read is not the next evicted.
  const at = store.order.indexOf(key)
  if (at >= 0) {
    store.order.splice(at, 1)
    store.order.push(key)
  }

  return zipRead(data, wanted, false).files
}

/** Drops one parked archive, or every one when `key` is null. */
export function releaseParked(key: string | null): void {
  'worklet'
  const store = (globalThis as unknown as { __srParked?: ParkedStore }).__srParked
  if (!store) return
  if (key === null) {
    store.order = []
    store.byKey.clear()
    return
  }
  const at = store.order.indexOf(key)
  if (at >= 0) store.order.splice(at, 1)
  store.byKey.delete(key)
}
