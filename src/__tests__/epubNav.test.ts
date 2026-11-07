import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * An EPUB 3 book's chapter list comes from its nav document, and that document
 * is only read if phase 1 asks the archive for it.
 *
 * The phase-1 lookup was a regex whose `\b` word boundaries had been saved as
 * two literal backspace characters. It typechecked, read as `/nav/` in every
 * editor and diff, and matched nothing — so the nav was never decompressed and
 * every EPUB 3 book without an NCX fallback opened with no Chapters entry. A
 * second lookup further down, written correctly, found the nav item and then
 * looked for a file that had never been unzipped. Found on a device.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url))

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}

test('no source file contains control characters an editor would hide', () => {
  // Tab, newline and carriage return are the only control characters source
  // legitimately holds. Anything else is an escape that was written out raw.
  const hidden = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/
  const offenders = sourceFiles(SRC)
    .filter((path) => hidden.test(readFileSync(path, 'utf8')))
    .map((path) => path.slice(SRC.length))
  assert.deepEqual(offenders, [])
})

test('the nav document is found once, and that one lookup feeds both the unzip and the chapter list', () => {
  const epub = readFileSync(join(SRC, 'renderers/webview/epub.ts'), 'utf8')
  const lookups = epub.match(/const navItem\w* = /g) ?? []
  assert.equal(lookups.length, 1, 'two lookups can disagree — that is how the chapters went missing')
  assert.match(epub, /if \(navItem\) wanted\.add\(resolvePath\(opfPath, navItem\.href\)\)/, 'phase 1 unzips it')
  assert.match(epub, /if \(navItem\) \{\s*\n\s*const navPath = resolvePath\(opfPath, navItem\.href\)/, 'the chapter list reads it')
})

test('properties is matched as a space-separated list, not by substring', () => {
  const epub = readFileSync(join(SRC, 'renderers/webview/epub.ts'), 'utf8')
  const lookup = epub.match(/const navItem = (.*)/)?.[1] ?? ''
  assert.match(lookup, /props\.split\(\/\\s\+\/\)\.includes\('nav'\)/)

  // The same predicate, run: a nav item among others, with extra properties,
  // and a lookalike that must not match.
  const isNav = (props: string) => props.split(/\s+/).includes('nav')
  assert.equal(isNav('nav'), true)
  assert.equal(isNav('scripted nav'), true)
  assert.equal(isNav(''), false)
  assert.equal(isNav('navigation'), false)
})
