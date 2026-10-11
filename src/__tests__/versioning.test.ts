import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/*
 * versionCode automation (TASKS2 R7-3).
 *
 * Android installs an update only over a lower versionCode. Bumped by hand, it
 * was one forgotten edit from an APK that installs fresh and refuses to update
 * every phone that has the app — a failure invisible in the artefact. It is
 * now the commit count, from `scripts/versioning.cjs`.
 */

const require = createRequire(import.meta.url)
const { versionCodeFor, releaseTagName, resolveVersion, MAX_VERSION_CODE } = require('../../scripts/versioning.cjs')

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
}

const git = (info: object | null) => () => info

test('the versionCode is the commit count, never below the app.json floor', () => {
  assert.equal(versionCodeFor(57, 1), 57)
  // After a history rewrite the floor is raised past the last shipped code.
  assert.equal(versionCodeFor(20, 60), 60)
  assert.equal(versionCodeFor(57, undefined), 57)
  assert.throws(() => versionCodeFor(0, 1))
  assert.throws(() => versionCodeFor(Number.NaN, 1))
  assert.throws(() => versionCodeFor(MAX_VERSION_CODE + 1, 1), /maximum/)
})

test('a vX.Y.Z tag on HEAD names the release, compared as numbers', () => {
  assert.equal(releaseTagName(['v0.9.0', 'v0.10.0']), '0.10.0')
  assert.equal(releaseTagName(['v1.2.3']), '1.2.3')
  assert.equal(releaseTagName(['nightly', 'v1.0', 'v1.0.0-rc1']), null)
  assert.equal(releaseTagName([]), null)
})

test('the version resolves from git, and app.json only fills in a name', () => {
  assert.deepEqual(resolveVersion({ version: '0.1.0', floor: 1, git: git({ shallow: false, commitCount: 40, tags: [] }) }), {
    versionCode: 40,
    versionName: '0.1.0',
    fromTag: false,
  })
  assert.deepEqual(
    resolveVersion({ version: '0.1.0', floor: 1, git: git({ shallow: false, commitCount: 41, tags: ['v0.2.0'] }) }),
    { versionCode: 41, versionName: '0.2.0', fromTag: true },
  )
})

test('a build that cannot know its versionCode refuses rather than guessing', () => {
  // CI's default checkout is depth 1: every build would be versionCode 1.
  assert.throws(
    () => resolveVersion({ version: '0.1.0', floor: 1, git: git({ shallow: true, commitCount: 1, tags: [] }) }),
    /fetch-depth: 0/,
  )
  assert.throws(() => resolveVersion({ version: '0.1.0', floor: 1, git: git(null) }), /No git history/)
})

test('every build path takes the same derived version', () => {
  // Prebuild writes it into the generated android/.
  const config = source('app.config.js')
  assert.ok(config.includes("require('./scripts/versioning.cjs')"))
  assert.ok(/versionCode: version\.versionCode/.test(config))
  assert.ok(/if \(process\.env\.CI\) throw err/.test(config), 'never a fallback in CI')

  // `npm run apk` builds without a prebuild, so the build script rewrites it.
  const tune = source('scripts/tune-gradle.mjs')
  assert.ok(tune.includes("require('./versioning.cjs')"))
  assert.ok(/\$1versionCode \$\{versionCode\}/.test(tune))
  assert.ok(/if \(release\) \{\s*console\.error[^]*process\.exit\(1\)/.test(tune), 'a release never ships a stale number')

  const check = source('scripts/release-check.mjs')
  assert.ok(check.includes("('./versioning.cjs')") && check.includes('The versionCode cannot be derived'))

  // CI must check out the history, or the count is the clone depth.
  const workflow = source('.github/workflows/android-release.yml')
  assert.ok(/uses: actions\/checkout@v\d+\n\s+with:\n\s+fetch-depth: 0/.test(workflow))
})
