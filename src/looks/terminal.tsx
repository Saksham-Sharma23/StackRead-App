import { makeLayout } from './layout'
import { face } from './skin'

/**
 * TERMINAL — JetBrains Mono throughout; square corners. Home theme: Terminal.
 * The layout is the shared one (layout.tsx).
 *
 * A monospace face is wide, so headings are scaled down a little to keep card
 * titles to the same number of lines as the other looks.
 */
export const terminalSkin = makeLayout({
  fonts: {
    display: face('JetBrainsMono-Bold'),
    title: face('JetBrainsMono-Bold'),
    strong: face('JetBrainsMono-Bold'),
    body: face('JetBrainsMono-Regular'),
    medium: face('JetBrainsMono-Medium'),
    meta: face('JetBrainsMono-Regular'),
    metaStrong: face('JetBrainsMono-Medium'),
  },
  corner: 2,
  headingScale: 0.9,
})
