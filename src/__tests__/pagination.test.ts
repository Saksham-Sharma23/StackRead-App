import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CHARS_PER_PAGE,
  CHARS_PER_PAGE_DOCX,
  pagesFromChars,
  visibleTextLength,
  parseNavPageList,
  parseNcxPageList,
  parseNavToc,
  parseNcxToc,
  provisionalPageCount,
} from '../renderers/webview/pagination.ts'

/*
 * Pagination is derived from *content*, never from rendered layout — the rule
 * the whole reader is built on. Deriving pages from height made a 145-page EPUB
 * report 295 and change again on rotation, so these tests pin the two tiers:
 * the publisher's own page list wins, and otherwise it is a character count.
 *
 * What makes them worth having is that none of this needs a device. The parsers
 * are string in, structure out.
 */

test('visible length ignores markup', () => {
  assert.equal(visibleTextLength('<p>hello</p>'), 5)
})

test('visible length ignores script and style content', () => {
  // Markup must not inflate a page count, or a heavily-styled book reports more
  // pages than a plain one with the same text.
  assert.equal(visibleTextLength('<style>p{color:red}</style><p>hello</p>'), 5)
  assert.equal(visibleTextLength('<script>var x=1</script><p>hello</p>'), 5)
})

test('entities count as one character', () => {
  assert.equal(visibleTextLength('<p>a&amp;b</p>'), 3)
})

test('page count is never zero', () => {
  // An empty document is one page, not none: the reader always has something
  // to show a position within.
  assert.equal(pagesFromChars(0), 1)
  assert.equal(pagesFromChars(1), 1)
})

test('page count rounds up', () => {
  assert.equal(pagesFromChars(CHARS_PER_PAGE), 1)
  assert.equal(pagesFromChars(CHARS_PER_PAGE + 1), 2)
})

test('DOCX pages use their own, larger divisor', () => {
  // A Word page holds noticeably more text than a paperback page.
  assert.equal(pagesFromChars(CHARS_PER_PAGE_DOCX, CHARS_PER_PAGE_DOCX), 1)
  assert.ok(CHARS_PER_PAGE_DOCX > CHARS_PER_PAGE)
})

test('EPUB 3 nav page-list is read', () => {
  const nav = `
    <nav epub:type="page-list">
      <ol>
        <li><a href="ch1.xhtml#p1">1</a></li>
        <li><a href="ch1.xhtml#p2">2</a></li>
      </ol>
    </nav>`
  const marks = parseNavPageList(nav)
  assert.equal(marks.length, 2)
  assert.equal(marks[0].label, '1')
  assert.equal(marks[0].href, 'ch1.xhtml#p1')
})

test('a nav that is not a page-list is ignored', () => {
  // A TOC nav must not be mistaken for a page list, or chapter count becomes
  // page count.
  assert.deepEqual(parseNavPageList('<nav epub:type="toc"><a href="a">A</a></nav>'), [])
})

test('EPUB 2 NCX page list is read', () => {
  const ncx = `
    <pageList>
      <pageTarget value="42">
        <navLabel><text>42</text></navLabel>
        <content src="chapter3.xhtml#page_42"/>
      </pageTarget>
    </pageList>`
  const marks = parseNcxPageList(ncx)
  assert.equal(marks.length, 1)
  assert.equal(marks[0].label, '42')
  assert.equal(marks[0].href, 'chapter3.xhtml#page_42')
})

test('roman-numeral page labels survive as labels', () => {
  // Front matter is numbered i, ii, iii — which is exactly why a PagePosition
  // carries a label rather than a number.
  const ncx = `
    <pageList>
      <pageTarget value="1">
        <navLabel><text>iv</text></navLabel>
        <content src="front.xhtml#p4"/>
      </pageTarget>
    </pageList>`
  assert.equal(parseNcxPageList(ncx)[0].label, 'iv')
})

test('missing page lists produce none rather than throwing', () => {
  // Most books declare no page list at all; that is the normal path into the
  // character-count estimate, not an error.
  assert.deepEqual(parseNavPageList(''), [])
  assert.deepEqual(parseNcxPageList(''), [])
  assert.deepEqual(parseNavToc(''), [])
  assert.deepEqual(parseNcxToc(''), [])
})

test('nav TOC entries keep their title and target', () => {
  const nav = `
    <nav epub:type="toc">
      <ol>
        <li><a href="ch1.xhtml">Chapter One</a></li>
        <li><a href="ch2.xhtml">Chapter Two</a></li>
      </ol>
    </nav>`
  const toc = parseNavToc(nav)
  assert.equal(toc.length, 2)
  assert.equal(toc[0].title, 'Chapter One')
  assert.equal(toc[0].href, 'ch1.xhtml')
})

