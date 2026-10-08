import { createWorkletRuntime, runOnRuntimeAsync } from 'react-native-worklets'
import { unzipSync } from 'fflate'

import { toBase64 } from './bytes'
import {
  parkArchive,
  readParked,
  releaseParked,
  zipRead,
  type ZipEntryInfo,
} from './zipWorklet'
import { PERF, now, type PrepareTrace } from '../../ui/perf'

export type { ZipEntryInfo } from './zipWorklet'

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
 * **The unzip itself must be a worklet.** A worklet can only call functions
 * that are worklets too; fflate's `unzipSync` is not, so calling it on the
 * worker threw and every unzip quietly fell back to the JS thread after paying
 * for the copy. The worker side now runs `zipRead` from `zipWorklet.ts`, and
 * fflate is used only in the JS-thread fallbacks below.
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
        const files = zipRead(data, null, false).files
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
      // `zipRead`, not fflate's `unzipSync`: only a worklet can be called from
      // a worklet. An archive `zipRead` does not support throws, and the catch
      // below hands it to fflate on the JS thread.
      return zipRead(data, null, false).files
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
 * How many archives each runtime keeps resident.
 *
 * Two, not one: the book being read and one more — a neighbour being prefetched
 * on the same lane, or the previous book while the next one opens. Each is a
 * whole archive held in native memory on the worker, so this is deliberately
 * small. Losing an archive to eviction costs one disk read and one copy, the
 * same as the pass that parked it.
 */
const MAX_RESIDENT = 2

/**
 * An archive opened for several targeted reads.
 *
 * The EPUB path reads one archive in up to six passes. Before this, each pass
 * was handed the whole file, and each hand-off copied it across the worklet
 * boundary ([AUDIT4 A2](../../../AUDIT4.md)). A handle crosses with the bytes
 * once; every later `unzip` sends only names.
 *
 * **It never holds the bytes on the JS side** once they are parked. Callers
 * that keep a handle in a cached document — `loadRest` and `loadImages` do —
 * therefore keep a key and a way to reload, not the whole book.
 */
export interface ArchiveHandle {
  /** Every entry, from the central directory. Nothing is decompressed for it. */
  readonly entries: ZipEntryInfo[]
  /** Decompresses the named entries. Names not in the archive are absent from the result. */
  unzip(names: string[], trace?: PrepareTrace): Promise<Record<string, Uint8Array>>
  /** Lets the worker drop the archive. Later `unzip` calls still work, by reloading. */
  release(): void
}

/** Distinguishes every parked archive, so a reopened file never reads a stale one. */
let parkSeq = 0

/** Keys parked per lane, so `releaseAllArchives` only visits runtimes that exist. */
const parkedLanes = new Set<OffloadLane>()

/**
 * Opens an archive for repeated targeted reads.
 *
 * `load` reads the file. It is called once here, and again only if the worker
 * evicted the archive or the worker path failed — so it must be safe to call
 * more than once, which reading from disk is.
 *
 * Where no worklet runtime is available, or the archive is one `zipRead` does
 * not support, the handle keeps the bytes on the JS side and unzips them with
 * fflate. That is the previous behaviour exactly; only the thread differs.
 */
export async function openArchive(
  load: () => Promise<Uint8Array>,
  lane: OffloadLane = 'user',
  trace?: PrepareTrace,
): Promise<ArchiveHandle> {
  const bytes = await load()

  if (canOffload()) {
    const key = `archive-${++parkSeq}`
    try {
      const wall = now()
      const entries = await runOnRuntimeAsync(
        getRuntime(lane),
        (data: Uint8Array, k: string, max: number) => {
          'worklet'
          return parkArchive(k, data, max)
        },
        bytes,
        key,
        MAX_RESIDENT,
      )
      // Parking is the one crossing that carries the whole archive, so it is
      // what the `cross` segment measures for this path.
      trace?.cross(now() - wall)
      parkedLanes.add(lane)
      return residentArchive(key, entries, load, lane)
    } catch {
      // Not parkable — ZIP64, an unusual method, a runtime failure. The bytes
      // are already in hand, so fall through rather than reading them twice.
    }
  }

  return jsArchive(bytes, load, trace)
}

