#!/usr/bin/env node
/**
 * Generates a realistic multi-format test library for device testing.
 *
 *   node scripts/make-test-library.mjs <output-dir>
 *
 * Then push the directory to a phone and import from it.
 *
 * Every ZIP-based format is built as a **genuine archive** rather than a stub,
 * so importing these exercises the app's real parsers — `loadEpubAsHtml`, the
 * CBZ reader, the DOCX and spreadsheet paths — instead of only lighting up the
 * format badge. A stub file proves the importer accepts an extension; it proves
 * nothing about the renderer that has to open it.
 *
 * Each document carries a distinctive marker token, so an FTS5 search result
 * can be attributed to exactly one file. That is what makes library search
 * testable by hand: search the token, expect precisely one hit.
 *
 * Dev-only. Not imported by the app and not part of any build — `fflate` is the
 * only dependency and the app already ships it.
 */
import { zipSync, strToU8 } from 'fflate'
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.argv[2]
mkdirSync(OUT, { recursive: true })
const w = (name, data) => {
  writeFileSync(join(OUT, name), data)
  console.log('  ' + name)
}

// A distinctive token per file lets FTS5 results be attributed unambiguously.
const lorem = (topic, token) =>
  `${topic}\n\n${token} is the marker term for this document.\n\n` +
  Array.from({ length: 12 }, (_, i) =>
    `Section ${i + 1}. This chapter discusses ${topic.toLowerCase()} with reference to ` +
    `${token} and related concepts. It covers methodology, evaluation and practical ` +
    `consequences in ordinary prose so pagination has real text to divide.`,
  ).join('\n\n')

// ---------- plain text family ----------
w('Thermodynamics Notes.txt', lorem('Thermodynamics Notes', 'entropyflux'))
w('Server Trace.log', lorem('Server Trace', 'tracewarp'))
w('Compiler Design.md',
  `# Compiler Design\n\nMarker: **parsetoken**\n\n## Lexical Analysis\n\n` +
  `Converts characters to tokens.\n\n## Parsing\n\n- LL(1)\n- LR(1)\n- GLR\n\n` +
  `## Code Generation\n\n\`\`\`c\nint main(void) { return 0; }\n\`\`\`\n\n` +
  `| Phase | Input | Output |\n|---|---|---|\n| Lexer | chars | tokens |\n` +
  `| Parser | tokens | AST |\n\n> Optimisation is where correctness goes to die.\n`)
w('Research Portal.html',
  `<!doctype html><html><head><title>Research Portal</title></head><body>` +
  `<h1>Research Portal</h1><p>Marker: <b>hypertoken</b></p>` +
  `<h2>Abstract</h2><p>${lorem('Distributed Consensus', 'hypertoken').slice(0, 900)}</p>` +
  `<ul><li>Raft</li><li>Paxos</li><li>Zab</li></ul>` +
  `<table border=1><tr><th>Algorithm</th><th>Year</th></tr>` +
  `<tr><td>Paxos</td><td>1989</td></tr><tr><td>Raft</td><td>2014</td></tr></table>` +
  `</body></html>`)

// ---------- delimited ----------
const rows = [
  ['id', 'title', 'author', 'year', 'citations'],
  ['1', 'Attention Is All You Need', 'Vaswani', '2017', '103000'],
  ['2', 'Deep Residual Learning', 'He', '2015', '210000'],
  ['3', 'ImageNet Classification', 'Krizhevsky', '2012', '160000'],
  ['4', 'Generative Adversarial Nets', 'Goodfellow', '2014', '75000'],
  ['5', 'BERT Pretraining', 'Devlin', '2018', '98000'],
  ['6', 'Adam Optimizer', 'Kingma', '2014', '190000'],
  ['7', 'Dropout Regularization', 'Srivastava', '2014', '48000'],
  ['8', 'Batch Normalization', 'Ioffe', '2015', '52000'],
]
w('Citation Index.csv', rows.map((r) => r.join(',')).join('\n'))
w('Benchmark Results.tsv', rows.map((r) => r.join('\t')).join('\n'))

