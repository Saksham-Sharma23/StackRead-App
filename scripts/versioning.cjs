/**
 * The app's version, derived from git rather than edited by hand.
 *
 * ## Why
 *
 * Android installs an update only when its `versionCode` is higher than the
 * installed one, and Play rejects a repeat at upload time. A number someone
 * has to remember to bump is a number that will one day not be bumped — and
 * the failure is invisible in the artefact: the APK builds, signs and installs
 * fresh, and only refuses to *update* on a phone that already has the app.
 *
 * ## The rule
 *
 *  - **versionCode** = the number of commits reachable from HEAD. It rises
 *    with every commit on a history that only moves forward, needs no state
 *    and no network, and gives the same number for the same commit on any
 *    machine — so a local build and a CI build of one commit agree.
 *    `expo.android.versionCode` in app.json is a **floor**, not the value: it
 *    only matters if history is ever rewritten (a squash or force-push lowers
 *    the count), and then it is raised past the last shipped code.
 *  - **versionName** = the `vX.Y.Z` tag on HEAD, if there is one, else
 *    `expo.version` from app.json. Tagging a release names it.
 *
 * ## Who reads this
 *
 * Three places, which is why it is one module: `app.config.js` (what prebuild
 * writes into the generated android/), `scripts/tune-gradle.mjs` (which
 * rewrites it on every build, because `npm run apk` builds without a prebuild
 * and would otherwise ship whatever number the last prebuild left), and
 * `scripts/release-check.mjs` (which reports it, and refuses a build that
 * cannot know it).
 *
 * CommonJS because `app.config.js` is loaded by Expo's config reader with
 * `require`.
 */
'use strict'

const { execFileSync } = require('node:child_process')

/** The largest versionCode Play accepts. A commit count will not reach it. */
const MAX_VERSION_CODE = 2100000000

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/

/** The versionCode for a commit count, never below the app.json floor. */
function versionCodeFor(commitCount, floor) {
  if (!Number.isInteger(commitCount) || commitCount < 1) {
    throw new Error(`Not a commit count: ${commitCount}`)
  }
  const code = Math.max(commitCount, Number.isInteger(floor) ? floor : 1)
  if (code > MAX_VERSION_CODE) throw new Error(`versionCode ${code} exceeds Play's maximum`)
  return code
}

/**
 * The highest `vX.Y.Z` among the tags on HEAD, without its `v`, or null.
 * Compared numerically: as strings, v0.10.0 would sort below v0.9.0.
 */
function releaseTagName(tags) {
  let best = null
  for (const tag of tags) {
    const m = RELEASE_TAG.exec(tag.trim())
    if (!m) continue
    const parts = [Number(m[1]), Number(m[2]), Number(m[3])]
    const order = best ? parts[0] - best[0] || parts[1] - best[1] || parts[2] - best[2] : 1
    if (order > 0) best = parts
  }
  return best ? best.join('.') : null
}

/** What git knows, or null when there is no repository (or no git). */
function readGit(cwd) {
  const run = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  try {
    return {
      shallow: run('rev-parse', '--is-shallow-repository') === 'true',
      commitCount: Number(run('rev-list', '--count', 'HEAD')),
      tags: run('tag', '--points-at', 'HEAD').split('\n').filter(Boolean),
    }
  } catch {
    return null
  }
}

/**
 * The version to build.
 *
 * Throws rather than guessing when the answer would be wrong: in a shallow
 * clone the commit count is the clone depth (CI's default checkout is depth 1,
 * which would ship every build as versionCode 1), and without git there is no
 * count at all. Callers that can tolerate a guess — the dev server — catch it.
 *
 * @param {{ version?: string, floor?: number, cwd?: string, git?: typeof readGit }} options
 */
function resolveVersion({ version, floor, cwd = process.cwd(), git = readGit } = {}) {
  const info = git(cwd)
  if (!info) {
    throw new Error('No git history, so no versionCode can be derived. Build from a git clone.')
  }
  if (info.shallow) {
    throw new Error(
      'This is a shallow clone, so the commit count is its depth, not its history. ' +
        'In GitHub Actions, check out with `fetch-depth: 0`.',
    )
  }
  const tagName = releaseTagName(info.tags)
  return {
    versionCode: versionCodeFor(info.commitCount, floor),
    versionName: tagName ?? version ?? '0.0.0',
    fromTag: tagName !== null,
  }
}

module.exports = { versionCodeFor, releaseTagName, resolveVersion, readGit, MAX_VERSION_CODE }
