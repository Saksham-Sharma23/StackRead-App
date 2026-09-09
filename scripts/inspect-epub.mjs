#!/usr/bin/env node
/**
 * Dumps an EPUB's structure, the way the app's own parser sees it.
 *
 *   node scripts/inspect-epub.mjs <file.epub>
 *
 * Prints the OPF path, title, manifest and spine counts, the NCX navMap, and
 * how many `pageList` targets the book declares.
 *
 * That last number is the one worth having. Page counts come from content, not
 * layout ([CLAUDE.md](../CLAUDE.md)), and the first tier is the publisher's own
 * page list — so when a book reports a surprising total, the question is always
 * "does it declare a pageList, and how many targets". Answering that from the
 * device means reading logs; answering it here takes a second.
 *
 * Deliberately mirrors [src/renderers/webview/xml.ts](../src/renderers/webview/xml.ts)
 * in its parser options (`removeNSPrefix`, unparsed attribute values), so what
 * this prints is what the app actually gets rather than what a differently
 * configured parser would produce.
 *
 * Dev-only. Not imported by the app and not part of any build.
 */
import { unzipSync, strFromU8 } from 'fflate'
import { readFileSync } from 'node:fs'
import { XMLParser } from 'fast-xml-parser'
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true,
  parseAttributeValue: false, parseTagValue: false, trimValues: true, cdataPropName: false })
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v])
const zip = unzipSync(new Uint8Array(readFileSync(process.argv[2])))
const t = (p) => strFromU8(zip[p])
const c = parser.parse(t('META-INF/container.xml'))
const opfPath = asArray(c?.container?.rootfiles?.rootfile)[0]?.['@_full-path']
console.log('opf path      :', opfPath)
const pkg = parser.parse(t(opfPath))?.package
console.log('title (CDATA) :', JSON.stringify(pkg?.metadata?.title))
console.log('manifest items:', asArray(pkg?.manifest?.item).length)
console.log('spine refs    :', asArray(pkg?.spine?.itemref).length)
const ncx = parser.parse(t('OEBPS/toc.ncx'))?.ncx
const walk = (n, d = 0, out = []) => { for (const p of asArray(n?.navPoint)) {
  out.push('  '.repeat(d) + p?.navLabel?.text); walk(p, d + 1, out) } return out }
console.log('ncx navMap    :'); console.log(walk(ncx?.navMap).map(s => '   ' + s).join('\n'))
console.log('ncx pageList  :', asArray(ncx?.pageList?.pageTarget).length, 'targets')
