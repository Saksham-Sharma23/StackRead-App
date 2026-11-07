import { useEffect, useSyncExternalStore } from 'react'
import { InteractionManager, TurboModuleRegistry } from 'react-native'

import type * as IconModuleTypes from '../looks/Icon'

/**
 * Loads the SVG icon set (`looks/Icon.tsx`) for Classic, without paying for it
 * at launch and without breaking a build that lacks it.
 *
 * ## Two constraints
 *
 *  - **Startup.** `react-native-svg` is kept out of the startup graph on
 *    purpose (`startupBundle.test.ts`): Classic users must not pay for it before
 *    the board paints. So the board starts with its text glyphs and the icons
 *    load after the first interactions settle — the swap is inside a fixed-size
 *    box (`GlyphIcon`), so nothing moves when it happens. The reader and the
 *    Appearance screen are lazy chunks, opened later, and load it at once.
 *  - **Old builds.** `react-native-svg` is a native module, and a dev client
 *    built before it was added has none: importing it there throws. The build
 *    is asked first (`RNSVGSvgViewModule`, the module it registers), and the
 *    text glyphs stay if it is absent. Classic keeps working on any binary.
 *
 * A `require` inside a function, not an `import`: Metro's `inlineRequires` is
 * off, so this is the explicit form of a deferred load — the same pattern
 * `looks/registry.ts` uses for the looks themselves.
 */

type IconModule = typeof IconModuleTypes

let icons: IconModule | null = null
let state: 'idle' | 'scheduled' | 'done' = 'idle'
const listeners = new Set<() => void>()

/** Whether this app build contains react-native-svg's native side. */
export function svgInBuild(): boolean {
  try {
    return TurboModuleRegistry.get('RNSVGSvgViewModule') != null
  } catch {
    return false
  }
}

function settle(): void {
  state = 'done'
  for (const listener of listeners) listener()
}

/** Loads the icon set now. For screens that open after launch. */
export function loadIconsNow(): void {
  if (state === 'done') return
  if (svgInBuild()) {
    try {
      icons = require('../looks/Icon') as IconModule
    } catch {
      icons = null
    }
  }
  settle()
}

/** Loads the icon set once the app is idle. For anything on the board. */
function loadIconsWhenIdle(): void {
  if (state !== 'idle') return
  state = 'scheduled'
  void InteractionManager.runAfterInteractions(() => {
    if (state === 'scheduled') loadIconsNow()
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const snapshot = () => icons

/**
 * The icon module, or null while it loads or when this build has none.
 *
 * The snapshot is the module object itself, which never changes once loaded,
 * so this is a stable value for React (CLAUDE.md §5.1).
 */
export function useIcons(): IconModule | null {
  const mod = useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => {
    if (!mod) loadIconsWhenIdle()
  }, [mod])
  return mod
}
