import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  SAME_POSITION,
  formatPdfPosition,
  parsePdfPosition,
  restorablePdfOffset,
  samePdfPosition,
} from '../renderers/pdfPosition.ts'

/*
 * Reopening a PDF mid-document, instantly.
 *
 * The reader used to restore a page number, which lands on the top of the
 * page, so no picture of where the reader stopped could match where the view
 * landed — a reopen anywhere but page 1 showed the blurred cover for as long
 * as pdfium took to open the file. Now the exact position is restored (a
 * patched native prop), and the frame at that position is kept as the resume
 * frame.
 */

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

const AT = { page: 12, offset: 0.4378, width: 1080, height: 2400 }

test('the exact position is restored only when it agrees with the page and the window', () => {
  assert.equal(restorablePdfOffset(AT, 12, 1080, 2400), 0.4378)
  // Fractional window sizes are rounded, as they are when stored.
  assert.equal(restorablePdfOffset(AT, 12, 1080.4, 2399.6), 0.4378)

  assert.equal(restorablePdfOffset(null, 12, 1080, 2400), null, 'nothing stored')
  assert.equal(restorablePdfOffset(AT, 13, 1080, 2400), null, 'a kill between the page and position writes')
  assert.equal(restorablePdfOffset(AT, 12, 2400, 1080), null, 'rotated: the same fraction is another spot')
  assert.equal(restorablePdfOffset({ ...AT, offset: 0 }, 12, 1080, 2400), null, 'the top is where page 1 lands')
  assert.equal(restorablePdfOffset({ ...AT, offset: 1.5 }, 12, 1080, 2400), null, 'out of range')
})

test('a position survives storage exactly, and junk does not parse', () => {
  const back = parsePdfPosition(formatPdfPosition(AT))
  assert.deepEqual(back, AT)
  assert.equal(parsePdfPosition(undefined), null)
  assert.equal(parsePdfPosition(''), null)
  assert.equal(parsePdfPosition('12|abc|1080|2400'), null)
  assert.equal(parsePdfPosition('12|0.5|1080'), null)
})

test('the float round trip of a restore is not a move', () => {
  // setPositionOffset, then getPositionOffset, crosses float32 twice.
  const f32 = Math.fround(AT.offset)
  assert.ok(samePdfPosition(AT, { ...AT, offset: f32 }))
  assert.ok(!samePdfPosition(AT, { ...AT, offset: AT.offset + SAME_POSITION * 2 }))
  assert.ok(!samePdfPosition(AT, { ...AT, page: 13 }))
  assert.ok(!samePdfPosition(null, AT))
})

test('the native view takes the position once and reports it after scrolling settles', () => {
  const patch = source('../patches/react-native-pdf+7.0.5.patch')
  // Fabric: a prop must be in the codegen spec, or the view config drops it.
  assert.ok(/\+\s*initialPositionOffset: \?Double,/.test(patch), 'declared in the native component spec')
  assert.ok(patch.includes('@ReactProp(name = "initialPositionOffset")'))
  // Applied once, after the base class's own jump to defaultPage.
  assert.ok(/this\.initialPositionOffset = -1;\s*\n\+\s*this\.post\(\(\) -> \{\s*\n\+\s*this\.setPositionOffset\(offset, false\);/.test(patch))
  // Debounced, and cancelled when the view leaves the window.
  assert.ok(patch.includes('this.postDelayed(this.positionReporter, POSITION_SETTLE_MS);'))
  assert.ok(/onDetachedFromWindow\(\) \{\n\+\s*this\.removeCallbacks\(this\.positionReporter\);/.test(patch))
  assert.ok(patch.includes("message[0] === 'positionChanged'"), 'routed to a JS callback')
})

test('the reader shows a picture only of where it is about to land', () => {
  const reader = source('renderers/PdfRenderer.tsx')
  const choose = reader.slice(reader.indexOf('const [previewUri] = useState'), reader.indexOf('const previewSource'))
  assert.ok(choose.includes('if (initialOffset !== null)'))
  assert.ok(choose.includes('existingResumePreview(file.id, frameAtMount.width, frameAtMount.height, initialOffset)'))
  // Page 1's frame is the top of page 1, so not for an open inside page 1.
  assert.ok(/initialPage !== 1 \|\| initialOffset !== null\) return/.test(reader))
})

test('the resume frame is captured while reading, never mid-animation or zoomed', () => {
  const reader = source('renderers/PdfRenderer.tsx')
  const handler = reader.slice(reader.indexOf('const handlePositionChanged'), reader.indexOf('const source = useMemo'))
  assert.ok(handler.includes('if (!activeRef.current || !loaded.current) return'), 'neighbours write nothing')
  assert.ok(handler.includes('samePdfPosition(lastPosition.current, position)'))
  assert.ok(/Math\.abs\(zoom - 1\) > 0\.01\) return/.test(handler), 'a zoomed frame can never match a restore')
  assert.ok(handler.includes('RESUME_IDLE_MS'))

  const capture = reader.slice(reader.indexOf('const captureResumeFrame'), reader.indexOf('const handlePositionChanged'))
  assert.ok(capture.includes('!previewGoneRef.current'), 'never a photo of the preview itself')
  assert.ok(capture.includes('discardCapture(shot)'), 'a frame taken while moving is dropped')

  // Like `page`, the restore is the initial value only: a prop change is a reload.
  assert.ok(reader.includes('initialPositionOffset={restoreOffsetProp}'))
  assert.ok(/const initialOffset = useRef\(/.test(reader))
})

test('one resume frame per file and window, cleared with the file', () => {
  const store = source('storage/pdfPreview.ts')
  const save = store.slice(store.indexOf('export function saveResumePreview'), store.indexOf('export function discardCapture'))
  assert.ok(save.includes('item.name.startsWith(prefix)') && save.includes('item.delete()'), 'the older frame is replaced')
  assert.ok(save.includes('finally'), 'the capture is always consumed')
  // forgetPreviews matches by the file id prefix, which covers both kinds.
  assert.ok(store.includes('item.name.startsWith(`${fileId}.`)'))

  const scroll = source('store/scroll.ts')
  const forget = scroll.slice(scroll.indexOf('export function forgetFile'), scroll.indexOf('export function forgetAllScroll'))
  assert.ok(forget.includes('pdfPositionKey(fileId)'), 'the stored position dies with the file id')
})
