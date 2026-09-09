/**
 * Byte- and MIME-level helpers shared by every format that inlines an image.
 *
 * These lived as copy-pasted pairs in `epub.ts` and `prepare.ts`, and that
 * duplication has already caused two bugs (see DETAIL.md §6.12):
 *
 *  - The stack-overflow fix that changed `CHUNK` from 32KB to 8KB was applied to
 *    one copy only, leaving the crash reachable through a large comic page.
 *  - The two `mimeForImage` implementations drifted apart: the EPUB copy handled
 *    SVG but not AVIF, the archive copy AVIF but not SVG. An AVIF cover in an
 *    EPUB was therefore served as `image/jpeg`.
 *
 * One copy, so the next fix cannot be half-applied.
 */

/**
 * Base64 for a byte array, in 8KB chunks.
 *
 * **The document pipeline no longer calls this.** Encoding moved to
 * `offload.toBase64OffThread`, which runs the same loop on a worklet runtime so
 * a large comic does not block scrolling. This remains as the reference
 * implementation and is what `offload` falls back to when no worklet runtime
 * exists — a JS-only context, or a runtime that failed to start.
 *
 * Kept exported and tested rather than inlined into `offload`, because the
 * chunk-size constraint below is the thing that must not be lost, and
 * `bytes.test.ts` is what pins it.
 *
 * The chunk size is load-bearing, not a tuning knob.
 * `String.fromCharCode(...chunk)` *spreads* the chunk into arguments, so the
 * chunk length becomes an argument count — and a 32K-argument call overflows
 * the stack on a large comic page. 8KB is the size that stopped crashing.
 * Raising it "for speed" reintroduces the crash on exactly the large files that
 * make it hurt.
 */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x2000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return globalThis.btoa(binary)
}

/**
 * MIME type for an image path, for building a `data:` URI.
 *
 * Falls back to JPEG because a wrong-but-plausible type still renders in a
 * WebView, whereas no type at all does not.
 */
export function mimeForImage(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'avif') return 'image/avif'
  if (ext === 'svg') return 'image/svg+xml'
  if (ext === 'bmp') return 'image/bmp'
  return 'image/jpeg'
}

/*
 * `IMAGE_RE` is deliberately *not* shared.
 *
 * In `prepare.ts` it decides which zip entries become pages of a comic or
 * archive preview, and it excludes SVG on purpose: an SVG inlined as a data URI
 * is a document, not a bitmap, and can carry script. The EPUB path is different
 * — there an image is referenced by a chapter that has already been sanitised —
 * so the two really do want different sets, and merging them would quietly
 * widen what a CBZ is allowed to contain.
 */
