import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { sanitizeHtml } from '../renderers/webview/sanitize.ts'
import { buildViewerHtml } from '../renderers/webview/viewerHtml.ts'
import { parseViewerMessage, MAX_MESSAGE_CHARS } from '../renderers/webview/viewerMessage.ts'
import { isSafeStoredName, validateLibrary, InvalidBackupError } from '../storage/validateLibrary.ts'
import { scrubPaths } from '../ui/scrub.ts'

/*
 * AUDIT4 D1–D7. Every pure piece runs for real; the rest is pinned from source
 * because it imports modules Node cannot load.
 */

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

const THEME = {
  bg: '#000', fg: '#fff', fgDim: '#888', accent: '#09f',
  border: '#333', surfaceAlt: '#111', surface: '#222', gutter: '#0a0a0a',
}

/* ==================== D1: attribute separators ==================== */

test('D1: handlers separated by "/" instead of whitespace are removed', () => {
  const vectors: [string, string][] = [
    ['<svg/onload=alert(1)>', '<svg>'],
    ['<details/open/ontoggle=alert(1)>x</details>', '<details open>x</details>'],
    ['<img src="x"/onerror=alert(1)>', '<img src="x">'],
    ['<audio src="x"//onerror="alert(1)">', '<audio src="x">'],
    ['<p\tONCLICK=x>t</p>', '<p>t</p>'],
    ['<g ev:onload="x">', '<g>'],
  ]
  for (const [input, expected] of vectors) {
    assert.equal(sanitizeHtml(input), expected, input)
  }
})

test('D1: executable URLs and inline styles go, however they are padded', () => {
  assert.equal(sanitizeHtml('<a xlink:href="java&#09;script:alert(1)">s</a>'), '<a>s</a>')
  assert.equal(sanitizeHtml('<a href=javascript:alert(1)>s</a>'), '<a>s</a>')
  assert.equal(sanitizeHtml('<div style="background:url(https://x)">d</div>'), '<div>d</div>')
})

test('D1: ordinary markup survives — including what a [\\s/] regex would have broken', () => {
  // A "/on…=" inside a quoted URL is part of the value, not an attribute.
  const url = '<a href="https://example.com/onboarding=1">link</a>'
  assert.equal(sanitizeHtml(url), url)
  // A ">" inside a quoted value does not end the tag.
  const title = '<abbr title="a > b">x</abbr>'
  assert.equal(sanitizeHtml(title), title)
  // Text that merely contains "<" is untouched.
  assert.equal(sanitizeHtml('a < b and <3 </p>'), 'a < b and <3 </p>')
  // Self-closing tags and EPUB image tokens keep their meaning.
  assert.equal(sanitizeHtml('<br/><img data-sr-img="sr-img-0" alt="">'), '<br /><img data-sr-img="sr-img-0" alt="">')
  // Values are re-quoted, with embedded quotes escaped — the same value to a browser.
  assert.equal(sanitizeHtml(`<p data-x='say "hi"'>t</p>`), '<p data-x="say &quot;hi&quot;">t</p>')
})

test('D1: a tag left unterminated at the end is dropped, as the browser would', () => {
  assert.equal(sanitizeHtml('safe<img src=x onerror=alert(1)'), 'safe')
})

test('D1: streamed batches go through the viewer sanitiser too', () => {
  const html = buildViewerHtml(THEME, 0)
  assert.ok(html.includes("el.insertAdjacentHTML('beforeend', sanitize(html));"))
  assert.doesNotMatch(html, /insertAdjacentHTML\('beforeend', html\)/)
})

/* ==================== D3: Content-Security-Policy ==================== */

function csp(html: string): string {
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)
  assert.ok(m, 'the viewer must declare a CSP')
  return m[1]
}

test('D3: the viewer loads nothing from anywhere, and runs only its own script', () => {
  const html = buildViewerHtml(THEME, 0)
  const policy = csp(html)
  assert.ok(policy.includes("default-src 'none'"), 'no network, no files by default')
  assert.ok(/img-src blob: data:;/.test(policy), 'images only from blob:/data:')
  assert.doesNotMatch(policy, /https?:/, 'no remote origin may be allowed')

  const scriptSrc = /script-src ([^;]+);/.exec(policy)?.[1] ?? ''
  assert.doesNotMatch(scriptSrc, /unsafe-inline/, 'inline handlers in content must not run')
  const nonce = /'nonce-([a-z0-9]+)'/.exec(scriptSrc)?.[1]
  assert.ok(nonce && nonce.length >= 16, 'a nonce of real length')
  assert.ok(html.includes(`<script nonce="${nonce}">`), "the program carries the policy's nonce")

  // The CSP must come before any script, or it does not apply to it.
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'))
})

