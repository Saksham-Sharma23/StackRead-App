/**
 * Who may have a pdfium document open, and when it is safe to tear one down.
 *
 * ## Why this exists
 *
 * Two rules are written all over this codebase and enforced by none of it:
 *
 *  1. Only one pdfium document may be live at a time — three crashed inside
 *     `FPDF_LoadPage` when one was unmounted mid-render (DETAIL.md §8).
 *  2. A document must not be torn down while it is still loading.
 *
 * `PdfCoverFactory` and `PdfRenderer` each assumed the other was absent, and
 * the factory lived inside the board — which is unmounted the instant a card is
 * tapped, taking a half-loaded document with it ([AUDIT4 A8](../../AUDIT4.md)).
 * A lease makes both rules a property of the code instead of a hope.
 *
 * ## Semantics
 *
 *  - `acquirePdfium(owner)` resolves with a lease once no one else holds one.
 *    Requests are granted in order.
 *  - The holder calls `markSettled()` once its document is loaded and its first
 *    pages have had time to render — the point after which unmounting it is an
 *    ordinary teardown rather than an interruption.
 *  - The holder calls `release()` when its document is gone. Both calls are
 *    idempotent, so cleanup paths can call them without bookkeeping.
 *  - A caller that is gone by the time its lease is granted must release it
 *    immediately; that is how a cancelled request leaves the queue.
 *
 * Pure: no React, no native modules. Tested directly.
 */

export interface PdfiumLease {
  readonly owner: string
  /** The document has loaded and settled; tearing it down is now safe. */
  markSettled(): void
  /** The document is gone; the next request may proceed. */
  release(): void
}

interface Holder {
  owner: string
  settled: boolean
  released: boolean
}

let holder: Holder | null = null
const queue: { owner: string; grant: (lease: PdfiumLease) => void }[] = []
let settleWaiters: (() => void)[] = []

function notifySettled(): void {
  if (!isPdfiumSettled()) return
  const waiters = settleWaiters
  settleWaiters = []
  for (const wake of waiters) wake()
}

function grantNext(): void {
  if (holder || !queue.length) return
  const next = queue.shift()!
  const h: Holder = { owner: next.owner, settled: false, released: false }
  holder = h
  next.grant({
    owner: h.owner,
    markSettled() {
      if (h.settled || h.released) return
      h.settled = true
      notifySettled()
    },
    release() {
      if (h.released) return
      h.released = true
      if (holder === h) {
        holder = null
        notifySettled()
        grantNext()
      }
    },
  })
}

/** Waits for, then takes, the right to open a pdfium document. */
export function acquirePdfium(owner: string): Promise<PdfiumLease> {
  return new Promise((resolve) => {
    queue.push({ owner, grant: resolve })
    grantNext()
  })
}

/** True when no document is mid-load: nobody holds the lease, or its holder has settled. */
export function isPdfiumSettled(): boolean {
  return !holder || holder.settled || holder.released
}

/** Who holds the lease, for logs and tests. */
export function pdfiumHolder(): string | null {
  return holder ? holder.owner : null
}

/**
 * Resolves once no document is mid-load, or after `timeoutMs` regardless.
 *
 * The timeout is a backstop for a document that never reports either outcome;
 * waiting forever would turn a stuck PDF into a reader that cannot be closed.
 */
export function whenPdfiumSettled(timeoutMs: number): Promise<void> {
  if (isPdfiumSettled()) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    settleWaiters.push(finish)
    setTimeout(finish, timeoutMs)
  })
}

/** Test-only: forget every holder and request. */
export function resetPdfiumLeaseForTests(): void {
  holder = null
  queue.length = 0
  settleWaiters = []
}
