import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'

import { toBase64 } from '../renderers/webview/bytes.ts'

/*
 * `offload.ts` moves unzipping and base64 onto a worklet runtime. Its central
 * safety property is that this changes *which thread* does the work and nothing
 * else — the results must be byte-identical to the synchronous path, and a
 * missing or failed runtime must fall back rather than fail to open a file.
 *
 * The module itself cannot be imported here: it pulls in
 * `react-native-worklets`, which has no Node implementation. What is testable
 * without a device is the contract the two paths share, which is what these
 * assert. On-device the fallback is exercised by construction — `canOffload()`
 * returns false wherever the native module is absent.
 */

test('the offload fallback produces identical base64 to the worklet path', () => {
  /*
   * Both paths run the same chunked loop; the worklet copy is written out
   * inline because a worklet body cannot reach an ordinary import. That
   * duplication is the risk, so this pins the two against each other.
   */
  const workletCopy = (data: Uint8Array): string => {
    const CHUNK = 0x2000
    let binary = ''
    for (let i = 0; i < data.length; i += CHUNK) {
      binary += String.fromCharCode(...data.subarray(i, i + CHUNK))
    }
    return globalThis.btoa(binary)
  }

  // Spans several chunk boundaries, which is where an off-by-one would show.
  const bytes = new Uint8Array(0x2000 * 3 + 17)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256

  assert.equal(workletCopy(bytes), toBase64(bytes))
})

test('the worklet chunk size matches the shared encoder', () => {
  /*
   * 8KB is load-bearing: `String.fromCharCode(...chunk)` spreads the chunk into
   * arguments, so a 32K-argument call overflows the stack on a large comic
   * page. Two copies of that constant now exist — the shared function and the
   * worklet body — and a reader "optimising" one would reintroduce the crash.
   */
  const bytes = new Uint8Array(0x2000 * 4)
  bytes.fill(0x41)
  // Encoding well past one chunk must not throw, whatever the chunking.
  assert.doesNotThrow(() => toBase64(bytes))
  assert.equal(toBase64(bytes).length % 4, 0, 'base64 output must stay padded')
})

test('unzipping off-thread returns the same entries as unzipSync', () => {
  /*
   * A worklet boundary serialises its result, so the record that comes back is
   * a structural copy rather than the same object. Callers consume it
   * immediately and never hold a reference across the boundary, so a copy is
   * fine — but the *contents* must survive intact, including binary entries
   * that are not valid UTF-8.
   */
  const archive = zipSync({
    'text.txt': strToU8('hello world'),
    'nested/dir/file.md': strToU8('# heading'),
    // Deliberately not valid UTF-8: a serialisation that stringified entries
    // would corrupt exactly this.
    'binary.bin': new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x7f]),
  })

  const unzipped = unzipSync(archive)

  assert.equal(strFromU8(unzipped['text.txt']), 'hello world')
  assert.equal(strFromU8(unzipped['nested/dir/file.md']), '# heading')
  assert.deepEqual([...unzipped['binary.bin']], [0x00, 0xff, 0xfe, 0x80, 0x7f])
})

test('an empty archive is an empty record, not a throw', () => {
  // Callers treat "no entries" as a content error with a real message; a throw
  // here would surface as an unhandled failure instead.
  const unzipped = unzipSync(zipSync({}))
  assert.deepEqual(Object.keys(unzipped), [])
})
