import { createWorkletRuntime, runOnRuntimeAsync } from 'react-native-worklets'
import { unzipSync } from 'fflate'

import { toBase64 } from './bytes'
import { PERF, now, type PrepareTrace } from '../../ui/perf'

/**
 * Runs the expensive, purely-computational parts of document preparation on a
 * background thread.
 *
 * ## Why this is needed
 *
 * `prepareFile` is declared `async`, but that only describes *when* its result
 * arrives — not which thread does the work. Unzipping an archive and
 * base64-encoding its images are synchronous loops over byte arrays, so on the
 * JS thread they block everything: the pager's commit, the scroll indicator's
 * seek, every touch handler. `InteractionManager.runAfterInteractions` defers
 * the *start* of that work until animations settle, which stops a prefetch
 * fighting the swipe that triggered it, but a 30MB EPUB parsed afterwards still
 * stalls a reader who has started scrolling.
 *
 * ## Why worklets and not fflate's async API
 *
 * `fflate` ships an async `unzip`, and it looked like the smaller change. It is
 * not usable here: its concurrency comes from Web Workers in the browser and
 * `worker_threads` under Node, and React Native has neither. On this platform
 * it degrades to running the same synchronous code behind a callback — the JS
 * thread blocks exactly as before, now with the appearance of being async,
 * which is worse than the honest version.
 *
 * `react-native-worklets` is already a dependency (Reanimated 4 requires it)
 * and `createWorkletRuntime` gives a real second JS runtime on its own thread.
 * Unzip and base64 are pure functions over byte arrays with no React, no
 * native modules and no shared mutable state, which is precisely the shape a
 * worklet runtime can take.
 *
 * ## What stays on the JS thread
 *
 * Only the byte-level work moves. Anything touching `expo-file-system`, the
 * XLSX library, or mammoth stays put: those are native modules or heavy
 * imports that are not available on a worklet runtime. The file is read on the
 * JS thread, the bytes are handed across, and the result comes back.
 */

/**
 * The background runtime, created lazily on first use.
 *
 * See the two-lane note below.
 */
type Runtime = ReturnType<typeof createWorkletRuntime>

/**
 * Two runtimes: one for work the user asked for, one for speculation.
 *
 * ## Why one was not enough
 *
 * `prefetch.ts` serialises *prefetches* against each other with a `busy` flag,
 * and deliberately does **not** block a file the user actually opened — the
 * reasoning there is sound: making an open slower because the app guessed you
 * might open something else is the worse trade.
 *
 * But both handed their bytes to a single runtime, which processes in order. So
 * opening a file while a 30MB comic was being prefetched queued the user's own
 * document behind it. The `busy` flag never covered that, because the
 * contention was one level down.
 *
 * Separating them is two lines and one extra JS context. The user's parse now
 * runs immediately regardless of what speculation is in flight, which is the
 * property `prefetch.ts` claims in its own docstring and could not actually
 * deliver.
 *
 * ## Why not a runtime per parse
 *
 * Creating one spins up a JS context, which costs far more than most parses do.
 * Two is the smallest number that removes the head-of-line blocking, and each
 * is still created lazily — someone who only opens PDFs and images pays for
 * neither.
 */
const runtimes: { user: Runtime | null; prefetch: Runtime | null } = {
  user: null,
  prefetch: null,
}

/** Which queue a caller belongs to. */
export type OffloadLane = 'user' | 'prefetch'

function getRuntime(lane: OffloadLane = 'user') {
  if (!runtimes[lane]) {
    runtimes[lane] = createWorkletRuntime(`stackread-parse-${lane}`)
  }
  return runtimes[lane]
}

/**
 * True when the worklet runtime is usable.
 *
 * Guards against a JS-only context — tests under Node, and any environment
 * where the native module is absent. Callers fall back to synchronous work
 * rather than failing, so behaviour is identical and only the thread differs.
 */
export function canOffload(): boolean {
  try {
    return typeof createWorkletRuntime === 'function' && !!getRuntime()
  } catch {
    return false
  }
}

