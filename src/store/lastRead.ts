import { create } from 'zustand'

/**
 * The file the reader was last showing, and when the reader was closed.
 *
 * The reader keeps `id` current as you swipe between files; closing stamps
 * `returnedAt`. A look's card for that file sees both when the board comes
 * back and briefly rings itself, so you can see where you were. Not persisted:
 * it only means anything for the second after a close.
 */
interface LastRead {
  id: string | null
  returnedAt: number
  setCurrent: (id: string) => void
  markReturn: () => void
}

export const useLastRead = create<LastRead>((set) => ({
  id: null,
  returnedAt: 0,
  setCurrent: (id) => set({ id }),
  markReturn: () => set({ returnedAt: Date.now() }),
}))
