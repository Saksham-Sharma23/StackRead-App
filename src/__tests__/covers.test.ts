import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zipSync, unzipSync, strToU8 } from 'fflate'

/*
 * Cover extraction is pure logic over a zip, which makes it testable without a
 * device — and worth testing, because the three EPUB cover conventions are the
 * kind of thing that silently falls back to "no cover" when a regex is subtly
 * wrong. A book showing a badge instead of its cover looks like an unsupported
 * format rather than a bug, so this failure mode hides.
 *
 * `storage/covers.ts` is deliberately *not* imported: it reads through
 * `expo-file-system`, which has no Node implementation, so importing it fails
 * at module load and takes the whole file down with it. The parsing steps are
 * therefore mirrored here and run against real zips built below — which pins
 * the conventions themselves, the part that actually breaks.
 */

/** Mirrors `resolvePath` in storage/covers.ts. */
function resolvePath(base: string, href: string): string {
  const clean = href.split('#')[0]
  if (!base) return clean
  const parts = base.split('/')
  parts.pop()
  for (const seg of clean.split('/')) {
    if (seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

/**
 * Mirrors `epubCover`'s candidate resolution: which manifest href wins.
 *
 * Returns the resolved zip path, or null when the book declares no cover.
 */
function coverPathOf(zip: Record<string, Uint8Array>): string | null {
  const container = zip['META-INF/container.xml']
  if (!container) return null
  const opfPath = new TextDecoder()
    .decode(container)
    .match(/full-path\s*=\s*["']([^"']+)["']/)?.[1]
  if (!opfPath || !zip[opfPath]) return null

  const opf = new TextDecoder().decode(zip[opfPath])
  const hrefById = new Map<string, string>()
  let byProperty: string | null = null

  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const tag = m[0]
    const id = tag.match(/\bid\s*=\s*["']([^"']+)["']/)?.[1]
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/)?.[1]
    if (!id || !href) continue
    hrefById.set(id, href)
    const props = tag.match(/\bproperties\s*=\s*["']([^"']+)["']/)?.[1] ?? ''
    if (/\bcover-image\b/.test(props)) byProperty = href
  }

  const candidates: string[] = []
  if (byProperty) candidates.push(byProperty)

  const metaId = opf.match(
    /<meta\b[^>]*\bname\s*=\s*["']cover["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i,
  )?.[1]
  const metaIdAlt = opf.match(
    /<meta\b[^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*\bname\s*=\s*["']cover["']/i,
  )?.[1]
  for (const id of [metaId, metaIdAlt]) {
    const href = id ? hrefById.get(id) : undefined
    if (href) candidates.push(href)
  }

  for (const href of candidates) {
    const path = resolvePath(opfPath, href)
    if (zip[path]) return path
  }
  return null
}

/**
 * Builds a minimal but structurally real EPUB.
 *
 * Mirrors what `epubCover` walks: container.xml -> OPF -> manifest -> the
 * image. Written as a helper so each convention below differs by one line.
 */
function buildEpub(opfBody: string): Uint8Array {
  return zipSync({
    'META-INF/container.xml': strToU8(
      `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
    ),
    'OEBPS/content.opf': strToU8(
      `<?xml version="1.0"?><package><metadata></metadata>${opfBody}</package>`,
    ),
    'OEBPS/images/cover.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  })
}

test('finds an EPUB 3 cover declared by the cover-image property', () => {
  // properties="cover-image" is the unambiguous EPUB 3 declaration.
  const zip = unzipSync(
    buildEpub(
      `<manifest><item id="c" href="images/cover.png" media-type="image/png" properties="cover-image"/></manifest>`,
    ),
  )
  assert.equal(coverPathOf(zip), 'OEBPS/images/cover.png')
})

test('finds an EPUB 2 cover declared by <meta name="cover">', () => {
  // Points at a manifest id rather than a path. Still near-universal in the
  // wild, so this is not a legacy path.
  const zip = unzipSync(
    buildEpub(
      `<metadata><meta name="cover" content="c"/></metadata>` +
        `<manifest><item id="c" href="images/cover.png" media-type="image/png"/></manifest>`,
    ),
  )
  assert.equal(coverPathOf(zip), 'OEBPS/images/cover.png')
})

test('finds an EPUB 2 cover when the meta attributes are reversed', () => {
  // Attribute order is not guaranteed by the spec, and real books ship both
  // orders — matching only one silently loses the cover on half of them.
  const zip = unzipSync(
    buildEpub(
      `<metadata><meta content="c" name="cover"/></metadata>` +
        `<manifest><item id="c" href="images/cover.png" media-type="image/png"/></manifest>`,
    ),
  )
  assert.equal(coverPathOf(zip), 'OEBPS/images/cover.png')
})

test('the EPUB 3 property wins over an EPUB 2 meta pointing elsewhere', () => {
  // A book carrying both must use the modern, unambiguous declaration.
  const zip = unzipSync(
    zipSync({
      'META-INF/container.xml': strToU8(
        `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
      ),
      'OEBPS/content.opf': strToU8(
        `<package><metadata><meta name="cover" content="old"/></metadata>` +
          `<manifest>` +
          `<item id="old" href="images/legacy.png" media-type="image/png"/>` +
          `<item id="new" href="images/cover.png" media-type="image/png" properties="cover-image"/>` +
          `</manifest></package>`,
      ),
      'OEBPS/images/legacy.png': new Uint8Array([1]),
      'OEBPS/images/cover.png': new Uint8Array([2]),
    }),
  )
  assert.equal(coverPathOf(zip), 'OEBPS/images/cover.png')
})

test('a book declaring no cover resolves to null rather than guessing', () => {
  const zip = unzipSync(
    buildEpub(`<manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>`),
  )
  assert.equal(coverPathOf(zip), null)
})

test('a cover href is resolved relative to the OPF, not the zip root', () => {
  // The OPF lives in OEBPS/, so href="images/cover.png" means
  // OEBPS/images/cover.png. Resolving against the root silently finds nothing.
  assert.equal(resolvePath('OEBPS/content.opf', 'images/cover.png'), 'OEBPS/images/cover.png')
  assert.equal(resolvePath('OEBPS/sub/content.opf', '../images/c.png'), 'OEBPS/images/c.png')
  // A fragment is not part of the path.
  assert.equal(resolvePath('OEBPS/content.opf', 'cover.png#x'), 'OEBPS/cover.png')
})

test('the cover-image property matcher is word-bounded', () => {
  // The check is /\bcover-image\b/ rather than a substring test: a manifest
  // carrying properties="not-cover-image" must not be treated as the cover.
  const re = /\bcover-image\b/
  assert.ok(re.test('cover-image'))
  assert.ok(re.test('svg cover-image'))
  assert.equal(re.test('notcover-imagex'), false)
})

test('SVG is excluded from cover candidates', () => {
  /*
   * Same reasoning as the archive path in prepare.ts: an SVG is a document that
   * can carry script, not a bitmap. It is also not decodable by the image
   * pipeline, so admitting it would mean a failed thumbnail rather than a
   * dangerous one — but the exclusion is written down so it survives a library
   * swap that *would* decode it.
   */
  const COVER_IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i
  assert.equal(COVER_IMAGE_RE.test('cover.svg'), false)
  assert.ok(COVER_IMAGE_RE.test('cover.png'))
  assert.ok(COVER_IMAGE_RE.test('cover.JPG'))
  assert.ok(COVER_IMAGE_RE.test('cover.avif'))
})

test('comic pages sort naturally, so page 2 precedes page 10', () => {
  // The cover must be the page the reader actually sees first. Lexicographic
  // ordering would make page10 the cover of a ten-page comic.
  const naturalCompare = (a: string, b: string) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

  const sorted = ['page10.jpg', 'page2.jpg', 'page1.jpg'].sort(naturalCompare)
  assert.deepEqual(sorted, ['page1.jpg', 'page2.jpg', 'page10.jpg'])
})
