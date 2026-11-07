/**
 * A crash report the *user* sends — never one the app sends.
 *
 * ## Why not a crash-reporting service
 *
 * PRIVACY.md promises "no crash reporting that sends data off your device".
 * Sentry and its kind upload automatically, so adding one would break a
 * published promise. Instead, the launch after a fatal error asks whether to
 * email the report: the user sees exactly what it says in their own mail app
 * and decides whether it goes anywhere.
 *
 * The record is already scrubbed when stored (`crashLog.ts` — no document
 * names, no paths). This only formats it.
 *
 * Imports nothing, so it is tested directly (`crashReport.test.ts`).
 */

/** Where reports go: the contact address in PRIVACY.md. */
export const SUPPORT_EMAIL = 'saksham23.dev@gmail.com'

/**
 * Longest body put in a `mailto:` link. Some mail apps truncate or refuse a
 * longer URL, and the first stack frames are what matters.
 */
const MAX_BODY_CHARS = 1500

export interface CrashReportRecord {
  at: number
  where: string
  name: string
  message: string
  stack: string
}

/** Parses a stored record, or null if it is missing or malformed. */
export function parseCrashRecord(raw: string | null | undefined): CrashReportRecord | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const r = value as Record<string, unknown>
    if (typeof r.message !== 'string' || typeof r.name !== 'string') return null
    return {
      at: typeof r.at === 'number' ? r.at : 0,
      where: typeof r.where === 'string' ? r.where : 'unknown',
      name: r.name,
      message: r.message,
      stack: typeof r.stack === 'string' ? r.stack : '',
    }
  } catch {
    return null
  }
}

/** The report as plain text: what the user reads before sending it. */
export function crashReportText(record: CrashReportRecord, platform: string): string {
  const when = record.at ? new Date(record.at).toISOString() : 'unknown'
  const text = [
    'StackRead closed unexpectedly. Report:',
    '',
    `When: ${when}`,
    `Where: ${record.where}`,
    `Device: ${platform}`,
    `Error: ${record.name}: ${record.message}`,
    '',
    record.stack,
  ].join('\n')
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n…` : text
}

/** A `mailto:` link to the support address carrying the report. */
export function crashReportMailto(record: CrashReportRecord, platform: string): string {
  const subject = encodeURIComponent(`StackRead crash report: ${record.name}`)
  const body = encodeURIComponent(crashReportText(record, platform))
  return `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`
}