/**
 * Unzips an archive off the JS thread.
 *
 * Falls back to a synchronous unzip when no worklet runtime is available, so
 * the caller never has to branch. The fallback is the previous behaviour
 * exactly.
 *
 * Note the return type: a worklet boundary serialises its result, so the
 * `Record<string, Uint8Array>` that comes back is a copy rather than the same
 * object. That is fine here — the caller consumes it immediately and never
 * holds a reference across the boundary.
 */
export async function unzipOffThread(
  bytes: Uint8Array,
  lane: OffloadLane = 'user',
  /**
   * Optional timing sink. See `beginPrepare` in `ui/perf`.
   *
   * Passed in rather than kept module-level because the two lanes run
   * concurrently by design — a prefetch warming a neighbour while the user
   * opens a file — so a shared accumulator would attribute one lane's time to
   * the other.
   */
  trace?: PrepareTrace,
): Promise<Record<string, Uint8Array>> {
  if (!canOffload()) {
    const t0 = now()
    const files = unzipSync(bytes)
    trace?.unzip(now() - t0)
    return files
  }

  try {
    /*
     * Two paths, and the split is deliberate rather than tidy.
     *
     * The instrumented one returns a wrapper object from the worklet, which is
     * an extra property crossing the boundary — and this module exists to make
     * that crossing cheaper, not to add to it. So in release, where `PERF`
     * folds to a constant `false`, this branch is unreachable and the plain
     * call below is the only one that runs.
     */
    if (PERF) {
      const wall = now()
      const measured = await runOnRuntimeAsync(getRuntime(lane), (data: Uint8Array) => {
        'worklet'
        const t0 = Date.now()
        const files = unzipSync(data)
        // Reported from *inside* the runtime, so the caller can subtract it
        // from wall time and be left with the crossing cost alone. That
        // difference is the only direct evidence for AUDIT2 §1.2, which is
        // otherwise arithmetic over the library's C++.
        return { files, unzipMs: Date.now() - t0 }
      }, bytes)
      const elapsed = now() - wall
      trace?.unzip(measured.unzipMs)
      trace?.cross(Math.max(0, elapsed - measured.unzipMs))
      return measured.files
    }

    return await runOnRuntimeAsync(getRuntime(lane), (data: Uint8Array) => {
      'worklet'
      // `unzipSync` is imported into the worklet's closure. fflate is pure JS
      // with no platform dependencies, which is what makes this legal — a
      // library touching a native module could not be captured this way.
      return unzipSync(data)
    }, bytes)
  } catch {
    /*
     * Never let an offload failure become a failure to open a file.
     *
     * A worklet can fail for reasons that have nothing to do with the document
     * — a runtime that could not be created, a serialisation limit on a very
     * large archive. Falling back keeps the file readable and costs only the
     * jank this module exists to avoid.
     *
     * Timed like the other two paths. An untimed fallback would not merely be
     * missing a number — its unzip would be silently absorbed into `assemble`,
     * which is computed as the remainder, and a document that quietly took the
     * fallback would read as one with a slow parser.
     */
    const t0 = now()
    const files = unzipSync(bytes)
    trace?.unzip(now() - t0)
    return files
  }
}

/**
 * One entry's metadata, straight from the ZIP central directory.
 *
 * `originalSize` is the uncompressed byte count, and the archive records it
 * without anything having to be decompressed — which is what makes a two-phase
 * open possible at all.
 */
export interface ZipEntryInfo {
  name: string
  originalSize: number
}

/**
 * Lists an archive's entries **without decompressing any of them**.
 *
 * fflate's filter is called once per entry with its central-directory record;
 * returning false everywhere means the walk reads the directory and stops. So
 * this is a few hundred microseconds regardless of how large the archive is.
 */
