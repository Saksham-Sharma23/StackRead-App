#!/usr/bin/env node
/**
 * Applies the Gradle settings that `expo prebuild` discards.
 *
 * Prebuild regenerates `android/` from scratch, which silently drops anything
 * hand-edited there. Two different sets of settings need restoring, and they
 * pull in opposite directions — hence the two modes.
 *
 *   node scripts/tune-gradle.mjs            (dev, the default)
 *   node scripts/tune-gradle.mjs --release
 *
 * **dev** — low-memory build settings. On an 8GB machine the default config
 * (4 ABIs, parallel tasks, separate Kotlin daemons) exhausts RAM and clang is
 * killed mid-compile: a 23-minute failure that looks like a toolchain bug.
 * Only `arm64-v8a` is built, which covers every development device here.
 *
 * **release** — the opposite trade. A single-ABI, unminified APK is fine for a
 * device on the desk and wrong for distribution: `arm64-v8a` alone will not
 * install on a 32-bit or x86 device, and without R8 the bundle ships larger and
 * fully readable. Release builds are slower and need more memory; that is the
 * correct cost to pay once, at release, rather than on every dev rebuild.
 *
 * Dev mode is wired into the `prebuild` npm script; release mode into `apk`.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const FILE = 'android/gradle.properties'
const PROGUARD = 'android/app/proguard-rules.pro'
const release = process.argv.includes('--release')

if (!existsSync(FILE)) {
  console.log('[tune-gradle] no android/ directory; nothing to do')
  process.exit(0)
}

let text = readFileSync(FILE, 'utf8')

/** Every ABI Android ships on. Anything less is not a distributable APK. */
const ALL_ABIS = 'armeabi-v7a,arm64-v8a,x86,x86_64'

const rules = release
  ? [
      [/^reactNativeArchitectures=.*$/m, `reactNativeArchitectures=${ALL_ABIS}`],
      [/^org\.gradle\.jvmargs=.*$/m, 'org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m'],
      [/^org\.gradle\.parallel=.*$/m, 'org.gradle.parallel=false'],
      [/^android\.enableMinifyInReleaseBuilds=.*$/m, 'android.enableMinifyInReleaseBuilds=true'],
      [
        /^android\.enableShrinkResourcesInReleaseBuilds=.*$/m,
        'android.enableShrinkResourcesInReleaseBuilds=true',
      ],
    ]
  : [
      [/^reactNativeArchitectures=.*$/m, 'reactNativeArchitectures=arm64-v8a'],
      [/^org\.gradle\.jvmargs=.*$/m, 'org.gradle.jvmargs=-Xmx3072m -XX:MaxMetaspaceSize=768m'],
      [/^org\.gradle\.parallel=.*$/m, 'org.gradle.parallel=false'],
      // Minification off for dev: it adds minutes to a build whose only reader
      // is a phone on the desk, and it obscures stack traces.
      [/^android\.enableMinifyInReleaseBuilds=.*$/m, 'android.enableMinifyInReleaseBuilds=false'],
      [
        /^android\.enableShrinkResourcesInReleaseBuilds=.*$/m,
        'android.enableShrinkResourcesInReleaseBuilds=false',
      ],
    ]

for (const [pattern, replacement] of rules) {
  text = pattern.test(text) ? text.replace(pattern, replacement) : `${text}\n${replacement}\n`
}

if (!text.includes('kotlin.compiler.execution.strategy')) {
  text += '\nkotlin.compiler.execution.strategy=in-process\n'
}

writeFileSync(FILE, text)

/*
 * R8 keep rules.
 *
 * Every one of these is a library that resolves classes reflectively or from
 * native code, where R8 cannot see the reference and strips the class — a
 * failure that appears only in a release build, at runtime, as a
 * ClassNotFoundException far from the cause. They are written unconditionally
 * (not only in release mode) because prebuild regenerates this file too, and a
 * rule that exists only when someone remembered a flag is a rule that will be
 * missing on the build that matters.
 */
const KEEP_MARKER = '# --- StackRead keep rules ---'
if (existsSync(PROGUARD)) {
  let pg = readFileSync(PROGUARD, 'utf8')
  if (!pg.includes(KEEP_MARKER)) {
    pg += `
${KEEP_MARKER}
# Reanimated/worklets: worklet bodies are invoked from the native runtime.
-keep class com.swmansion.reanimated.** { *; }
-keep class com.swmansion.worklets.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# gesture-handler: handlers are instantiated by name.
-keep class com.swmansion.gesturehandler.** { *; }

# react-native-pdf / pdfium: JNI entry points.
-keep class org.wonday.pdf.** { *; }
-keep class com.github.barteksc.** { *; }
-keep class com.shockwave.** { *; }

# MMKV (Nitro): the native module resolves these reflectively.
-keep class com.tencent.mmkv.** { *; }
-keep class com.margelo.nitro.** { *; }

# WebView JS bridge: the injected script calls these by name.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# React Native native modules in general.
-keep,includedescriptorclasses class com.facebook.react.bridge.** { *; }
-keepclassmembers class * { @com.facebook.react.uimanager.annotations.ReactProp <methods>; }
`
    writeFileSync(PROGUARD, pg)
    console.log('[tune-gradle] added R8 keep rules to proguard-rules.pro')
  }
}

console.log(
  release
    ? `[tune-gradle] RELEASE: all ABIs (${ALL_ABIS}), minify + shrink on`
    : '[tune-gradle] DEV: low-memory build settings (arm64-v8a only, no minify)',
)
