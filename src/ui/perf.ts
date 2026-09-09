/**
 * Development-only timing, in four lines.
 *
 * ## Why this exists
 *
 * Six audits have reasoned about this app's performance and none of them could
 * measure it, because nothing in the tree records how long anything takes. That
 * asymmetry is what let [AUDIT2 §1.2](../../AUDIT2.md) survive five passes: the
 * cost lives in a dependency's C++, so it is invisible to code review and
 * invisible to the app at runtime.
 *
 * Every line emitted here is prefixed `[perf]`, so one session's output can be
 * read as a whole with a single grep rather than hunted for among warnings.
 *
 * ## What it deliberately is not
 *
 * Not a profiler, not a metrics pipeline, and not shipped. There are four call
 * sites and each answers one question the R-series needs an answer to:
 *
 *  - `startup`  — does lazy-loading the reader subtree actually shorten launch?
 *  - `prepare`  — how much of a document open is the boundary crossing? This is
 *                 the number that decides whether R4-2 is worth building at all.
 *  - `viewer`   — is what remains the parse, or the WebView lifecycle? R5 is
 *                 gated on this.
 *  - `longtask` — does `measure()` stop growing per batch after R3-1?
 *
 * ## Why `Date.now()` and not `performance.now()`
 *
 * Hermes has both. The figures here are tens to thousands of milliseconds, so
 * sub-millisecond resolution buys nothing, and `Date.now()` is available
 * unchanged on a worklet runtime and under Node — which the two consumers below
 * that are not the JS thread both need.
 */

/**
 * Whether timing runs at all.
 *
 * `typeof` rather than a bare read, and that is load-bearing twice over.
 *
 * Under Node — where `src/__tests__` runs — `__DEV__` is not declared, and a
 * bare read is a `ReferenceError` that would take down any test importing a
 * module that imports this one. `typeof` on an undeclared identifier is legal
 * and yields `'undefined'`.
 *
 * In a release bundle Metro substitutes `false` for `__DEV__`, so this folds to
 * a module-level `const false`. Every `if (!PERF) return` below it then costs a
 * single comparison against a constant, and a minifier doing constant
 * propagation drops the guarded body outright — but the guarantee that matters
 * is the first part, which holds whether or not R8 gets that far.
 *
 * That is the reason the guard is a constant rather than a function call: on
 * the paths this series is trying to make fast, an instrumentation call has to
 * cost a comparison, not a call and a branch.
 */
export const PERF = typeof __DEV__ !== 'undefined' && __DEV__

/**
 * When this module was evaluated.
 *
 * `index.ts` imports it before anything else and this module imports nothing,
 * so this is the earliest point in *our* graph. `bundle-eval` is therefore the
 * evaluation of everything `index.ts` imports after it — `expo`, `App`, and
 * everything App reaches — which is the part R2-1 and R2-2 change.
 *
 * It does **not** include React Native's own runtime and polyfills, which are
 * loaded before any of our modules evaluate. The figure is our share of
 * startup, not the whole of it, and should not be compared against a
 * stopwatch held from the launcher icon.
 */
const BOOT = PERF ? Date.now() : 0

/** Epoch milliseconds, or 0 when timing is off so callers need no branch. */
export function now(): number {
  return PERF ? Date.now() : 0
}

/** Emits one line under the shared prefix. */
export function perf(line: string): void {
  if (!PERF) return
  console.log(`[perf] ${line}`)
}

/**
 * Named start points, for durations that begin and end in different modules.
 *
 * Only safe where there is exactly one in flight — startup, essentially. Two
 * concurrent operations sharing a name would overwrite each other's mark, which
 * is why document preparation uses `beginPrepare` and its own object instead:
 * the user lane and the prefetch lane run at the same time by design.
 */
const marks = new Map<string, number>()

export function mark(name: string): void {
  if (!PERF) return
  marks.set(name, Date.now())
}

/** Milliseconds since `mark(name)`, or 0 if it was never marked. */
export function since(name: string): number {
  if (!PERF) return 0
  const started = marks.get(name)
  return started === undefined ? 0 : Date.now() - started
}

// ------------------------------------------------------------------ startup --

/**
 * The three startup segments, filled in by three different modules.
 *
 * Accumulated rather than logged as they complete, because separately they are
 * three unattributable numbers and together they are a launch profile. The line
 * is emitted once, from the last of them to arrive.
 */
