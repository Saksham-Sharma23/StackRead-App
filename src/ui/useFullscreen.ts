import { useEffect } from 'react'

import { StatusBar } from 'expo-status-bar'

/**
 * Immersive reading: hides the system bars so the document owns the screen.
 *
 * Controlled rather than self-managing. The reader already tracks whether its
 * own chrome is showing, and immersive mode is the same intent applied to the
 * system's chrome — so the caller owns the state and this hook only mirrors it
 * onto the platform. Keeping a second copy here would let the two drift.
 *
 * ## The two calls, on SDK 57's supported APIs
 *
 *  - **Navigation bar:** `NavigationBar.setHidden` from `expo-navigation-bar`.
 *    It drives the platform's `WindowInsetsController` and sets
 *    `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` itself, so a swipe from the edge
 *    shows the bar over the content and it hides again — the reader is never
 *    pushed around, and fullscreen survives an accidental swipe.
 *  - **Status bar:** `StatusBar.setHidden` from `expo-status-bar`.
 *
 * These replace `setVisibilityAsync` + `setBehaviorAsync` and
 * `setStatusBarHidden`, all deprecated in SDK 57 (`setBehaviorAsync` was
 * already gone — its optional call did nothing). The native calls underneath
 * are the same ones the deprecated wrappers made, so behaviour is unchanged;
 * what changes is that the next SDK upgrade cannot remove them from under us.
 *
 * The navigation-bar import stays lazy and guarded: its module requires a
 * native module, and a build without it should degrade to "the bar stays",
 * never to a reader that cannot load.
 */

type NavBarModule = {
  NavigationBar: { setHidden: (hidden: boolean) => void }
}

let navBar: NavBarModule | null | undefined

/** Resolves the module once; `null` means "not installed". */
async function loadNavBar(): Promise<NavBarModule | null> {
  if (navBar !== undefined) return navBar
  try {
    const mod = (await import('expo-navigation-bar')) as unknown as Partial<NavBarModule>
    navBar = typeof mod.NavigationBar?.setHidden === 'function' ? (mod as NavBarModule) : null
  } catch {
    navBar = null
  }
  return navBar
}

async function applyNavBar(hidden: boolean): Promise<void> {
  const mod = await loadNavBar()
  if (!mod) return
  try {
    mod.NavigationBar.setHidden(hidden)
  } catch {
    // Never let a system-UI call break reading.
  }
}

function applyStatusBar(hidden: boolean): void {
  try {
    StatusBar.setHidden(hidden, 'fade')
  } catch {
    // Same: system UI is never worth an error in the reader.
  }
}

export function useFullscreen(hidden: boolean): void {
  useEffect(() => {
    applyStatusBar(hidden)
    void applyNavBar(hidden)
  }, [hidden])

  /**
   * Always restore on unmount. Without this, leaving the reader while immersive
   * would hand the library a screen with no status or navigation bar.
   */
  useEffect(() => {
    return () => {
      applyStatusBar(false)
      void applyNavBar(false)
    }
  }, [])
}