test('D3: the nonce is fresh per document', () => {
  const a = /'nonce-([a-z0-9]+)'/.exec(csp(buildViewerHtml(THEME, 0)))?.[1]
  const b = /'nonce-([a-z0-9]+)'/.exec(csp(buildViewerHtml(THEME, 0)))?.[1]
  assert.notEqual(a, b)
})

test('D3: an inlined payload cannot borrow the nonce', () => {
  const html = buildViewerHtml(THEME, 0, false, {
    format: 'html', content: '<script>alert(1)</script>', mode: 'paper', totalPages: 1,
  })
  // The island is a data block, and its content cannot close it.
  assert.equal(html.match(/<script nonce=/g)?.length, 1, 'exactly one script may carry the nonce')
})

/* ==================== D2: restored index validation ==================== */

function goodLibrary(): Record<string, unknown> {
  return {
    groups: [{ id: 'g1', title: 'Thesis', order: 0 }],
    files: [
      {
        id: 'abc123DEF_-x', name: 'paper.pdf', storedName: 'abc123DEF_-x.pdf', format: 'pdf',
        groupId: 'g1', orderInGroup: 0, addedAt: 1, lastScroll: 3, lastProgress: 40,
        thumb: 'abc123DEF_-x.thumb.jpg', thumbhash: 'xyz', size: 1000,
      },
    ],
  }
}

function withFile(patch: Record<string, unknown>): unknown {
  const lib = goodLibrary() as { groups: unknown[]; files: Record<string, unknown>[] }
  lib.files[0] = { ...lib.files[0], ...patch }
  return lib
}

test('D2: a well-formed index passes, carrying only known fields', () => {
  const lib = validateLibrary({ ...goodLibrary(), extra: 'ignored' })
  assert.equal(lib.files.length, 1)
  assert.equal(lib.files[0].storedName, 'abc123DEF_-x.pdf')
  const polluted = validateLibrary(withFile({ evil: true, __proto__: { x: 1 } }))
  assert.equal('evil' in polluted.files[0], false, 'unknown fields must not ride along')
})

test('D2: stored names that would escape the library are rejected', () => {
  for (const storedName of [
    '../../databases/stackread.db', '..', 'a/b.pdf', 'a\\b.pdf', '.hidden', 'x..y.pdf', '', 'a'.repeat(300), 42,
  ]) {
    assert.throws(() => validateLibrary(withFile({ storedName })), InvalidBackupError, String(storedName))
  }
  assert.throws(() => validateLibrary(withFile({ thumb: '../x.jpg' })), InvalidBackupError)
})

test('D2: ids, formats and numbers are checked', () => {
  const bad: Record<string, unknown>[] = [
    { id: 'has space' }, { id: '' }, { id: 7 },
    { format: 'constructor' }, { format: 'exe' }, { format: undefined },
    { lastScroll: Number.NaN }, { lastProgress: Infinity }, { orderInGroup: '1' }, { addedAt: null },
    { size: -1 }, { name: '' }, { groupId: 'missing' },
  ]
  for (const patch of bad) {
    assert.throws(() => validateLibrary(withFile(patch)), InvalidBackupError, JSON.stringify(patch))
  }
})

test('D2: duplicates and non-libraries are rejected; progress is clamped', () => {
  const dup = goodLibrary() as { files: Record<string, unknown>[] }
  dup.files.push({ ...dup.files[0] })
  assert.throws(() => validateLibrary(dup), InvalidBackupError)
  for (const raw of [null, [], 'x', { groups: {}, files: [] }, { groups: [] }]) {
    assert.throws(() => validateLibrary(raw), InvalidBackupError)
  }
  assert.equal(validateLibrary(withFile({ lastProgress: 140 })).files[0].lastProgress, 100)
})

test('D2: archive entry names and index names share one rule', () => {
  assert.equal(isSafeStoredName('abc.pdf'), true)
  assert.equal(isSafeStoredName('abc.thumb.jpg'), true)
  const backup = source('storage/backup.ts')
  assert.ok(backup.includes('if (!isSafeStoredName(name)) return'), 'archive entries use the shared check')
  assert.ok(backup.includes('library = validateLibrary(parsed)'), 'the index is validated before use')
})

/* ==================== D4: restore limits ==================== */

