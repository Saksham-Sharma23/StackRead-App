import { create } from 'zustand'

import { storage } from '../storage/mmkv'

/**
 * Typography and theme for the reader, ReadEra-style.
 *
 * Persisted app-wide rather than per file: a reader picks a comfortable size
 * once and expects every book to honour it.
 *
 * Applied as CSS custom properties on the viewer root, so changing a value
 * restyles instantly without re-parsing or re-sending the document.
 */

export type ReaderTheme = 'system' | 'light' | 'sepia' | 'dark' | 'black'

export interface ReaderSettings {
  /** Base font size in px. */
  fontSize: number
  /** Unitless line-height multiplier. */
  lineHeight: number
  /** Horizontal page margin in px. */
  margin: number
  theme: ReaderTheme
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 17,
  lineHeight: 1.65,
  margin: 22,
  theme: 'system',
}

export const FONT_SIZE_RANGE = { min: 12, max: 30, step: 1 }
export const LINE_HEIGHT_RANGE = { min: 1.2, max: 2.4, step: 0.1 }
export const MARGIN_RANGE = { min: 0, max: 56, step: 8 }

const KEY = 'readerSettings'

function load(): ReaderSettings {
  try {
    const raw = storage.getString(KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<ReaderSettings>
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

interface ReaderSettingsState extends ReaderSettings {
  set: <K extends keyof ReaderSettings>(key: K, value: ReaderSettings[K]) => void
  reset: () => void
}

export const useReaderSettings = create<ReaderSettingsState>((setState, get) => ({
  ...load(),

  set: (key, value) =>
    setState(() => {
      const next = { ...current(get()), [key]: value }
      storage.set(KEY, JSON.stringify(next))
      return next as Partial<ReaderSettingsState>
    }),

  reset: () =>
    setState(() => {
      storage.set(KEY, JSON.stringify(DEFAULT_SETTINGS))
      return { ...DEFAULT_SETTINGS }
    }),
}))

/** The persisted slice, without the actions. */
function current(s: ReaderSettingsState): ReaderSettings {
  return {
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    margin: s.margin,
    theme: s.theme,
  }
}

/** Clamps a value to a range and its step, for the +/- controls. */
export function stepValue(
  value: number,
  delta: number,
  range: { min: number; max: number; step: number },
): number {
  const next = Math.round((value + delta * range.step) * 100) / 100
  return Math.min(range.max, Math.max(range.min, next))
}
