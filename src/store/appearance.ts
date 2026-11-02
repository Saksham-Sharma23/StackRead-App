import { useMemo } from 'react'
import { create } from 'zustand'

import { storage } from '../storage/mmkv'
import {
  CLASSIC,
  DEFAULT_APPEARANCE,
  resolveAppearance,
  sanitizeAppearance,
  type ResolvedAppearance,
  type StoredAppearance,
} from '../looks/appearance'
import { useIsPro } from './pro'

/**
 * The user's look and colour theme choices, persisted app-wide in MMKV beside
 * the reader settings.
 *
 * This stores what the user *chose*. What actually gets drawn comes from
 * `useResolvedAppearance`, which falls back to Classic without Pro — see
 * looks/appearance.ts for why the two are kept apart.
 */

const KEY = 'appearance'

function load(): StoredAppearance {
  try {
    const raw = storage.getString(KEY)
    return raw ? sanitizeAppearance(JSON.parse(raw)) : { ...DEFAULT_APPEARANCE }
  } catch {
    return { ...DEFAULT_APPEARANCE }
  }
}

interface AppearanceState extends StoredAppearance {
  set: <K extends keyof StoredAppearance>(key: K, value: StoredAppearance[K]) => void
  reset: () => void
}

const persisted = (s: StoredAppearance): StoredAppearance => ({
  look: s.look,
  theme: s.theme,
  followSystem: s.followSystem,
  lightTheme: s.lightTheme,
  darkTheme: s.darkTheme,
  readingFont: s.readingFont,
})

export const useAppearance = create<AppearanceState>((setState, get) => ({
  ...load(),
  set: (key, value) =>
    setState(() => {
      const next = { ...persisted(get()), [key]: value }
      storage.set(KEY, JSON.stringify(next))
      return next as Partial<AppearanceState>
    }),
  reset: () =>
    setState(() => {
      storage.set(KEY, JSON.stringify(DEFAULT_APPEARANCE))
      return { ...DEFAULT_APPEARANCE }
    }),
}))

/**
 * What to draw with right now.
 *
 * Each field is selected separately and is a primitive, so these selectors can
 * never hand Zustand a fresh object (CLAUDE.md §5.1). The result is memoised on
 * those primitives, and Classic always resolves to the one shared `CLASSIC`
 * object.
 */
export function useResolvedAppearance(systemDark: boolean): ResolvedAppearance {
  const isPro = useIsPro()
  const look = useAppearance((s) => s.look)
  const theme = useAppearance((s) => s.theme)
  const followSystem = useAppearance((s) => s.followSystem)
  const lightTheme = useAppearance((s) => s.lightTheme)
  const darkTheme = useAppearance((s) => s.darkTheme)
  return useMemo(() => {
    if (!isPro || look === 'classic') return CLASSIC
    return resolveAppearance(
      { look, theme, followSystem, lightTheme, darkTheme, readingFont: 'default' },
      isPro,
      systemDark,
    )
  }, [isPro, look, theme, followSystem, lightTheme, darkTheme, systemDark])
}
