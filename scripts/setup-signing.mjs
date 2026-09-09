#!/usr/bin/env node
/**
 * Restores release signing after `expo prebuild`.
 *
 * `android/` is generated — prebuild deletes and recreates it — so a keystore
 * kept only there is destroyed by the next prebuild. That is not a cosmetic
 * loss: whoever holds the keystore controls updates, and losing it means an
 * installed app can never be updated, only uninstalled and reinstalled (taking
 * the user's library with it).
 *
 * So `credentials/` holds the master copy and this script re-installs it, the
 * same way `tune-gradle.mjs` re-applies the low-memory build settings.
 *
 * Passwords are NOT written here. They are read from the environment at build
 * time by `build.gradle`, because `android/gradle.properties` is a plaintext
 * file Gradle must be able to read and which is easy to commit by accident.
 * A password written there puts the signing identity one `git add -A` away from
 * publication — and that cannot be undone by changing the password, only by
 * regenerating the key and abandoning the update path for installed copies.
 *
 * Set these before a release build (see credentials/README.md):
 *   STACKREAD_STORE_PASSWORD   (required)
 *   STACKREAD_KEY_PASSWORD     (defaults to the store password)
 *   STACKREAD_KEY_ALIAS        (defaults to "stackread")
 *
 * Wired into the `prebuild` npm script so it is never forgotten.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SOURCE = 'credentials/stackread-release.keystore'
const TARGET = 'android/app/stackread-release.keystore'
const PROPS = 'android/gradle.properties'
const BUILD_GRADLE = 'android/app/build.gradle'

if (!existsSync('android')) {
  console.log('[setup-signing] no android/ directory; nothing to do')
  process.exit(0)
}

if (!existsSync(SOURCE)) {
  console.warn(
    `[setup-signing] ${SOURCE} is missing — release builds will fall back to the\n` +
      '                debug keystore. See credentials/README.md.',
  )
  process.exit(0)
}

mkdirSync(dirname(TARGET), { recursive: true })
copyFileSync(SOURCE, TARGET)

// --- keystore location in gradle.properties; never the passwords ---
let props = readFileSync(PROPS, 'utf8')

// An earlier version of this script appended the passwords here. Strip them if
// this checkout still carries them from a previous prebuild, so a stale
// generated file cannot keep leaking after the fix.
const cleaned = props.replace(/^STACKREAD_UPLOAD_(?:STORE|KEY)_PASSWORD=.*\r?\n?/gm, '')
if (cleaned !== props) {
  console.warn('[setup-signing] stripped plaintext passwords from android/gradle.properties')
  props = cleaned
}

if (!props.includes('STACKREAD_UPLOAD_STORE_FILE')) {
  props +=
    '\n# Release signing. Restored by scripts/setup-signing.mjs after prebuild.\n' +
    '# Passwords live in the environment, not here — see credentials/README.md.\n' +
    'STACKREAD_UPLOAD_STORE_FILE=stackread-release.keystore\n'
}

writeFileSync(PROPS, props)

// --- the release signingConfig itself ---
let gradle = readFileSync(BUILD_GRADLE, 'utf8')
if (!gradle.includes('STACKREAD_UPLOAD_STORE_FILE')) {
  gradle = gradle.replace(
    /(signingConfigs \{\s*\n\s*debug \{[\s\S]*?\n {8}\}\n)/,
    `$1        release {
            // Credentials come from the environment. When they are absent this
            // falls back to the debug keystore, so a fresh clone still builds
            // instead of failing on signing — but see the assertion in the
            // \`apk\` script: a real release must not ship debug-signed.
            def storePw = System.getenv("STACKREAD_STORE_PASSWORD")
            def keyPw = System.getenv("STACKREAD_KEY_PASSWORD") ?: storePw
            def keyName = System.getenv("STACKREAD_KEY_ALIAS") ?: "stackread"
            if (project.hasProperty('STACKREAD_UPLOAD_STORE_FILE') && storePw != null) {
                storeFile file(STACKREAD_UPLOAD_STORE_FILE)
                storePassword storePw
                keyAlias keyName
                keyPassword keyPw
            } else {
                storeFile file('debug.keystore')
                storePassword 'android'
                keyAlias 'androiddebugkey'
                keyPassword 'android'
            }
        }
`,
  )
  gradle = gradle.replace(
    /(release \{\n)(\s*)\/\/ Caution! In production[\s\S]*?signingConfig signingConfigs\.debug/,
    '$1$2signingConfig signingConfigs.release',
  )
  writeFileSync(BUILD_GRADLE, gradle)
}

console.log('[setup-signing] release keystore and signing config installed')
console.log(
  process.env.STACKREAD_STORE_PASSWORD
    ? '[setup-signing] signing credentials found in the environment'
    : '[setup-signing] WARNING: STACKREAD_STORE_PASSWORD is not set — release\n' +
        '                builds will be signed with the DEBUG key and cannot be shipped.',
)
