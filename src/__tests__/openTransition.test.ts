import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { openFromRect, rectIsUsable, type OpenRect } from '../ui/openTransition.ts'

/**
 * Geometry for the reader's open/close transition.
 *
 * Worth testing off-device for one specific reason: the failure mode is not a
 * crash, it is an animation that aims at slightly the wrong place. That is
 * invisible in a screenshot, hard to judge by eye at 460ms, and exactly the kind
 * of arithmetic that is wrong-but-plausible — a transition computed from corners
 * rather than centres is off by half the size difference, which still *looks*
 * like an animation.
 */

const SCREEN_W = 400
const SCREEN_H = 800

test('a card at the screen centre needs no translation', () => {
  // 100x100 centred: its centre is the screen's centre, so only scale applies.
  const rect: OpenRect = { x: 150, y: 350, width: 100, height: 100 }
  const from = openFromRect(rect, SCREEN_W, SCREEN_H)

  assert.equal(from.translateX, 0)
  assert.equal(from.translateY, 0)
  assert.equal(from.scale, 0.25)
})

test('translation is measured between centres, not corners', () => {
  // A card at the origin. Its centre is (50, 50); the screen's is (200, 400).
  // Corner-based maths would give -0 / -0 here and be wrong by half the card.
  const rect: OpenRect = { x: 0, y: 0, width: 100, height: 100 }
  const from = openFromRect(rect, SCREEN_W, SCREEN_H)

  assert.equal(from.translateX, 50 - 200)
  assert.equal(from.translateY, 50 - 400)
})

test('scale comes from width alone, so the reader is never squashed', () => {
  // A 3:4 card on a 1:2 screen. Honouring both axes would give different
  // scales and distort the page mid-flight.
  const rect: OpenRect = { x: 0, y: 0, width: 132, height: 176 }
  const from = openFromRect(rect, SCREEN_W, SCREEN_H)

  assert.equal(from.scale, 132 / SCREEN_W)
})

test('a card below the fold still translates positively', () => {
  const rect: OpenRect = { x: 150, y: 700, width: 100, height: 100 }
  const from = openFromRect(rect, SCREEN_W, SCREEN_H)

  assert.ok(from.translateY > 0, 'a card low on screen must pull the reader down')
})

test('a usable rect is one that is still on screen', () => {
  const rect: OpenRect = { x: 10, y: 10, width: 132, height: 176 }
  assert.equal(rectIsUsable(rect, SCREEN_W, SCREEN_H), true)
})

test('null is never usable', () => {
  assert.equal(rectIsUsable(null, SCREEN_W, SCREEN_H), false)
})

test('a zero-sized rect is rejected rather than dividing by nothing', () => {
  assert.equal(rectIsUsable({ x: 0, y: 0, width: 0, height: 100 }, SCREEN_W, SCREEN_H), false)
  assert.equal(rectIsUsable({ x: 0, y: 0, width: 100, height: 0 }, SCREEN_W, SCREEN_H), false)
})

test('a card scrolled off either horizontal edge is rejected', () => {
  // Row scrolled right: the card sits entirely left of the viewport.
  assert.equal(rectIsUsable({ x: -200, y: 100, width: 132, height: 176 }, SCREEN_W, SCREEN_H), false)
  // Row scrolled left: entirely past the right edge.
  assert.equal(rectIsUsable({ x: 400, y: 100, width: 132, height: 176 }, SCREEN_W, SCREEN_H), false)
})

test('a card scrolled off either vertical edge is rejected', () => {
  assert.equal(rectIsUsable({ x: 10, y: -300, width: 132, height: 176 }, SCREEN_W, SCREEN_H), false)
  assert.equal(rectIsUsable({ x: 10, y: 800, width: 132, height: 176 }, SCREEN_W, SCREEN_H), false)
})

test('a partially visible card is still worth animating to', () => {
  // Half off the top edge. The animation aims slightly off screen, which reads
  // correctly — the card really is half off screen.
  assert.equal(rectIsUsable({ x: 10, y: -80, width: 132, height: 176 }, SCREEN_W, SCREEN_H), true)
})

test('a rect wider than the screen is a stale-orientation measurement', () => {
  // Captured in landscape, read in portrait. The numbers describe a layout that
  // no longer exists, so folding back to them would aim at nothing.
  assert.equal(rectIsUsable({ x: 0, y: 100, width: 900, height: 176 }, SCREEN_W, SCREEN_H), false)
})
