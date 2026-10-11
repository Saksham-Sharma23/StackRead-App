import { requireOptionalNativeModule, type NativeModule } from 'expo'

/**
 * Files handed to StackRead by other apps — "Open with" and "Share".
 *
 * `requireOptionalNativeModule` for the same reason as `pdf-text`: JS reaches a
 * device over Fast Refresh before a native rebuild does, and this is imported
 * at the app root. A missing module must mean "nothing arrives", never a
 * startup crash.
 */

export interface IncomingItem {
  /** Always `content://`; the module refuses anything else. */
  uri: string
  /** The type the sender declared for the whole intent, if specific. */
  mime: string | null
}

export interface IncomingMeta {
  name: string | null
  size: number | null
  mime: string | null
}

type Events = { onIncoming: (event: { count: number }) => void }

declare class IncomingFilesNative extends NativeModule<Events> {
  takePending(): IncomingItem[]
  describe(uri: string): Promise<IncomingMeta>
  copyTo(uri: string, destination: string): Promise<number>
}

const native = requireOptionalNativeModule<IncomingFilesNative>('IncomingFiles')

/** Whether this build has the module (false on a dev client that predates it). */
export function isAvailable(): boolean {
  return native !== null
}

/** Everything received and not yet taken, oldest first. */
export function takePending(): IncomingItem[] {
  return native?.takePending() ?? []
}

/** The sender's name, size and type for a received file. */
export function describe(uri: string): Promise<IncomingMeta> {
  if (!native) return Promise.resolve({ name: null, size: null, mime: null })
  return native.describe(uri)
}

/**
 * Copies a received file to `destination` (inside the app's files directory)
 * on a background thread; resolves to the bytes written.
 */
export function copyTo(uri: string, destination: string): Promise<number> {
  if (!native) return Promise.reject(new Error('Receiving files needs a newer app build'))
  return native.copyTo(uri, destination)
}

/** Called when a file arrives while the app is running. Returns an unsubscribe. */
export function onIncoming(listener: () => void): () => void {
  if (!native) return () => {}
  const subscription = native.addListener('onIncoming', listener)
  return () => subscription.remove()
}
