import { storage, LAST_CRASH_KEY } from '../storage/mmkv'
import { scrubPaths } from './scrub'

/**
 * A minimal record of the errors that take the app down.
 *
 * ## Why this exists
 *
 * A release build that hits an uncaught JS error exits, and the only trace is a
 * logcat line nobody captured ([AUDIT4 A10](../../AUDIT4.md)). This keeps the
 * last fatal error in MMKV — written synchronously, before the default handler
 * kills the process — and reports it on the next launch, so "it crashed when I
 * went back" comes with a message and a stack.
 *
 * It is also the seam crash reporting (TASKS2 R7-1) plugs into: one place sees
 * every fatal error and every error a boundary caught.
 *
 * ## What is recorded
 *
 * The message, the error's name, the first stack frames and where it was caught.
 * Never document names or paths that the app adds itself — the logging rule in
 * AUDIT3 §2.4 applies doubly to anything that may one day leave the device.
 */

/** Stack frames kept. Enough to find the throw; short enough to stay cheap. */
const STACK_LINES = 12

/** Hard cap on the stored record, so a pathological message cannot bloat MMKV. */
const MAX_RECORD_CHARS = 4000

export interface CrashRecord {
  at: number
  where: string
  fatal: boolean
  name: string
  message: string
  stack: string
}

function describe(error: unknown, where: string, fatal: boolean): CrashRecord {
  const e = error instanceof Error ? error : new Error(String(error))
  return {
    at: Date.now(),
    where,
    fatal,
    name: e.name,
    message: scrubPaths(e.message).slice(0, 500),
    stack: scrubPaths((e.stack ?? '').split('\n').slice(0, STACK_LINES).join('\n')),
  }
}

/**
 * Records an error. Called by the global handler for fatal errors and by error
 * boundaries for the ones they contain. Never throws: a logger that can crash
 * would turn every caught error into an uncaught one.
 */
export function noteError(error: unknown, where: string, fatal = false): void {
  try {
    const record = describe(error, where, fatal)
    console.error(`[stackread] ${fatal ? 'FATAL' : 'caught'} in ${where}: ${record.name}: ${record.message}`)
    if (fatal) storage.set(LAST_CRASH_KEY, JSON.stringify(record).slice(0, MAX_RECORD_CHARS))
  } catch {
    // Nothing left to do.
  }
}

let installed = false

/**
 * Wraps React Native's global error handler so fatal errors are recorded first.
 *
 * The default handler still runs afterwards and still ends the process on a
 * fatal error. Swallowing it would leave the app running in whatever state the
 * throw interrupted, which is worse than a restart.
 */
export function installCrashLog(): void {
  if (installed || typeof ErrorUtils === 'undefined') return
  installed = true

  const previous = ErrorUtils.getGlobalHandler()
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    noteError(error, 'global', isFatal === true)
    previous(error, isFatal)
  })

  reportPreviousCrash()
}

/**
 * Logs, then clears, the fatal error the previous session died with.
 *
 * Logged rather than shown: the user already knows the app closed, and a dialog
 * about it on the next launch helps nobody. A developer reading logcat, or
 * crash reporting once it exists, is the audience.
 */
function reportPreviousCrash(): void {
  try {
    const raw = storage.getString(LAST_CRASH_KEY)
    if (!raw) return
    storage.remove(LAST_CRASH_KEY)
    console.warn(`[stackread] the previous session ended with a fatal error:\n${raw}`)
  } catch {
    // A corrupt record is not worth a second crash.
  }
}
