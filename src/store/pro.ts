import { create } from 'zustand'

import { storage } from '../storage/mmkv'

/**
 * Whether the user has Pro.
 *
 * **Placeholder until billing exists (TASKS3 L9).** Today the only way to be Pro
 * is a developer switch, and it is honoured in `__DEV__` builds only, so a
 * release build is always Classic no matter what was stored. L9 replaces the
 * source of truth with the store entitlement (RevenueCat, cached in MMKV for
 * offline use) and keeps the dev switch dev-only.
 */

const DEV_KEY = 'pro:dev'

interface ProState {
  devPro: boolean
  setDevPro: (on: boolean) => void
}

export const useProStore = create<ProState>((set) => ({
  devPro: __DEV__ && storage.getBoolean(DEV_KEY) === true,
  setDevPro: (on) => {
    if (!__DEV__) return
    storage.set(DEV_KEY, on)
    set({ devPro: on })
  },
}))

/**
 * The paywall is **off** while the looks are being built: every look and theme
 * is open to everyone, in every build. Turning it on (TASKS3 L9) is this one
 * flag — the resolution logic and its tests are already in place.
 */
export const PAYWALL_ENABLED = false

/** True when Pro features should be available. */
export function useIsPro(): boolean {
  const devPro = useProStore((s) => s.devPro)
  return !PAYWALL_ENABLED || (__DEV__ && devPro)
}
