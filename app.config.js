/**
 * app.json, plus what has to be computed: the version derived from git
 * (`scripts/versioning.cjs`) and the intent filters that let other apps hand
 * StackRead a file.
 *
 * Everything else stays in app.json. Expo reads app.json first and hands it in
 * as `config`; this only overwrites `version`, `android.versionCode` and
 * `android.intentFilters`, so the generated android/ carries them from the
 * moment it is created.
 *
 * In CI a failure to derive the version is fatal: a release that cannot know
 * its versionCode must not build. Locally — the dev server reads this on every
 * Metro reload — it falls back to app.json with a warning, because a shallow
 * clone should not stop anyone from running the app. The release path is
 * still guarded locally: `npm run apk` runs `release-check.mjs`, which does
 * not fall back.
 */
const { resolveVersion } = require('./scripts/versioning.cjs')

/*
 * The types StackRead can open, for "Open with" and "Share".
 *
 * A copy of `INCOMING_MIME_TYPES` in src/storage/formats.ts — this file is
 * CommonJS and cannot import TypeScript — held to it by `incoming.test.ts`.
 * Add a format there and the test says to add it here.
 */
const INCOMING_MIME_TYPES = [
  'application/epub+zip',
  'application/pdf',
  'application/vnd.comicbook+zip',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/x-cbz',
  'application/x-pdf',
  'application/x-zip-compressed',
  'application/zip',
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'text/csv',
  'text/html',
  'text/markdown',
  'text/plain',
  'text/tab-separated-values',
  'text/x-markdown',
]

/*
 * "Open with" also offers itself for untyped files: file managers commonly
 * send .epub, .cbz and .md as `application/octet-stream`, and missing those is
 * worse than appearing for an unknown binary — which StackRead then declines,
 * by extension, with a message.
 */
const VIEW_TYPES = [...INCOMING_MIME_TYPES, 'application/octet-stream']

/*
 * The share sheet does not offer itself for plain text. Apps share messages
 * and links as `text/plain` with no file attached, constantly; StackRead would
 * sit in every one of those sheets and do nothing when chosen. A .txt file
 * still opens through "Open with".
 */
const SHARE_TYPES = INCOMING_MIME_TYPES.filter((type) => type !== 'text/plain')

/*
 * VIEW matches on a content:// URI plus a type. SEND carries the file in an
 * extra, not as the intent's data, and Android only matches a type-only intent
 * against a filter that declares no scheme — so the share filters list types
 * alone.
 */
function intentFilters() {
  const types = (list) => list.map((mimeType) => ({ mimeType }))
  return [
    { action: 'VIEW', category: ['DEFAULT'], data: [{ scheme: 'content' }, ...types(VIEW_TYPES)] },
    { action: 'SEND', category: ['DEFAULT'], data: types(SHARE_TYPES) },
    { action: 'SEND_MULTIPLE', category: ['DEFAULT'], data: types(SHARE_TYPES) },
  ]
}

module.exports = ({ config }) => {
  const android = {
    ...config.android,
    intentFilters: [...(config.android?.intentFilters ?? []), ...intentFilters()],
  }

  let version
  try {
    version = resolveVersion({ version: config.version, floor: config.android?.versionCode })
  } catch (err) {
    if (process.env.CI) throw err
    console.warn(`[app.config] ${err.message} Using app.json's version instead.`)
    return { ...config, android }
  }
  return {
    ...config,
    version: version.versionName,
    android: { ...android, versionCode: version.versionCode },
  }
}

module.exports.INCOMING_MIME_TYPES = INCOMING_MIME_TYPES
module.exports.SHARE_TYPES = SHARE_TYPES
module.exports.VIEW_TYPES = VIEW_TYPES
