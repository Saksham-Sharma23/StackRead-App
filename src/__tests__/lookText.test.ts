import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { cleanTitle, positionLabel, textBar } from '../looks/text.ts'

/**
 * The looks show a cleaned title instead of the raw file name (critique item 2:
 * "02-install-jdk-and-t / ools.md" broke mid-word). Cleaning must never make a
 * name worse — these pin the cases that would.
 */

test('slugs lose their number, dashes and extension', () => {
  assert.equal(cleanTitle('01-prerequisites.md'), 'Prerequisites')
  assert.equal(cleanTitle('02-install-jdk-and-tools.md'), 'Install jdk and tools')
  assert.equal(cleanTitle('03_your_first_spring_app.md'), 'Your first spring app')
  assert.equal(cleanTitle('sql-execution-order.md'), 'Sql execution order')
})

test('names with spaces keep their punctuation and case', () => {
  assert.equal(cleanTitle('Results — draft 3.docx'), 'Results — draft 3')
  assert.equal(cleanTitle('Attention Is All You Need.pdf'), 'Attention Is All You Need')
  assert.equal(cleanTitle('01 - Prerequisites.md'), 'Prerequisites')
  assert.equal(cleanTitle('1. Intro to SQL.txt'), 'Intro to SQL')
})

test('mixed case is left alone', () => {
  assert.equal(cleanTitle('vaswani-2017.pdf'), 'Vaswani 2017')
  assert.equal(cleanTitle('JavaBasics.epub'), 'JavaBasics')
})

test('cleaning never leaves an empty title', () => {
  assert.equal(cleanTitle('01.md'), '01')
  assert.equal(cleanTitle('2024.pdf'), '2024')
  assert.equal(cleanTitle('notes'), 'Notes')
})

test('a four-digit year is a title, not a position', () => {
  assert.equal(cleanTitle('2024 report.pdf'), '2024 report')
  assert.equal(cleanTitle('2024-annual-review.pdf'), '2024 annual review')
})

test('positions are 1-based and padded to two digits', () => {
  assert.equal(positionLabel(0), '01')
  assert.equal(positionLabel(8), '09')
  assert.equal(positionLabel(105), '106')
})

test('text bars never misrepresent started or unfinished files', () => {
  assert.equal(textBar(0), '········')
  assert.equal(textBar(100), '████████')
  assert.equal(textBar(1), '█·······')
  assert.equal(textBar(99), '███████·')
  assert.equal(textBar(50), '████····')
  assert.equal(textBar(250), '████████')
})