// ---------- DOCX (real OOXML) ----------
const para = (t) =>
  `<w:p><w:r><w:t xml:space="preserve">${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`
w('Machine Learning Thesis.docx', Buffer.from(zipSync({
  '[Content_Types].xml': strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`),
  '_rels/.rels': strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`),
  'word/document.xml': strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    para('Machine Learning Thesis') + para('Marker: gradientmark') +
    lorem('Gradient Methods', 'gradientmark').split('\n\n').map(para).join('') +
    `</w:body></w:document>`),
})))

// ---------- XLSX (real OOXML, inline strings) ----------
const cellRef = (c, r) => String.fromCharCode(65 + c) + (r + 1)
const sheetRows = rows.map((r, ri) =>
  `<row r="${ri + 1}">` + r.map((v, ci) =>
    `<c r="${cellRef(ci, ri)}" t="inlineStr"><is><t>${v}</t></is></c>`).join('') + `</row>`).join('')
w('Quarterly Metrics.xlsx', Buffer.from(zipSync({
  '[Content_Types].xml': strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `</Types>`),
  '_rels/.rels': strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`),
  'xl/workbook.xml': strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="Metrics" sheetId="1" r:id="rId1"/></sheets></workbook>`),
  'xl/_rels/workbook.xml.rels': strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `</Relationships>`),
  'xl/worksheets/sheet1.xml': strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${sheetRows}</sheetData></worksheet>`),
})))

// ---------- images (valid PNG / GIF, hand-built) ----------
function crc32(buf) {
  let c, t = []
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c }
  let crc = 0xffffffff
  for (const b of buf) crc = t[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function png(width, height, rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const off = y * (1 + width * 3)
    raw[off] = 0
    for (let x = 0; x < width; x++) {
      const p = off + 1 + x * 3
      // A soft gradient so the thumbnail and ThumbHash have real structure.
      raw[p] = (rgb[0] + Math.floor((x / width) * 90)) & 0xff
      raw[p + 1] = (rgb[1] + Math.floor((y / height) * 90)) & 0xff
      raw[p + 2] = rgb[2] & 0xff
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}
const pageA = png(600, 800, [40, 90, 200])
const pageB = png(600, 800, [200, 70, 60])
const pageC = png(600, 800, [40, 170, 110])
w('Nebula Plate.png', pageA)
w('Spectrum Chart.png', pageC)
// Minimal but valid 4x4 GIF87a
w('Loop Marker.gif', Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x04, 0x00, 0x04, 0x00, 0x80, 0x00, 0x00,
  0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00,
  0x04, 0x00, 0x00, 0x02, 0x04, 0x84, 0x8f, 0x09, 0x05, 0x00, 0x3b,
]))

// ---------- CBZ (comic: images in a zip, name-ordered) ----------
w('Orbital Comics Issue 1.cbz', Buffer.from(zipSync({
  'page01.png': new Uint8Array(pageA), 'page02.png': new Uint8Array(pageB),
  'page03.png': new Uint8Array(pageC), 'page04.png': new Uint8Array(pageA),
})))

// ---------- ZIP (generic archive listing) ----------
w('Project Bundle.zip', Buffer.from(zipSync({
  'README.md': strToU8('# Project Bundle\n\nMarker: archivetoken\n'),
  'data/notes.txt': strToU8(lorem('Bundled Notes', 'archivetoken')),
  'data/table.csv': strToU8(rows.map((r) => r.join(',')).join('\n')),
  'images/cover.png': new Uint8Array(pageB),
})))

// ---------- EPUB 3 with a page-list and a nested NCX ----------
// Exercises the P12-1 XML rewrite: namespaced elements, CDATA title, a single
// -child manifest case, and both the EPUB 3 nav and the EPUB 2 NCX fallback.
const chapters = ['Awakening', 'The Signal', 'Descent', 'The Long Night', 'Return']
const chapterFiles = {}
chapters.forEach((title, i) => {
  chapterFiles[`OEBPS/ch${i + 1}.xhtml`] = strToU8(
    `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html>` +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${title}</title></head><body>` +
    `<h1 id="c${i + 1}">${title}</h1>` +
    `<span epub:type="pagebreak" id="page${i * 2 + 1}" role="doc-pagebreak" aria-label="${i * 2 + 1}"/>` +
    lorem(title, 'orbitmark').split('\n\n').map((p) => `<p>${p}</p>`).join('') +
    `<span epub:type="pagebreak" id="page${i * 2 + 2}" role="doc-pagebreak" aria-label="${i * 2 + 2}"/>` +
    `</body></html>`)
})
w('Orbital Silence.epub', Buffer.from(zipSync({
  'mimetype': strToU8('application/epub+zip'),
  'META-INF/container.xml': strToU8(
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
    `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
  // Deliberately namespaced (opf:) with a CDATA title — both broke the old regexes.
  'OEBPS/content.opf': strToU8(
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<opf:package xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" unique-identifier="bid">` +
    `<opf:metadata><dc:identifier id="bid">urn:uuid:test-orbital</dc:identifier>` +
    `<dc:title><![CDATA[Orbital Silence]]></dc:title><dc:language>en</dc:language>` +
    `<dc:creator>A. Tester</dc:creator></opf:metadata>` +
    `<opf:manifest>` +
    `<opf:item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>` +
    `<opf:item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>` +
    chapters.map((_, i) => `<opf:item id="c${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('') +
    `</opf:manifest>` +
    `<opf:spine toc="ncx">` +
    chapters.map((_, i) => `<opf:itemref idref="c${i + 1}"/>`).join('') +
    `</opf:spine></opf:package>`),
  'OEBPS/nav.xhtml': strToU8(
    `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html>` +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body>` +
    `<nav epub:type="toc" id="toc"><ol>` +
    chapters.map((t, i) => `<li><a href="ch${i + 1}.xhtml#c${i + 1}">${t}</a>` +
      (i === 1 ? `<ol><li><a href="ch2.xhtml#c2">Subsection A</a></li></ol>` : '') + `</li>`).join('') +
    `</ol></nav>` +
    `<nav epub:type="page-list"><ol>` +
    chapters.flatMap((_, i) => [i * 2 + 1, i * 2 + 2]).map((p, i) =>
      `<li><a href="ch${Math.floor(i / 2) + 1}.xhtml#page${p}">${p}</a></li>`).join('') +
    `</ol></nav></body></html>`),
  // NCX with an explicit namespace prefix and nesting — the recursive walk path.
  'OEBPS/toc.ncx': strToU8(
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<ncx:ncx xmlns:ncx="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">` +
    `<ncx:head><ncx:meta name="dtb:uid" content="urn:uuid:test-orbital"/></ncx:head>` +
    `<ncx:docTitle><ncx:text>Orbital Silence</ncx:text></ncx:docTitle>` +
    `<ncx:navMap>` +
    chapters.map((t, i) =>
      `<ncx:navPoint id="np${i + 1}" playOrder="${i + 1}">` +
      `<ncx:navLabel><ncx:text>${t}</ncx:text></ncx:navLabel>` +
      `<ncx:content src="ch${i + 1}.xhtml#c${i + 1}"/>` +
      (i === 1 ? `<ncx:navPoint id="np2a" playOrder="99"><ncx:navLabel><ncx:text>Subsection A</ncx:text></ncx:navLabel>` +
        `<ncx:content src="ch2.xhtml#c2"/></ncx:navPoint>` : '') +
      `</ncx:navPoint>`).join('') +
    `</ncx:navMap>` +
    `<ncx:pageList>` +
    chapters.flatMap((_, i) => [i * 2 + 1, i * 2 + 2]).map((p, i) =>
      `<ncx:pageTarget type="normal" value="${p}"><ncx:navLabel><ncx:text>${p}</ncx:text></ncx:navLabel>` +
      `<ncx:content src="ch${Math.floor(i / 2) + 1}.xhtml#page${p}"/></ncx:pageTarget>`).join('') +
    `</ncx:pageList></ncx:ncx>`),
  ...chapterFiles,
})))

console.log('\ndone')
