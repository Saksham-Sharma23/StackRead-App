/**
 * Parses a message from the viewer into values the host can trust
 * ([AUDIT4 D5](../../../AUDIT4.md), AUDIT3 §2.3).
 *
 * ## Why the host cannot trust its own viewer
 *
 * The viewer is the app's own code, but it runs beside untrusted documents.
 * If either sanitiser — or the CSP — ever lets a document's script run, that
 * script can post anything over `ReactNativeWebView.postMessage`. The host used
 * to check only `typeof`, which admits `NaN` and `Infinity`: those went to
 * `setScroll` / `setProgress` / `setAnchor`, into MMKV, and back out to every
 * future mount of that file. Strings — the error text, the page label, the
 * search query — went to the screen at any length.
 *
 * This is the second line of defence, and it is worth having precisely because
 * it only matters when the first has failed. Every number is finite and in
 * range or absent; every string is capped or absent; a message too large to be
 * legitimate is dropped unread.
 *
 * Pure; tested directly.
 */

export interface ViewerMessage {
  type: string
  current?: number
  total?: number
  label?: string
  percent?: number
  scrollY?: number
  message?: string
  scale?: number
  query?: string
  truncated?: boolean
  offset?: number
  ms?: number
  anchors?: number
  href?: string
}

/**
 * Largest raw message accepted. Position and search reports are well under a
 * kilobyte; nothing the viewer legitimately sends comes near this.
 */
export const MAX_MESSAGE_CHARS = 16_384

const LIMITS = {
  label: 32,
  query: 500,
  message: 300,
  href: 2048,
  type: 32,
} as const

/** A finite number clamped to [min, max], or undefined. */
function num(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, value))
}

/** A string cut to `max` characters, or undefined. */
function str(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined
}

export function parseViewerMessage(data: unknown): ViewerMessage | null {
  if (typeof data !== 'string' || data.length > MAX_MESSAGE_CHARS) return null

  let raw: unknown
  try {
    raw = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>

  const type = str(m.type, LIMITS.type)
  if (!type) return null

  const out: ViewerMessage = { type }
  const set = <K extends keyof ViewerMessage>(key: K, value: ViewerMessage[K] | undefined) => {
    if (value !== undefined) out[key] = value
  }

  // Page numbers and counts: whole, positive, and far below anything absurd.
  set('current', num(m.current, 0, 1_000_000))
  set('total', num(m.total, 0, 1_000_000))
  set('percent', num(m.percent, 0, 100))
  // Offsets in pixels and characters: non-negative and finite is the property
  // that matters; the cap only refuses values no document could produce.
  set('scrollY', num(m.scrollY, 0, 1e9))
  set('offset', num(m.offset, 0, 1e9))
  set('scale', num(m.scale, 0.1, 20))
  set('ms', num(m.ms, 0, 1e6))
  set('anchors', num(m.anchors, 0, 1e7))

  set('label', str(m.label, LIMITS.label))
  set('query', str(m.query, LIMITS.query))
  set('message', str(m.message, LIMITS.message))
  set('href', str(m.href, LIMITS.href))
  if (typeof m.truncated === 'boolean') out.truncated = m.truncated

  return out
}
