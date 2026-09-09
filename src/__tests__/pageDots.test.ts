import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DOT,
  EDGE_RAMP,
  GAP,
  PILL_W,
  WINDOW,
  edgeScale,
  slotCenters,
  windowStart,
} from '../components/pageDotsGeometry.ts'

/*
 * The sliding-window arithmetic behind PageDots, and the geometry the
 * travelling marker interpolates over.
 *
 * These used to be re-implemented at the top of this file, because importing
 * the component pulls in react-native and Reanimated and neither loads outside
 * a device runtime — with a regex drift-check to notice when the copy and the
 * component disagreed. The geometry now lives in its own dependency-free
 * module, so this exercises the real code and the copy is gone.
 */

test('a group that fits shows every file from the start', () => {
  assert.equal(windowStart(5, 0), 0)
  assert.equal(windowStart(5, 4), 0)
  assert.equal(windowStart(WINDOW, 11), 0)
})

test('the window does not slide until the group exceeds it', () => {
  // Exactly WINDOW files must never scroll — every dot is already visible.
  for (let i = 0; i < WINDOW; i++) assert.equal(windowStart(WINDOW, i), 0)
})

test('the window centres the active file once it slides', () => {
  // 40 files, sitting on index 20: the window should straddle it.
  const start = windowStart(40, 20)
  assert.ok(start <= 20 && 20 < start + WINDOW, 'active file outside its own window')
  assert.equal(start, 14)
})

test('the window clamps at the start rather than going negative', () => {
  assert.equal(windowStart(40, 0), 0)
  assert.equal(windowStart(40, 3), 0)
})

test('the window clamps at the end rather than running past it', () => {
  const start = windowStart(40, 39)
  assert.equal(start, 40 - WINDOW)
  assert.ok(start + WINDOW <= 40, 'window extends past the last file')
})

test('the active file is always inside the window, at every position', () => {
  // The property that actually matters: there is no index where the strip
  // fails to show where you are.
  for (const count of [2, 11, 12, 13, 40, 137]) {
    for (let i = 0; i < count; i++) {
      const start = windowStart(count, i)
      assert.ok(start >= 0, `negative start at ${i}/${count}`)
      assert.ok(start <= i, `window starts after the active file at ${i}/${count}`)
      assert.ok(i < start + Math.min(WINDOW, count), `active file past window end at ${i}/${count}`)
      assert.ok(
        start + Math.min(WINDOW, count) <= count,
        `window overruns the group at ${i}/${count}`,
      )
    }
  }
})

test('edges only fade where the strip actually continues', () => {
  // At the very start of a long group there is nothing before, so the leading
  // dots stay full size — the ramp must not imply content that is not there.
  assert.equal(edgeScale(0, WINDOW, false, true), 1)
  assert.ok(edgeScale(WINDOW - 1, WINDOW, false, true) < 1)

  // And the mirror image at the end.
  assert.ok(edgeScale(0, WINDOW, true, false) < 1)
  assert.equal(edgeScale(WINDOW - 1, WINDOW, true, false), 1)
})

test('a group that fits has no faded dots at all', () => {
  for (let slot = 0; slot < 5; slot++) {
    assert.equal(edgeScale(slot, 5, false, false), 1)
  }
})

test('the fade ramps rather than jumping to zero', () => {
  // A dot scaled to 0 is invisible and reads as a gap, not a hint.
  const outer = edgeScale(0, WINDOW, true, true)
  const inner = edgeScale(1, WINDOW, true, true)
  assert.ok(outer > 0, 'outermost dot is fully invisible')
  assert.ok(outer < inner, 'ramp is not increasing inward')
  assert.equal(edgeScale(EDGE_RAMP, WINDOW, true, true), 1, 'ramp extends too far inward')
})

/* ---- the travelling marker's track ---- */

test('slot centres are strictly increasing', () => {
  /*
   * This is the output range the marker interpolates over as it travels. A flat
   * or decreasing pair would make it stall or jump backwards partway through a
   * swipe — and because the edge ramp shrinks some slots and not others, the
   * spacing is genuinely uneven, so "obviously sorted" is not a safe assumption.
   */
  for (const [visible, before, after] of [
    [WINDOW, true, true],
    [WINDOW, false, true],
    [WINDOW, true, false],
    [WINDOW, false, false],
    [2, false, false],
    [5, false, false],
  ] as const) {
    const centers = slotCenters(visible, before, after)
    assert.equal(centers.length, visible, `wrong number of centres at visible=${visible}`)
    for (let i = 1; i < centers.length; i++) {
      assert.ok(
        centers[i] > centers[i - 1],
        `centre ${i} is not past centre ${i - 1} (${before}/${after})`,
      )
    }
  }
})

