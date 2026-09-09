/**
 * The pure geometry behind the page-dots strip.
 *
 * Split out of [PageDots.tsx](PageDots.tsx) so it can be tested directly. The
 * component imports react-native and Reanimated, neither of which loads outside
 * a device runtime — so the tests used to keep their own copy of this
 * arithmetic and a regex drift-check to notice when the two diverged. Nothing
 * here touches React or the UI thread, so the tests can now call the real
 * thing and the duplication is gone.
 *
 * Everything in this file runs during render, on the JS thread. The droplet's
 * per-frame shape maths deliberately stays inline in its worklet — a worklet is
 * compiled in isolation and reaching an ordinary import from one is a separate
 * concern from wanting the numbers tested.
 */

/** Dots visible at once. Beyond this the window slides instead of growing. */
export const WINDOW = 12

/**
 * Edge dots rendered small rather than full size.
 *
 * Two on each side gives a visible size ramp (small, medium, full) so the taper
 * reads as "the strip continues" rather than as dots being cut off. One would
 * look like a rendering glitch; three wastes a quarter of the window on hints.
 */
export const EDGE_RAMP = 2

/**
 * Dot geometry.
 *
 * The marker is a **capsule**: the same height as the inactive dots, wider, and
 * fully rounded at both ends.
 *
 * The width-to-height ratio is deliberately short — about 1.45:1, a stadium
 * rather than a bar. A long thin pill reads as a progress track; this reads as
 * "you are here".
 *
 * That ratio is why `DOT` is 9 rather than a smaller value. At 7pt tall a
 * 1.45:1 capsule is only ~10pt wide, which is not visibly different from a
 * circle at arm's length — the dots have to be big enough for the shape
 * difference to carry the meaning.
 */
export const DOT = 9
export const PILL_W = 13
export const GAP = 7

/**
 * Where the window starts, so the active dot stays as central as possible.
 *
 * Clamped at both ends: near the start or end of the group the window stops
 * sliding and the active dot moves within it instead. Without the clamp the
 * window would run past the edges and render blanks.
 */
export function windowStart(count: number, index: number): number {
  if (count <= WINDOW) return 0
  return Math.max(0, Math.min(count - WINDOW, index - Math.floor(WINDOW / 2)))
}

/**
 * Scale for a dot at `slot` within the window, 0..1 of full size.
 *
 * Only the ends of a window that actually continues are ramped down — when the
 * window is already showing the first or last file there is nothing more in
 * that direction, so those dots stay full size and the strip does not lie about
 * having more content.
 */
export function edgeScale(
  slot: number,
  visible: number,
  moreBefore: boolean,
  moreAfter: boolean,
): number {
  const fromStart = slot
  const fromEnd = visible - 1 - slot

  let scale = 1
  if (moreBefore && fromStart < EDGE_RAMP) {
    scale = Math.min(scale, (fromStart + 1) / (EDGE_RAMP + 1))
  }
  if (moreAfter && fromEnd < EDGE_RAMP) {
    scale = Math.min(scale, (fromEnd + 1) / (EDGE_RAMP + 1))
  }
  return scale
}

/**
 * Slot centres, in row coordinates.
 *
 * Computed rather than measured with `onLayout`: the geometry is a pure
 * function of the edge ramp, so measuring it would mean waiting a frame for
 * numbers already known here — and the travelling capsule would visibly jump
 * into place on the first render of every group.
 *
 * The result is the output range the capsule interpolates over, so it must be
 * **strictly increasing**: a flat or decreasing pair would make the marker jump
 * backwards partway through a swipe.
 */
export function slotCenters(visible: number, moreBefore: boolean, moreAfter: boolean): number[] {
  const centers: number[] = []
  let x = 0
  for (let slot = 0; slot < visible; slot++) {
    const w = DOT * edgeScale(slot, visible, moreBefore, moreAfter) + GAP
    centers.push(x + w / 2)
    x += w
  }
  return centers
}
