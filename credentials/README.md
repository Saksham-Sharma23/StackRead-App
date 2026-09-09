# Release signing

`stackread-release.keystore` signs release APKs. **It is not in git** —
`.gitignore` excludes everything in this directory except this README.

**This directory is the master copy for a local build.** `android/` is generated
— `expo prebuild` deletes and recreates it — so a keystore living only there
would be destroyed by the next prebuild, and with it any ability to update an
already-installed app.

`scripts/setup-signing.mjs` copies the keystore into `android/app/` and points
`android/gradle.properties` at it. It runs automatically as part of
`npm run prebuild`.

## Passwords live in the environment, never in a file

The passwords used to be written into `android/gradle.properties`. They are not
any more, and must not be put back. That file is plaintext, has to be readable
by Gradle, and sits inside a directory that is easy to commit by accident. A
committed signing password is not like a leaked API key: it cannot be rotated.
Anyone holding the keystore and its password can sign an APK that Android
accepts as an authentic StackRead update, and the only remedy is to regenerate
the key — which permanently breaks the update path for every installed copy.

Set these before a release build:

```powershell
$env:STACKREAD_STORE_PASSWORD = "..."   # required
$env:STACKREAD_KEY_PASSWORD   = "..."   # optional; defaults to the store password
$env:STACKREAD_KEY_ALIAS      = "..."   # optional; defaults to "stackread"
npm run apk
```

```bash
STACKREAD_STORE_PASSWORD=... npm run apk
```

`npm run apk` refuses to build without `STACKREAD_STORE_PASSWORD`, because the
fallback is the debug keystore and a debug-signed APK that looks like a release
is the kind of mistake you only notice after distributing it.

## Back this up

Whoever holds this file controls updates to the app. Lose it and you cannot
update an installed copy — users would have to uninstall and reinstall, losing
their library. Keep a copy somewhere other than this machine: a password manager
with file attachments, or an encrypted backup. Not a git repository.

## Generating a fresh keystore

The keystore currently in use was generated with a placeholder password for
development. **Generate a new one with a real password before distributing
anything**, while `versionCode` is still 1 and nothing is published — after the
first release, replacing the key means every installed copy is orphaned.

```
keytool -genkeypair -v -keystore credentials/stackread-release.keystore \
  -alias stackread -keyalg RSA -keysize 2048 -validity 10000
```

Then set the environment variables above to match. Nothing in the repo needs to
change.