/*
 * P12-1 — XML parsing instead of regexes.
 *
 * These are the books the old parser failed on, and the failure mode is what
 * makes them worth pinning: it did not throw, it returned nothing — so the book
 * opened with no chapters and no page list, which a reader experiences as "this
 * EPUB doesn't have a table of contents" rather than as a bug to report.
 */

test('a namespaced NCX still yields its page list', () => {
  /*
   * `<ncx:pageTarget>` does not match `/<pageTarget\b/`, so the old tokenizer
   * returned an empty list and the book fell back to estimated page numbers —
   * silently discarding the publisher's real ones, which is the exact thing the
   * two-tier page rule exists to prefer.
   */
  const ncx = `<?xml version="1.0"?>
    <ncx:ncx xmlns:ncx="http://www.daisy.org/z3986/2005/ncx/">
      <ncx:pageList>
        <ncx:pageTarget value="7">
          <ncx:navLabel><ncx:text>vii</ncx:text></ncx:navLabel>
          <ncx:content src="front.xhtml#p7"/>
        </ncx:pageTarget>
      </ncx:pageList>
    </ncx:ncx>`

  const marks = parseNcxPageList(ncx)
  assert.equal(marks.length, 1, 'a namespaced NCX parsed to nothing')
  assert.equal(marks[0].label, 'vii', 'roman numerals must survive as labels')
  assert.equal(marks[0].href, 'front.xhtml#p7')
})

test('a CDATA chapter title is read rather than dropped', () => {
  // `<text><![CDATA[...]]></text>` does not match a plain text capture, so the
  // entry had no title and was skipped entirely.
  const ncx = `<ncx>
    <navMap>
      <navPoint>
        <navLabel><text><![CDATA[Chapter 1: Beginnings]]></text></navLabel>
        <content src="c1.xhtml"/>
      </navPoint>
    </navMap>
  </ncx>`

  const toc = parseNcxToc(ncx)
  assert.equal(toc.length, 1, 'a CDATA title dropped the entry')
  assert.equal(toc[0].title, 'Chapter 1: Beginnings')
})

test('attribute order does not affect parsing', () => {
  // The old per-tag regexes matched attributes positionally enough that an
  // unusual order, or a `>` inside a value, truncated the match.
  const ncx = `<ncx><navMap>
    <navPoint id="x" playOrder="1" class="chapter">
      <navLabel><text>One</text></navLabel>
      <content src="a.xhtml"/>
    </navPoint>
  </navMap></ncx>`

  const toc = parseNcxToc(ncx)
  assert.equal(toc.length, 1)
  assert.equal(toc[0].href, 'a.xhtml')
})

test('nested navPoints get structural depth, not a running counter', () => {
  /*
   * Depth used to be counted by streaming past opening and closing tags, which
   * desynchronises on a self-closing or namespaced navPoint — and once it
   * drifts, every entry after it is indented wrong. Recursion cannot drift.
   */
  const ncx = `<ncx><navMap>
    <navPoint>
      <navLabel><text>Part I</text></navLabel>
      <content src="p1.xhtml"/>
      <navPoint>
        <navLabel><text>Chapter 1</text></navLabel>
        <content src="c1.xhtml"/>
        <navPoint>
          <navLabel><text>Section A</text></navLabel>
          <content src="s1.xhtml"/>
        </navPoint>
      </navPoint>
    </navPoint>
    <navPoint>
      <navLabel><text>Part II</text></navLabel>
      <content src="p2.xhtml"/>
    </navPoint>
  </navMap></ncx>`

  const toc = parseNcxToc(ncx)
  assert.deepEqual(
    toc.map((e) => [e.title, e.depth]),
    [
      ['Part I', 0],
      ['Chapter 1', 1],
      ['Section A', 2],
      ['Part II', 0],
    ],
  )
})

test('a single navPoint is handled like a list of many', () => {
  /*
   * fast-xml-parser returns an object for one child and an array for several.
   * Forgetting that is a bug visible only on a book with exactly one chapter —
   * precisely the edge case that ships unnoticed.
   */
  const one = parseNcxToc(
    `<ncx><navMap><navPoint><navLabel><text>Only</text></navLabel><content src="a.xhtml"/></navPoint></navMap></ncx>`,
  )
  assert.equal(one.length, 1)
  assert.equal(one[0].title, 'Only')
})

