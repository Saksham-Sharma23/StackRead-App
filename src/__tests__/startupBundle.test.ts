import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * AUDIT4 E2 (AUDIT3 §3.1): what the app evaluates before the board can paint.
 *
 * Expo SDK 57's Metro config has `inlineRequires` off, so every module reached
 * by a *static* import from the entry point is evaluated during startup. The
 * reader is behind `lazy()` precisely to keep its heavy dependencies out of
 * that set — and a single static import elsewhere (lifecycle → prefetch →
 * prepare → epub → xml → fast-xml-parser) silently defeated it.
 *
 * This walks the real import graph from `index.ts`, following only static,
 * value-level imports — `import type` is erased and `import()` is deferred, so
 * neither costs startup — and pins what must stay out.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Static value imports in a module: `import … from 'x'` and `export … from 'x'`. */
function staticImports(code: string): string[] {
  // Comments can quote import statements; strip them first.
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const out: string[] = []
  const re = /^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm
  for (const m of stripped.matchAll(re)) {
    if (m[5]) {
      out.push(m[5])
      continue
    }
    if (m[2]) continue // `import type …` / `export type …`
    // `import { type A, type B } from` imports nothing at runtime.
    const clause = m[3].trim()
    const names = clause.replace(/^\{|\}$/g, '').split(',').map((s) => s.trim()).filter(Boolean)
    if (clause.startsWith('{') && names.length && names.every((n) => n.startsWith('type '))) continue
    out.push(m[4])
  }
  return out
}

/** Resolves a relative specifier to a source file, or null for a package. */
function resolveLocal(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(from), spec)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(candidate) && /\.(ts|tsx)$/.test(candidate)) return candidate
  }
  return null
}

/** Every local module and every package reached statically from `entry`. */
function startupGraph(entry: string): { modules: Set<string>; packages: Set<string> } {
  const modules = new Set<string>()
  const packages = new Set<string>()
  const queue = [entry]
  while (queue.length) {
    const file = queue.pop()!
    if (modules.has(file)) continue
    modules.add(file)
    for (const spec of staticImports(readFileSync(file, 'utf8'))) {
      const local = resolveLocal(file, spec)
      if (local) queue.push(local)
      else if (!spec.startsWith('.')) packages.add(spec)
    }
  }
  return { modules, packages }
}

const rel = (p: string) => p.slice(ROOT.length + 1).replace(/\\/g, '/')

test('E2: the EPUB parser and fast-xml-parser are not evaluated at startup', () => {
  const { modules, packages } = startupGraph(resolve(ROOT, 'index.ts'))
  const reached = [...modules].map(rel)

  // Sanity: the walk really covers the app, or the absences below prove nothing.
  for (const expected of ['App.tsx', 'src/screens/LibraryScreen.tsx', 'src/storage/lifecycle.ts']) {
    assert.ok(reached.includes(expected), `the walk must reach ${expected}`)
  }

  for (const heavy of [
    'src/renderers/webview/xml.ts',
    'src/renderers/webview/epub.ts',
    'src/renderers/webview/prepare.ts',
    'src/renderers/webview/prefetch.ts',
    'src/screens/ReaderScreen.tsx',
    'src/renderers/WebViewRenderer.tsx',
  ]) {
    assert.ok(!reached.includes(heavy), `${heavy} must not be in the startup graph`)
  }
  assert.ok(!packages.has('fast-xml-parser'), 'fast-xml-parser must not load at startup')
  assert.ok(!packages.has('mammoth') && !packages.has('xlsx'), 'nor the DOCX or spreadsheet parsers')
})

test('E2: lifecycle takes the prefetch memo from the import-free module', () => {
  const lifecycle = readFileSync(resolve(ROOT, 'src/storage/lifecycle.ts'), 'utf8')
  assert.ok(lifecycle.includes("from '../renderers/webview/prefetchState'"))
  assert.doesNotMatch(lifecycle, /from '\.\.\/renderers\/webview\/prefetch'/)

  const state = readFileSync(resolve(ROOT, 'src/renderers/webview/prefetchState.ts'), 'utf8')
  assert.equal(staticImports(state).length, 0, 'prefetchState must import nothing')
})
