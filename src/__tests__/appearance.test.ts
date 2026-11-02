import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  CLASSIC,
  DEFAULT_APPEARANCE,
  LOOKS,
  groupColorIndex,
  luminance,
  paletteTheme,
  resolveAppearance,
  sanitizeAppearance,
  type StoredAppearance,
} from '../looks/appearance.ts'
import { ON_GROUP, PALETTES, READING_PALETTES, READING_THEME_NAMES, THEME_NAMES } from '../looks/palettes.ts'

/**
 * TASKS3 L0: looks and colour themes are optional, and Classic — the app as it
 * was — must stay what everyone without Pro sees. The guard is one function,
 * `resolveAppearance`; these pin its rules, and that the stored choice survives
 * losing Pro so buying again restores it.
 */

const chose = (over: Partial<StoredAppearance>): StoredAppearance => ({ ...DEFAULT_APPEARANCE, ...over })

test('the default is Classic, Pro or not', () => {
  assert.equal(DEFAULT_APPEARANCE.look, 'classic')
  assert.equal(resolveAppearance(DEFAULT_APPEARANCE, false, true), CLASSIC)
  assert.equal(resolveAppearance(DEFAULT_APPEARANCE, true, true), CLASSIC)
})

test('without Pro every stored look resolves to Classic', () => {
  for (const look of LOOKS) {
    assert.equal(resolveAppearance(chose({ look, followSystem: false, theme: 'Paper' }), false, false), CLASSIC, look)
  }
})

test('losing Pro does not change what was stored', () => {
  // Resolution is read-only: the same stored object resolves to the choice again
  // as soon as Pro is back.
  const stored = chose({ look: 'notebook', followSystem: false, theme: 'Paper' })
  const snapshot = JSON.stringify(stored)
  assert.equal(resolveAppearance(stored, false, false), CLASSIC)
  assert.equal(JSON.stringify(stored), snapshot)
  assert.deepEqual(resolveAppearance(stored, true, false), { look: 'notebook', theme: 'Paper' })
})

test('with Pro, follow-system picks the light or dark theme', () => {
  const stored = chose({ look: 'modern', followSystem: true, lightTheme: 'Sepia', darkTheme: 'Forest' })
  assert.deepEqual(resolveAppearance(stored, true, false), { look: 'modern', theme: 'Sepia' })
  assert.deepEqual(resolveAppearance(stored, true, true), { look: 'modern', theme: 'Forest' })
})

test('with Pro and follow-system off, the fixed theme wins', () => {
  const stored = chose({ look: 'shelf', followSystem: false, theme: 'Ember', darkTheme: 'Midnight' })
  assert.deepEqual(resolveAppearance(stored, true, true), { look: 'shelf', theme: 'Ember' })
})

test('sanitize keeps valid fields and replaces only the invalid ones', () => {
  assert.deepEqual(sanitizeAppearance(null), DEFAULT_APPEARANCE)
  assert.deepEqual(sanitizeAppearance('nonsense'), DEFAULT_APPEARANCE)
  const s = sanitizeAppearance({ look: 'gothic', theme: 'Paper', followSystem: 'yes', darkTheme: 'Forest', readingFont: 'comic' })
  assert.equal(s.look, 'classic')
  assert.equal(s.theme, 'Paper')
  assert.equal(s.followSystem, DEFAULT_APPEARANCE.followSystem)
  assert.equal(s.darkTheme, 'Forest')
  assert.equal(s.readingFont, 'default')
})

const HEX = /^#[0-9a-f]{6}$/

test('every app palette defines every role as hex', () => {
  for (const name of THEME_NAMES) {
    const p = PALETTES[name]
    for (const [role, v] of Object.entries(p)) {
      if (role === 'groups') continue
      assert.match(v as string, HEX, `${name}.${role}`)
    }
    assert.equal(p.groups.length, 5, name)
    for (const g of p.groups) assert.match(g, HEX, `${name} group`)
    assert.match(ON_GROUP[name], HEX, `${name} onGroup`)
  }
})

test('every reading palette defines every role as hex', () => {
  for (const name of READING_THEME_NAMES) {
    for (const [role, v] of Object.entries(READING_PALETTES[name])) assert.match(v, HEX, `${name}.${role}`)
  }
})

test('text on each theme is readable: ink on bg is at least 7:1', () => {
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  for (const name of THEME_NAMES) {
    const p = PALETTES[name]
    assert.ok(ratio(p.ink, p.bg) >= 7, `${name} ink/bg ${ratio(p.ink, p.bg).toFixed(2)}`)
    assert.ok(ratio(p.ink2, p.bg) >= 4.5, `${name} ink2/bg ${ratio(p.ink2, p.bg).toFixed(2)}`)
  }
})

test('palette themes are built once and keep the Theme shape', () => {
  for (const name of THEME_NAMES) {
    const t = paletteTheme(name)
    assert.equal(paletteTheme(name), t, 'same object on every call')
    assert.equal(t.bg, PALETTES[name].bg)
    assert.equal(t.surfaceAlt, PALETTES[name].raised)
    assert.equal(t.border, PALETTES[name].line)
    assert.equal(t.navScrim.length, 4)
    assert.equal(t.ext.name, name)
  }
  assert.equal(paletteTheme('Midnight').dark, true)
  assert.equal(paletteTheme('Daylight').dark, false)
  assert.equal(paletteTheme('Paper').dark, false)
  assert.equal(paletteTheme('OLED').dark, true)
})

test('group colour is stable, in range, and spreads across ids', () => {
  assert.equal(groupColorIndex('abc123'), groupColorIndex('abc123'))
  const seen = new Set<number>()
  for (let i = 0; i < 200; i++) {
    const c = groupColorIndex(`group-${i}`)
    assert.ok(c >= 0 && c <= 4)
    seen.add(c)
  }
  assert.equal(seen.size, 5)
})