test('malformed XML degrades to an empty list rather than throwing', () => {
  // A book with a broken manifest must still open — without chapters, but open.
  assert.deepEqual(parseNcxToc('<ncx><navMap><navPoint'), [])
  assert.deepEqual(parseNcxPageList('not xml at all <<<'), [])
})

test('a page target falls back to its value attribute when it has no label', () => {
  const ncx = `<ncx><pageList>
    <pageTarget value="99"><content src="x.xhtml#p99"/></pageTarget>
  </pageList></ncx>`

  const marks = parseNcxPageList(ncx)
  assert.equal(marks.length, 1)
  assert.equal(marks[0].label, '99')
})

test('numeric-looking titles and labels stay strings', () => {
  /*
   * `parseTagValue: false` is load-bearing: a book called "1984" must not
   * become the number 1984, and a page label "007" must keep its zeros — both
   * are displayed verbatim in the chapter list and the page badge.
   */
  const toc = parseNcxToc(
    `<ncx><navMap><navPoint><navLabel><text>1984</text></navLabel><content src="a.xhtml"/></navPoint></navMap></ncx>`,
  )
  assert.strictEqual(toc[0].title, '1984')

  const marks = parseNcxPageList(
    `<ncx><pageList><pageTarget><navLabel><text>007</text></navLabel><content src="a.xhtml#p"/></pageTarget></pageList></ncx>`,
  )
  assert.strictEqual(marks[0].label, '007', 'leading zeros were lost to number coercion')
})


/* ==================== two-phase page counts (R4-1) ==================== */

/*
 * Phase 1 assembles only the first few chapters, so a book that declares no
 * page list cannot have its text counted yet. The provisional figure comes from
 * the *uncompressed byte sizes* the ZIP central directory carries for free.
 *
 * What must survive is the invariant [DETAIL.md §5.2](../../DETAIL.md) protects:
 * a page count is a function of the book's **content**, never of how it renders.
 * A byte-derived estimate still satisfies that — rotating the phone cannot
 * change it — which is what makes it a legitimate first answer rather than the
 * layout artefact the whole design exists to remove.
 */

test('a provisional count is derived from the archive, not from layout', () => {
  const sizes = new Map([
    ['OEBPS/ch1.xhtml', 12_000],
    ['OEBPS/ch2.xhtml', 12_000],
  ])

  const count = provisionalPageCount(['OEBPS/ch1.xhtml', 'OEBPS/ch2.xhtml'], sizes)

  // 24,000 bytes / 1.2 = 20,000 chars / 1,000 per page = 20 pages.
  assert.equal(count, 20)
})

test('a provisional count lands close to the exact one for real markup', () => {
  /*
   * The calibration, pinned against the measurements that produced it:
   *
   *   plain prose ......... 1.014 bytes/char
   *   typical markup ...... 1.083
   *   the test EPUB ....... 1.232
   *   heavy markup ........ 1.474
   *
   * A constant of 1.2 therefore over- or under-counts by a bounded amount, and
   * this is what stops someone "tidying" it to 1.0 without noticing that heavy
   * markup then reports 23% too many pages.
   */
  const CHARS = 300_000

  for (const [label, bytesPerChar] of [
    ['plain prose', 1.014],
    ['typical markup', 1.083],
    ['test EPUB', 1.232],
    ['heavy markup', 1.474],
  ] as const) {
    const sizes = new Map([['ch.xhtml', Math.round(CHARS * bytesPerChar)]])
    const provisional = provisionalPageCount(['ch.xhtml'], sizes)
    const exact = pagesFromChars(CHARS)

    const errorPct = Math.abs(provisional - exact) / exact
    assert.ok(
      errorPct < 0.25,
      `${label}: provisional ${provisional} vs exact ${exact} is ${(errorPct * 100).toFixed(0)}% off`,
    )
  }
})

test('a provisional count never reports zero pages', () => {
  // Zero would hide the page indicator entirely, which is how a spreadsheet is
  // signalled — a book must never be mistaken for one.
  assert.equal(provisionalPageCount([], new Map()), 1)
  assert.equal(provisionalPageCount(['missing.xhtml'], new Map()), 1)
  assert.ok(provisionalPageCount(['tiny.xhtml'], new Map([['tiny.xhtml', 5]])) >= 1)
})

test('entries absent from the listing contribute nothing rather than throwing', () => {
  // A spine can name an item the archive does not contain; the open must
  // survive it, as `assembleChapter` already does by skipping.
  const sizes = new Map([['there.xhtml', 12_000]])
  assert.equal(
    provisionalPageCount(['there.xhtml', 'gone.xhtml'], sizes),
    provisionalPageCount(['there.xhtml'], sizes),
  )
})
