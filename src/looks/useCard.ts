import { useCallback, useRef } from 'react'
import type { View } from 'react-native'
import { useMMKVNumber } from 'react-native-mmkv'

import type { FileEntry } from '../types'
import type { OpenRect } from '../ui/openTransition'
import { badgeOf, formatBytes } from '../storage/formats'
import { progressKey, storage } from '../storage/mmkv'
import { useFileEntry } from '../store/selectors'
import { useThumbnail } from '../components/useThumbnail'
import { useSnippet } from '../components/useSnippet'
import { cleanTitle } from './text'

/**
 * Everything a look's card needs to know about its file, gathered the same way
 * FileCard gathers it — by id, from the store and MMKV — so a look card costs
 * the same as a Classic one and behaves identically: same thumbnail generation,
 * same snippet, same live progress, same measured open transition.
 */

// See FileCard's MISSING: lets every hook run for the one frame after a removal.
const MISSING: FileEntry = { id: '', name: '', storedName: '', format: 'pdf', groupId: '', orderInGroup: 0, addedAt: 0 }

export function useCard(fileId: string, onOpen: (file: FileEntry, rect?: OpenRect) => void) {
  const entry = useFileEntry(fileId)
  const file = entry ?? MISSING
  useThumbnail(file)
  const snippet = useSnippet(file)
  const [stored] = useMMKVNumber(progressKey(file.id), storage)
  const progress = Math.max(0, Math.min(100, stored ?? 0))
  const ref = useRef<View>(null)

  const open = useCallback(() => {
    const node = ref.current
    if (!node) {
      onOpen(file)
      return
    }
    node.measureInWindow((x, y, width, height) => onOpen(file, { x, y, width, height }))
  }, [file, onOpen])

  return {
    entry,
    file,
    snippet,
    /** 0..100 */
    progress,
    ref,
    open,
    title: cleanTitle(file.name),
    format: badgeOf(file.name).label,
    size: file.size ? formatBytes(file.size) : '',
  }
}
