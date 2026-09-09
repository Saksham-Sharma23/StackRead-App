import { useEffect } from 'react'

import { setStatusBarHidden } from 'expo-status-bar'

/**
 * Immersive reading: hides the system bars so the document owns the screen.
 *
 * Controlled rather than self-managing. The reader already tracks whether its
 * own chrome is showing, and immersive mode is the same intent applied to the
 * system's chrome — so the caller owns the state and this hook only mirrors it
 * onto the platform. Keeping a second copy here would let the two drift.
 *
 * Two halves, because they have different costs:
 *
 * This app runs edge-to-edge (`edgeToEdgeEnabled=true`, both bars transparent),
 * and that changes what actually works:
 *
 *  - `setStatusBarHidden` from `expo-status-bar` is a **no-op** here. Android
 *    logs `StatusBarModule: Ignored status bar change, current activity is
 *    edge-to-edge` and nothing happens. It is still called for the non-edge-to-
 *    edge case, but it cannot be relied on.
 *  - `expo-navigation-bar`'s `setVisibilityAsync` drives the platform's
 *    `WindowInsetsController`, which hides **both** bars under edge-to-edge.
 *    That is what makes immersive mode real rather than cosmetic.
 *
 * The import stays lazy and guarded so a build without the native module
 * degrades to "insets collapse, bars stay" instead of crashing.
 */

type NavBarModule = {
  setVisibilityAsync: (v: 'visible' | 'hidden') => Promise<void>
  setBehaviorAsync?: (b: 'inset-swipe' | 'overlay-swipe' | 'inset-touch') => Promise<void>
}

let navBar: NavBarModule | null | undefined

/** Resolves the native module once; `null` means "not installed". */
async function loadNavBar(): Promise<NavBarModule | null> {
  if (navBar !== undefined) return navBar
  try {
    navBar = (await import('expo-navigation-bar')) as unknown as NavBarModule
  } catch {
    navBar = null
  }
  return navBar
}

async function applyNavBar(hidden: boolean): Promise<void> {
  const mod = await loadNavBar()
  if (!mod) return
  try {
    if (hidden) {
      // `overlay-swipe`: a swipe from the edge shows the bar transiently over
      // the content and it hides itself again — so the reader is never pushed
      // around, and fullscreen survives an accidental swipe.
      await mod.setBehaviorAsync?.('overlay-swipe')
    }
    await mod.setVisibilityAsync(hidden ? 'hidden' : 'visible')
  } catch {
    // Never let a system-UI call break reading.
  }
}

export function useFullscreen(hidden: boolean): void {
  useEffect(() => {
    setStatusBarHidden(hidden, 'fade')
    void applyNavBar(hidden)
  }, [hidden])

  /**
   * Always restore on unmount. Without this, leaving the reader while immersive
   * would hand the library a screen with no status or navigation bar.
   */
  useEffect(() => {
    return () => {
      setStatusBarHidden(false, 'fade')
      void applyNavBar(false)
    }
  }, [])
}