test('slot centres sit inside their own slot', () => {
  // The marker parks on a centre when at rest, so a centre that drifted outside
  // its slot would leave it visibly off the dot it is meant to be marking.
  const visible = WINDOW
  const centers = slotCenters(visible, true, true)

  let x = 0
  for (let slot = 0; slot < visible; slot++) {
    const w = DOT * edgeScale(slot, visible, true, true) + GAP
    assert.ok(centers[slot] > x, `centre ${slot} is before its slot`)
    assert.ok(centers[slot] < x + w, `centre ${slot} is past its slot`)
    x += w
  }
})

test('a fitting group starts its first centre half a slot in', () => {
  // No ramp, so every slot is the same width and the arithmetic is checkable
  // by hand — the case that pins the others being merely self-consistent.
  const centers = slotCenters(4, false, false)
  const w = DOT + GAP
  assert.deepEqual(centers, [w / 2, w * 1.5, w * 2.5, w * 3.5])
})

/* ---- the droplet's shape ---- */

/**
 * The shape maths from `Droplet`'s animated style.
 *
 * Mirrored rather than imported, for the reason the codebase already records
 * for `offload.ts`: a worklet is compiled in isolation and cannot reach an
 * ordinary import, so the shipped copy has to live inside the worklet body.
 * What is pinned here is therefore the *behaviour* — that the resting shape is
 * a plain capsule, that stretching conserves volume, and that the caps stay
 * semicircular — rather than the literal source.
 */
const SQUASH_SPAN = DOT * 3
const MAX_SQUASH = 0.3

function dropletShape(head: number, tail: number) {
  const a = Math.min(head, tail)
  const b = Math.max(head, tail)
  const span = b - a
  const t = Math.min(1, span / SQUASH_SPAN)
  const height = DOT * (1 - MAX_SQUASH * t)
  return { left: a - PILL_W / 2, width: PILL_W + span, height, radius: height / 2 }
}

test('at rest the droplet is an ordinary capsule', () => {
  // Head and tail coincide once the spring settles. If this were not exactly
  // PILL_W the marker would sit permanently stretched, which is the failure
  // that would make the effect look like a bug rather than like water.
  const s = dropletShape(100, 100)
  assert.equal(s.width, PILL_W)
  assert.equal(s.height, DOT)
  assert.equal(s.left, 100 - PILL_W / 2)
})

test('the droplet stretches to span the gap it is crossing', () => {
  // Mid-travel the body must reach from where it came from to where it is
  // going — that span *is* the animation, not a decoration on top of it.
  const s = dropletShape(160, 100)
  assert.equal(s.width, PILL_W + 60)
  assert.equal(s.left, 100 - PILL_W / 2)
})

test('the droplet stretches the same either way', () => {
  // Travelling right-to-left is the same shape as left-to-right; only the
  // anchor moves. Without the min/max a backwards swipe would produce a
  // negative width and the marker would vanish.
  const right = dropletShape(160, 100)
  const left = dropletShape(100, 160)
  assert.equal(right.width, left.width)
  assert.equal(right.left, left.left)
  assert.ok(right.width > 0)
})

test('stretching thins the droplet, but only so far', () => {
  // Volume is roughly conserved, so a longer body is a thinner one.
  const rest = dropletShape(0, 0)
  const mid = dropletShape(0, DOT)
  const far = dropletShape(0, DOT * 3)
  const absurd = dropletShape(0, 4000)

  assert.ok(mid.height < rest.height, 'stretching did not thin the drop')
  assert.ok(far.height < mid.height, 'thinning is not monotonic')

  // Capped: a drop that kept thinning across a fast flick would become a
  // hairline and read as a rendering artefact.
  assert.equal(absurd.height, far.height)
  assert.ok(absurd.height >= DOT * (1 - MAX_SQUASH) - 1e-9)
})

test('the caps stay exactly semicircular at every stretch', () => {
  // The whole reason width is animated rather than scaleX: a radius that is not
  // half the height turns the ends into flat-sided ellipses, which is what made
  // an earlier version look cheap.
  for (const span of [0, 1, DOT, DOT * 3, 500]) {
    const s = dropletShape(0, span)
    assert.equal(s.radius, s.height / 2, `radius drifted from half-height at span ${span}`)
  }
})
