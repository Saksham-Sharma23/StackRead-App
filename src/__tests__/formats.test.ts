import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  extensionOf,
  formatOf,
  isKnownExtension,
  isRenderable,
  badgeOf,
  PICKER_MIME_TYPES,
  SUPPORTED_EXTENSIONS,
  formatBytes,
} from '../storage/formats.ts'

/*
 * The format table is the single place that decides what the app will open and
 * which renderer family gets it. Adding a format is meant to be one entry here
 * plus one function in prepare.ts, so a regression in this lookup silently
 * changes which files import at all.
 */

test('extension is taken from the last dot, lowercased', () => {
  assert.equal(extensionOf('book.EPUB'), 'epub')
  assert.equal(extensionOf('my.notes.v2.md'), 'md')
})

test('a dotfile is not an extension', () => {
  // `.gitignore` is a name, not a file of type "gitignore" — treating it as an
  // extension would let unopenable files into the picker.
  assert.equal(extensionOf('.gitignore'), '')
})

test('a trailing dot yields no extension', () => {
  assert.equal(extensionOf('weird.'), '')
})

test('a name with no dot yields no extension', () => {
  assert.equal(extensionOf('README'), '')
})

test('unknown extensions fall back rather than throwing', () => {
  // Import must degrade to "unsupported", never crash the picker.
  assert.equal(isKnownExtension('thing.qqq'), false)
  assert.equal(isRenderable('thing.qqq'), false)
  assert.ok(badgeOf('thing.qqq').label)
})

test('known extensions are recognised, renderable or not', () => {
  // SUPPORTED_EXTENSIONS is every extension the table *knows*, which is not the
  // same as every extension it can render: TIFF is listed deliberately as
  // known-but-unsupported so an import of one is rejected with a real format
  // name and badge rather than falling through as an unrecognised file.
  for (const ext of SUPPORTED_EXTENSIONS) {
    assert.equal(isKnownExtension(`file.${ext}`), true, `${ext} is listed but unknown`)
  }
})

test('at least one extension is deliberately known but not renderable', () => {
  // Pins the distinction above: if this ever becomes empty, the two concepts
  // have silently merged and `isRenderable` has stopped meaning anything.
  const unrenderable = SUPPORTED_EXTENSIONS.filter((ext) => !isRenderable(`file.${ext}`))
  assert.ok(unrenderable.length > 0)
})

test('every format maps to a renderer family', () => {
  for (const ext of SUPPORTED_EXTENSIONS) {
    assert.ok(formatOf(`file.${ext}`), `${ext} has no format`)
  }
})

test('the known formats route to the expected family', () => {
  assert.equal(formatOf('a.pdf'), 'pdf')
  assert.equal(formatOf('a.epub'), 'epub')
  assert.equal(formatOf('a.png'), 'image')
  assert.equal(formatOf('a.md'), 'markdown')
})

test('picker MIME types are deduplicated and non-empty', () => {
  assert.ok(PICKER_MIME_TYPES.length > 0)
  assert.equal(new Set(PICKER_MIME_TYPES).size, PICKER_MIME_TYPES.length)
})

test('every format carries a badge, since most files have no thumbnail', () => {
  // Thumbnails exist only for images, so the badge is the card for everything
  // else — a missing one is a blank card.
  for (const ext of SUPPORTED_EXTENSIONS) {
    const badge = badgeOf(`file.${ext}`)
    assert.ok(badge.label, `${ext} has no badge label`)
    assert.match(badge.color, /^#/, `${ext} has no badge colour`)
  }
})

test('byte sizes use binary units, matching the system file manager', () => {
  // Decimal units would report 1.05 MB where Android says 1.00 MB, which reads
  // as an app bug rather than a units disagreement.
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1024 * 1024), '1.0 MB')
  assert.equal(formatBytes(1024 * 1024 * 1024), '1.0 GB')
})

test('bytes below a kilobyte are shown as bytes', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(999), '999 B')
})

test('precision drops once the number is wide', () => {
  // "1.4 MB" is useful; "147.3 MB" is false precision on a cramped row.
  assert.equal(formatBytes(Math.round(1.4 * 1024 * 1024)), '1.4 MB')
  assert.equal(formatBytes(Math.round(147.3 * 1024 * 1024)), '147 MB')
})

test('a missing or nonsensical size renders as nothing, not NaN', () => {
  // The row simply shows no size rather than a broken one.
  assert.equal(formatBytes(undefined), '')
  assert.equal(formatBytes(Number.NaN), '')
  assert.equal(formatBytes(-1), '')
})
