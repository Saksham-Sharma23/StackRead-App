import { makeLayout } from './layout'
import { face } from './skin'

/**
 * MODERN — Geist and Geist Mono, soft corners. Follows the phone between
 * Daylight and Midnight. The layout is the shared one (layout.tsx).
 */
export const modernSkin = makeLayout({
  fonts: {
    display: face('Geist-SemiBold'),
    title: face('Geist-SemiBold'),
    strong: face('Geist-SemiBold'),
    body: face('Geist-Regular'),
    medium: face('Geist-Medium'),
    meta: face('GeistMono-Regular'),
    metaStrong: face('GeistMono-Medium'),
  },
  corner: 14,
})
