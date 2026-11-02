import { makeLayout } from './layout'
import { face } from './skin'

/**
 * NOTEBOOK — Fraunces for headings, Literata for text, IBM Plex Mono for
 * numbers; nearly square corners. Home theme: Paper. The layout is the shared
 * one (layout.tsx).
 */
export const notebookSkin = makeLayout({
  fonts: {
    display: face('Fraunces-SemiBoldItalic'),
    title: face('Fraunces-SemiBold'),
    strong: face('Fraunces-SemiBold'),
    body: face('Literata-Regular'),
    medium: face('Literata-SemiBold'),
    meta: face('IBMPlexMono-Regular'),
    metaStrong: face('IBMPlexMono-Medium'),
  },
  corner: 3,
})