test('D4: restored entries are written in chunks and bounded by free space', () => {
  const backup = source('storage/backup.ts')
  const unpack = backup.slice(backup.indexOf('async function unpackArchive'), backup.indexOf('function commitStagedFiles'))

  const staged = unpack.slice(unpack.indexOf('const target = new File(RESTORE_STAGING_DIR, name)'))
  assert.ok(staged.includes('handle.writeBytes(chunk)'), 'each chunk goes straight to disk')
  assert.doesNotMatch(staged.slice(0, staged.indexOf('entry.start()')), /concat\(parts\)/, 'no staged entry is buffered whole')
  assert.ok(/stagedBytes > diskBudget/.test(unpack), 'the running total is checked against free space')
  assert.ok(/if \(diskBudget < \(archive\.size \?\? 0\)\)/.test(unpack), 'and the archive size up front')
  assert.ok(/entryCount > MAX_ARCHIVE_ENTRIES/.test(unpack))
  assert.ok(/indexBytes > MAX_INDEX_BYTES/.test(unpack), 'the in-memory index is capped')
  assert.ok(/if \(failed instanceof RestoreLimitError\) throw failed/.test(unpack), 'limits are reported as such')
})

/* ==================== D5: viewer messages ==================== */

test('D5: non-finite numbers never reach the host', () => {
  const m = parseViewerMessage(JSON.stringify({ type: 'pos', scrollY: 'NaN', percent: null }))
  assert.ok(m)
  assert.equal(m.scrollY, undefined)
  assert.equal(m.percent, undefined)
  // JSON cannot carry NaN, but a huge exponent parses to Infinity.
  const inf = parseViewerMessage('{"type":"pos","scrollY":1e400,"offset":-1e400}')
  assert.equal(inf?.scrollY, undefined)
  assert.equal(inf?.offset, undefined)
})

test('D5: numbers are clamped to sane ranges', () => {
  const m = parseViewerMessage(JSON.stringify({ type: 'pos', percent: 250, scrollY: -40, scale: 999, current: 3, total: 9 }))
  assert.deepEqual(
    { percent: m?.percent, scrollY: m?.scrollY, scale: m?.scale, current: m?.current, total: m?.total },
    { percent: 100, scrollY: 0, scale: 20, current: 3, total: 9 },
  )
})

test('D5: strings are capped, oversized and malformed messages dropped', () => {
  const m = parseViewerMessage(JSON.stringify({ type: 'error', message: 'x'.repeat(5000), label: 'y'.repeat(100) }))
  assert.equal(m?.message?.length, 300)
  assert.equal(m?.label?.length, 32)
  assert.equal(parseViewerMessage('x'.repeat(MAX_MESSAGE_CHARS + 1)), null)
  for (const raw of ['not json', 'null', '42', '{}', '{"type":5}', 7]) {
    assert.equal(parseViewerMessage(raw), null, String(raw))
  }
})

test('D5: the renderer reads messages only through the parser', () => {
  const renderer = source('renderers/WebViewRenderer.tsx')
  assert.ok(renderer.includes('const msg = parseViewerMessage(e.nativeEvent.data)'))
  assert.doesNotMatch(renderer, /JSON\.parse\(e\.nativeEvent\.data\)/)
})

/* ==================== D6: no names in logs ==================== */

test('D6: file paths and URIs are scrubbed from error text', () => {
  const msg =
    'Unable to copy file:///data/user/0/com.stackread.app/cache/DocumentPicker/My%20Diary.pdf to /data/user/0/com.stackread.app/files/library/x.pdf'
  const out = scrubPaths(msg)
  assert.doesNotMatch(out, /Diary/)
  assert.doesNotMatch(out, /\/data\//)
  assert.equal(out, 'Unable to copy <uri> to <path>')
  assert.equal(scrubPaths('nothing to see'), 'nothing to see')
})

test('D6: import and delete failures log ids and extensions, never names', () => {
  const files = source('storage/files.ts')
  // `extensionOf(asset.name)` is fine — only the extension reaches the log.
  assert.doesNotMatch(files, /\$\{asset\.name\}/, 'the original filename must not be logged')
  assert.doesNotMatch(files, /console\.\w+\([^)]*,\s*asset\.name\s*[,)]/, 'nor passed as a log argument')
  assert.doesNotMatch(files, /console\.\w+\(`[^`]*\$\{entry\.storedName\}/, 'nor a stored name')
  assert.ok(files.includes('__DEV__ ? err : undefined'), 'error objects (which carry paths) are development-only')

  const log = source('ui/crashLog.ts')
  assert.ok(/message: scrubPaths\(e\.message\)/.test(log) && /stack: scrubPaths\(/.test(log))
})

/* ==================== D7: the import guard ==================== */

test('D7: copyIntoLibrary refuses an unknown extension before building a path', () => {
  const files = source('storage/files.ts')
  const fn = files.slice(files.indexOf('export function copyIntoLibrary'))
  const guard = fn.indexOf('if (!isKnownExtension(originalName))')
  const path = fn.indexOf('storedFile(id, ext)')
  assert.ok(guard > 0 && path > guard, 'the guard must come before the path is built')
})