export async function listEntriesOffThread(
  bytes: Uint8Array,
  lane: OffloadLane = 'user',
): Promise<ZipEntryInfo[]> {
  const collect = (data: Uint8Array): ZipEntryInfo[] => {
    const out: ZipEntryInfo[] = []
    unzipSync(data, {
      filter: (f) => {
        out.push({ name: f.name, originalSize: f.originalSize })
        return false
      },
    })
    return out
  }

  if (!canOffload()) return collect(bytes)

  try {
    return await runOnRuntimeAsync(getRuntime(lane), (data: Uint8Array) => {
      'worklet'
      const out: { name: string; originalSize: number }[] = []
      unzipSync(data, {
        filter: (f) => {
          out.push({ name: f.name, originalSize: f.originalSize })
          return false
        },
      })
      return out
    }, bytes)
  } catch {
    return collect(bytes)
  }
}

/**
 * Unzips only the entries a caller names.
 *
 * The point of the `wanted` set is that everything outside it is never
 * decompressed *and* never crosses the runtime boundary — which is where the
 * cost actually is (see the copy semantics in
 * [AUDIT2 §1.2](../../AUDIT2.md)). Opening a 600-page book on its first three
 * chapters therefore moves kilobytes rather than tens of megabytes.
 *
 * A plain array rather than a Set for the argument, because a Set does not
 * survive the worklet boundary — it serialises as an empty object, which would
 * silently match nothing and return an empty archive.
 */
export async function unzipSomeOffThread(
  bytes: Uint8Array,
  wanted: string[],
  lane: OffloadLane = 'user',
  trace?: PrepareTrace,
): Promise<Record<string, Uint8Array>> {
  if (!wanted.length) return {}

  const run = (data: Uint8Array, names: string[]): Record<string, Uint8Array> => {
    const set = new Set(names)
    return unzipSync(data, { filter: (f) => set.has(f.name) })
  }

  if (!canOffload()) {
    const t0 = now()
    const files = run(bytes, wanted)
    trace?.unzip(now() - t0)
    return files
  }

  try {
    if (PERF) {
      const wall = now()
      const measured = await runOnRuntimeAsync(
        getRuntime(lane),
        (data: Uint8Array, names: string[]) => {
          'worklet'
          const t0 = Date.now()
          const set = new Set(names)
          const files = unzipSync(data, { filter: (f) => set.has(f.name) })
          return { files, unzipMs: Date.now() - t0 }
        },
        bytes,
        wanted,
      )
      const elapsed = now() - wall
      trace?.unzip(measured.unzipMs)
      trace?.cross(Math.max(0, elapsed - measured.unzipMs))
      return measured.files
    }

    return await runOnRuntimeAsync(
      getRuntime(lane),
      (data: Uint8Array, names: string[]) => {
        'worklet'
        const set = new Set(names)
        return unzipSync(data, { filter: (f) => set.has(f.name) })
      },
      bytes,
      wanted,
    )
  } catch {
    const t0 = now()
    const files = run(bytes, wanted)
    trace?.unzip(now() - t0)
    return files
  }
}

/**
 * Base64-encodes bytes off the JS thread.
 *
 * The loop is written out inside the worklet rather than calling `toBase64`,
 * because a worklet body is compiled in isolation and can only reach what it
 * captures — an ordinary imported function is not available on the other
 * runtime. The *fallback* path does call the shared one, so the two cannot
 * silently diverge in behaviour.
 *
 * The chunk size is repeated here with its reasoning intact, since it is the
 * part that must never drift: see `bytes.ts` for why 8KB and not more.
 */
export async function toBase64OffThread(
  bytes: Uint8Array,
  lane: OffloadLane = 'user',
): Promise<string> {
  if (!canOffload()) return toBase64(bytes)

  try {
    return await runOnRuntimeAsync(getRuntime(lane), (data: Uint8Array) => {
      'worklet'
      // 8KB chunks: `String.fromCharCode(...chunk)` spreads the chunk into
      // arguments, so a 32K-argument call overflows the stack on a large image.
      const CHUNK = 0x2000
      let binary = ''
      for (let i = 0; i < data.length; i += CHUNK) {
        binary += String.fromCharCode(...data.subarray(i, i + CHUNK))
      }
      return globalThis.btoa(binary)
    }, bytes)
  } catch {
    return toBase64(bytes)
  }
}