/** Drops every parked archive on every runtime. For backgrounding and restores. */
export function releaseAllArchives(): void {
  for (const lane of parkedLanes) {
    const runtime = runtimes[lane]
    if (!runtime) continue
    runOnRuntimeAsync(runtime, () => {
      'worklet'
      releaseParked(null)
    }).catch(() => {
      // Nothing to recover: an archive that was not dropped is dropped by the
      // next eviction instead.
    })
  }
}

/** A handle whose archive lives on a worker runtime. */
function residentArchive(
  key: string,
  entries: ZipEntryInfo[],
  load: () => Promise<Uint8Array>,
  lane: OffloadLane,
): ArchiveHandle {
  /** Reads named entries from the parked archive; null when it was evicted. */
  const readResident = async (
    names: string[],
    trace?: PrepareTrace,
  ): Promise<Record<string, Uint8Array> | null> => {
    if (PERF) {
      const wall = now()
      const measured = await runOnRuntimeAsync(
        getRuntime(lane),
        (k: string, n: string[]) => {
          'worklet'
          const t0 = Date.now()
          const files = readParked(k, n)
          return { files, unzipMs: Date.now() - t0 }
        },
        key,
        names,
      )
      trace?.unzip(measured.unzipMs)
      trace?.cross(Math.max(0, now() - wall - measured.unzipMs))
      return measured.files
    }

    return await runOnRuntimeAsync(
      getRuntime(lane),
      (k: string, n: string[]) => {
        'worklet'
        return readParked(k, n)
      },
      key,
      names,
    )
  }

  return {
    entries,

    async unzip(names, trace) {
      if (!names.length) return {}

      try {
        const files = await readResident(names, trace)
        if (files) return files

        /*
         * Evicted: another archive took the slot, or the app was backgrounded
         * and `releaseAllArchives` ran. Park it again under the same key and
         * read once more. Rare, and costs what the original park cost.
         */
        await runOnRuntimeAsync(
          getRuntime(lane),
          (data: Uint8Array, k: string, max: number) => {
            'worklet'
            parkArchive(k, data, max)
          },
          await load(),
          key,
          MAX_RESIDENT,
        )
        const again = await readResident(names, trace)
        if (again) return again
      } catch {
        // Fall through to the JS thread.
      }

      return unzipNamed(await load(), names, trace)
    },

    release() {
      runOnRuntimeAsync(
        getRuntime(lane),
        (k: string) => {
          'worklet'
          releaseParked(k)
        },
        key,
      ).catch(() => {
        // An archive that could not be released is evicted by the next park.
      })
    },
  }
}

/** A handle that keeps the bytes on the JS thread and unzips with fflate. */
function jsArchive(
  initial: Uint8Array,
  load: () => Promise<Uint8Array>,
  trace?: PrepareTrace,
): ArchiveHandle {
  let bytes: Uint8Array | null = initial

  const entries: ZipEntryInfo[] = []
  const t0 = now()
  unzipSync(initial, {
    filter: (f) => {
      entries.push({ name: f.name, originalSize: f.originalSize })
      return false
    },
  })
  trace?.unzip(now() - t0)

  return {
    entries,
    async unzip(names, readTrace) {
      if (!names.length) return {}
      if (!bytes) bytes = await load()
      return unzipNamed(bytes, names, readTrace)
    },
    release() {
      // Dropping the reference is the whole release. A later read reloads.
      bytes = null
    },
  }
}

/** fflate on the JS thread, filtered to the named entries. */
function unzipNamed(
  bytes: Uint8Array,
  names: string[],
  trace?: PrepareTrace,
): Record<string, Uint8Array> {
  const t0 = now()
  const set = new Set(names)
  const files = unzipSync(bytes, { filter: (f) => set.has(f.name) })
  trace?.unzip(now() - t0)
  return files
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
