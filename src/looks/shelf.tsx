import { makeLayout } from './layout'
import { face } from './skin'

/**
 * SHELF — Instrument Serif for headings, DM Sans for everything else; softly
 * rounded corners. Home theme: Ember. The layout is the shared one
 * (layout.tsx).
 *
 * Instrument Serif is a display face with a small x-height: at Geist's sizes it
 * reads about a sixth smaller, so headings are scaled up to match.
 */
export const shelfSkin = makeLayout({
  fonts: {
    display: face('InstrumentSerif-Italic'),
    title: face('InstrumentSerif-Regular'),
    strong: face('DMSans-SemiBold'),
    body: face('DMSans-Regular'),
    medium: face('DMSans-Medium'),
    meta: face('DMSans-Medium'),
    metaStrong: face('DMSans-SemiBold'),
  },
  corner: 12,
  headingScale: 1.18,
})
