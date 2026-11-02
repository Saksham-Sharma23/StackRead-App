import type { ComponentType, ReactNode } from 'react'
import type { TextStyle, ViewStyle } from 'react-native'
import type { SharedValue } from 'react-native-reanimated'

import type { FileEntry, Group } from '../types'
import type { OpenRect } from '../ui/openTransition'
import type { Theme } from '../ui/theme'
import type { LookTheme } from './appearance'
import type { ActionSheetProps } from '../components/ActionSheet'
import type { LibrarySearchProps } from '../components/LibrarySearch'
import type { GroupSheetProps, JumpSheetProps } from './sheets'
import { groupColorIndex } from './appearance'

/**
 * What a look supplies to draw the board and the reader's chrome.
 *
 * Classic has no skin: when a screen gets `undefined` here it renders exactly
 * what it rendered before looks existed. Every component a skin provides is
 * presentation only — the screens keep owning state, gestures and actions, and
 * hand the skin finished callbacks.
 */

export interface LookCardProps {
  fileId: string
  /** Position in the group, 0-based. */
  index: number
  theme: Theme
  onOpen: (file: FileEntry, rect?: OpenRect) => void
  onMenu: (file: FileEntry) => void
}

export interface GroupHeaderProps {
  group: Group
  count: number
  theme: Theme
  /** The title, already wired for tap-to-rename by GroupRow and styled with `groupTitle`. */
  title: ReactNode
  onMenu: () => void
}

export interface BoardHeaderProps {
  theme: Theme
  fileCount: number
  groupCount: number
  onMenu: () => void
}

export interface EmptyBoardProps {
  theme: Theme
  onAddFiles: () => void
  /** Opens the New group sheet, which offers folder and ZIP import. */
  onImport: () => void
}

export interface ReaderTopProps {
  theme: Theme
  insetTop: number
  file: FileEntry
  groupId: string
  groupTitle: string
  index: number
  count: number
  onBack: () => void
  onFile: () => void
  onGroup: () => void
  onMenu: () => void
}

export interface ReaderBottomProps {
  theme: Theme
  insetBottom: number
  files: FileEntry[]
  index: number
  fileId: string
  /** The pager's live position (a fractional index), so the bar follows a swipe in progress. */
  swipe: SharedValue<number>
}

/**
 * A look's type, by role. The shared layout (layout.tsx) and the shared sheets
 * draw everything with these, so a look is its fonts, its corners and its
 * theme's colours — nothing else.
 */
export interface LookFonts {
  /** The wordmark. */
  display: TextStyle
  /** Group names, card titles, sheet titles. */
  title: TextStyle
  /** Buttons and the reader's file title. */
  strong: TextStyle
  /** Running text: snippets, descriptions, list rows. */
  body: TextStyle
  /** Labels a step above body: group name in the reader, New group. */
  medium: TextStyle
  /** Numbers, sizes, counts. */
  meta: TextStyle
  metaStrong: TextStyle
}

export interface Skin {
  fonts: LookFonts
  /** Wraps the board header (title, empty state, search). */
  headerStyle: ViewStyle
  BoardHeader: ComponentType<BoardHeaderProps>
  Empty: ComponentType<EmptyBoardProps>
  GroupHeader: ComponentType<GroupHeaderProps>
  groupTitle: (theme: Theme) => TextStyle
  rowStyle?: ViewStyle
  stripStyle?: ViewStyle
  /** Must keep the card slot today's drag maths assumes: 132 wide plus a 12 gap. */
  Card: ComponentType<LookCardProps>
  AddTile: ComponentType<{ theme: Theme; onPress: () => void }>
  NewGroup: ComponentType<{ theme: Theme; onPress: () => void }>
  ReaderTop: ComponentType<ReaderTopProps>
  ReaderBottom: ComponentType<ReaderBottomProps>

  // Shared sheets (looks/sheets.tsx), reached through the skin so that they —
  // and react-native-svg behind them — load with the look, not at startup.
  Sheet: ComponentType<ActionSheetProps>
  JumpSheet: ComponentType<JumpSheetProps>
  GroupSheet: ComponentType<GroupSheetProps>
  DisplaySheet: ComponentType<{ visible: boolean; theme: Theme; onClose: () => void }>
  Search: ComponentType<LibrarySearchProps>
  /** The look's corner radius for cards, buttons, fields and panels. */
  corner: number
}

/**
 * The theme's look-only roles. Non-Classic looks always draw with a palette
 * theme (looks/appearance.ts), so these are always present when a skin runs.
 */
export function ext(theme: Theme): LookTheme['ext'] {
  return (theme as LookTheme).ext
}

/** A group's colour in the current theme, from its id. */
export function groupTint(theme: Theme, groupId: string): string {
  const e = ext(theme)
  return e ? e.groups[groupColorIndex(groupId)] : theme.accent
}

/** One face per family name: Android must not synthesise weight or slant on top. */
export const face = (fontFamily: string): TextStyle => ({ fontFamily, fontWeight: 'normal', fontStyle: 'normal' })
