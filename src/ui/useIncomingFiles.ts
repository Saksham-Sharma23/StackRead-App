import { useEffect, useRef, useState } from 'react'
import { Alert } from 'react-native'

import * as Incoming from '../../modules/incoming-files/src'
import { receiveFiles, type ReceiveResult } from '../storage/incoming'
import type { FileEntry } from '../types'

/**
 * Receives files from "Open with" and "Share", and opens the first.
 *
 * Waits for `enabled` — the library having loaded — because an import into a
 * library that has not loaded yet would be written over by the load, and
 * duplicate detection needs the files that are already there. A cold start's
 * file waits in the native queue until then; a warm one arrives as an event.
 *
 * Drains are chained, never concurrent: two shares in quick succession must
 * not both create the inbox group or interleave their order numbers.
 *
 * Returns a label while a copy is in progress, for the app's busy overlay.
 */
export function useIncomingFiles(
  enabled: boolean,
  open: (file: FileEntry) => void | Promise<void>,
): string | null {
  const [busy, setBusy] = useState<string | null>(null)
  const openRef = useRef(open)
  openRef.current = open

  useEffect(() => {
    if (!enabled || !Incoming.isAvailable()) return
    let chain = Promise.resolve()

    const drain = () => {
      chain = chain.then(async () => {
        const items = Incoming.takePending()
        if (!items.length) return
        setBusy(items.length === 1 ? 'Opening file…' : `Adding ${items.length} files…`)
        let result: ReceiveResult
        try {
          result = await receiveFiles(items)
        } finally {
          setBusy(null)
        }
        report(result)
        if (result.open) await openRef.current(result.open)
      })
      // A failed drain must not poison the chain for every later arrival.
      chain = chain.catch((err) => console.warn('[stackread] receiving files failed', __DEV__ ? err : undefined))
    }

    drain()
    const unsubscribe = Incoming.onIncoming(drain)
    return unsubscribe
  }, [enabled])

  return busy
}

/** Says what could not be received. Silence when everything arrived. */
function report({ open, unsupported, failed }: ReceiveResult): void {
  const list = (names: string[]) => names.slice(0, 5).join('\n') + (names.length > 5 ? '\n…' : '')
  if (unsupported.length) {
    Alert.alert(
      unsupported.length === 1 ? 'Can’t open this file' : 'Some files can’t be opened',
      `StackRead doesn’t support ${unsupported.length === 1 ? 'this type' : 'these types'}:\n\n${list(unsupported)}`,
    )
  }
  if (failed.length) {
    Alert.alert(
      failed.length === 1 && !open ? 'Couldn’t add the file' : 'Some files couldn’t be added',
      `${list(failed)}\n\nThe sending app may no longer allow access, or the device may be short of space.`,
    )
  }
}
