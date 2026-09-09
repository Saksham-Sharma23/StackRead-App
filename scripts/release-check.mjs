#!/usr/bin/env node
/**
 * Refuses a release build that would ship wrong.
 *
 * Every check here guards a failure that is invisible in the artefact itself:
 * a debug-signed APK installs and runs perfectly, an arm64-only APK works on
 * the phone it was tested on, and a duplicate versionCode is only rejected at
 * upload time, long after the build looked successful. None of them announce
 * themselves, so they are asserted before the build rather than inspected
 * after it.
 *
 * Runs as the first step of `npm run apk`. For a throwaway local release build,
 * `npm run apk:dev` skips this and keeps the fast single-ABI settings.
 */
import { readFileSync, existsSync } from 'node:fs'

const problems = []
const notes = []

// --- signing ---------------------------------------------------------------
// Without a password the Gradle config falls back to the debug keystore, and a
// debug-signed APK cannot be updated by a properly signed one later: Android
// treats a signature change as a different app.
if (!process.env.STACKREAD_STORE_PASSWORD) {
  problems.push(
    'STACKREAD_STORE_PASSWORD is not set.\n' +
      '    Without it the APK is signed with the DEBUG key. Android will refuse to\n' +
      '    update a debug-signed install with a real one, so shipping it is\n' +
      '    unrecoverable. See credentials/README.md.',
  )
}

if (!existsSync('credentials/stackread-release.keystore')) {
  problems.push(
    'credentials/stackread-release.keystore is missing — nothing to sign with.',
  )
}

// --- versionCode -----------------------------------------------------------
// The generated android/ is rewritten by prebuild, so app.json is the only
// place a version can survive.
try {
  const app = JSON.parse(readFileSync('app.json', 'utf8'))
  const code = app?.expo?.android?.versionCode
  if (typeof code !== 'number') {
    problems.push(
      'expo.android.versionCode is missing from app.json.\n' +
        '    The generated android/ resets it to 1 on every prebuild, so it has to\n' +
        '    live here or updates become impossible to publish.',
    )
  } else {
    notes.push(`versionCode ${code} (bump this for every upload)`)
  }

  if (app?.expo?.android?.allowBackup !== false) {
    problems.push(
      'android.allowBackup is not false in app.json.\n' +
        "    The user's whole library would be copied to their Google Drive with no\n" +
        '    consent prompt.',
    )
  }
} catch (err) {
  problems.push(`app.json could not be read: ${err.message}`)
}

// --- report ----------------------------------------------------------------
if (problems.length) {
  console.error('\nRelease build refused:\n')
  for (const p of problems) console.error(`  ✗ ${p}\n`)
  console.error('Use `npm run apk:dev` for a local build that does not need to ship.\n')
  process.exit(1)
}

console.log('[release-check] ready to build:')
for (const n of notes) console.log(`  · ${n}`)