const startup: { bundleEval: number; hydrate: number; firstPaint: number } = {
  bundleEval: 0,
  hydrate: 0,
  firstPaint: 0,
}

/** Our module graph's evaluation cost. Called from `index.ts`. */
export function noteBundleEval(): void {
  if (!PERF) return
  startup.bundleEval = Date.now() - BOOT
}

/** Reading the index and normalizing it. Called from the library store. */
export function noteHydrate(ms: number): void {
  if (!PERF) return
  startup.hydrate = ms
}

/**
 * Splash hidden — the first moment the user sees the board.
 *
 * Measured from `BOOT` rather than from the previous segment, so it is a
 * wall-clock total rather than a sum that hides whatever happens between the
 * segments. `bundle-eval` and `store-hydrate` are components of it, not
 * predecessors.
 */
export function reportStartup(): void {
  if (!PERF) return
  startup.firstPaint = Date.now() - BOOT
  perf(
    `startup   bundle-eval ${startup.bundleEval}ms · store-hydrate ${startup.hydrate}ms` +
      ` → first-paint ${startup.firstPaint}ms`,
  )
}

// ------------------------------------------------------------------ prepare --

/**
 * One document's preparation, timed in segments.
 *
 * An object rather than named marks because two preparations genuinely overlap:
 * `prefetch.ts` warms a neighbour on its own worklet lane while the user opens
 * a file on theirs, and that separation is the entire point of having two
 * runtimes. A shared mark keyed by name would attribute one lane's time to the
 * other.
 *
 * `cross` is the segment worth staring at. It is wall-clock time spent inside
 * `runOnRuntimeAsync` *minus* the unzip the worklet reports having done, so it
 * is the cost of moving bytes across the runtime boundary and nothing else —
 * the figure [AUDIT2 §1.2](../../AUDIT2.md) derives from the library's C++ and
 * has never confirmed on a device.
 */
export interface PrepareTrace {
  /** Reading the file off disk into JS. */
  read(ms: number): void
  /** Moving bytes to and from the worklet runtime, excluding the unzip itself. */
  cross(ms: number): void
  /** The unzip, as reported from inside the worklet. */
  unzip(ms: number): void
  /** Everything after the bytes are in hand: parse, sanitise, assemble, count. */
  done(): void
}

/** Shared no-op, so a release build allocates nothing per document. */
const NOOP_TRACE: PrepareTrace = {
  read: () => {},
  cross: () => {},
  unzip: () => {},
  done: () => {},
}

export function beginPrepare(
  format: string,
  bytes: number,
  /**
   * Which lane did this work — `user` or `prefetch`.
   *
   * Reported because both run concurrently and the difference matters when
   * reading the log: a slow `prepare` line is a problem if the user was waiting
   * on it and expected background cost if they were not. Without the label the
   * two are indistinguishable and a prefetch would read as a slow open.
   */
  lane: string,
): PrepareTrace {
  if (!PERF) return NOOP_TRACE

  const started = Date.now()
  let read = 0
  let cross = 0
  let unzip = 0

  return {
    read: (ms) => {
      read += ms
    },
    cross: (ms) => {
      cross += ms
    },
    unzip: (ms) => {
      unzip += ms
    },
    done: () => {
      const total = Date.now() - started
      // Whatever is left once the measured segments are removed: parsing,
      // sanitising, anchor injection and character counting, which have no
      // single call site to wrap.
      const assemble = Math.max(0, total - read - cross - unzip)
      perf(
        `prepare   ${format} ${fmtBytes(bytes)} [${lane}] → read ${read}ms · cross ${cross}ms` +
          ` · unzip ${unzip}ms · assemble ${assemble}ms = ${total}ms`,
      )
    },
  }
}

/**
 * Bytes at one decimal place.
 *
 * Deliberately not `storage/formats`' `formatBytes`: importing it here would
 * make this module depend on the storage layer, and this is imported by
 * `index.ts` before anything else in the graph. A four-line duplicate is the
 * cheaper trade — and unlike the `toBase64` duplication in
 * [DETAIL.md §6.12](../../DETAIL.md), nothing about this one is load-bearing:
 * it formats a number in a log line nobody ships.
 */
function fmtBytes(n: number): string {
  if (n <= 0) return '0B'
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / (1024 * 1024)).toFixed(1)}MB`
}
