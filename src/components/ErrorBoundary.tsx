import { Component, type ErrorInfo, type ReactNode } from 'react'

import { noteError } from '../ui/crashLog'

/**
 * Contains a render error to the subtree below it.
 *
 * There was no boundary anywhere in the app, so any error thrown while rendering
 * — a malformed entry, a renderer edge case, a lazy chunk that failed to
 * evaluate — unmounted the root, and in a release build that exits the app
 * ([AUDIT4 A10](../../AUDIT4.md)).
 *
 * A class because React still offers no hook for this. Only render, lifecycle
 * and constructor errors are caught here; errors in effects' async work and in
 * event handlers reach the global handler in `ui/crashLog` instead.
 */

interface Props {
  /** Where this boundary sits, for the log line. */
  name: string
  children: ReactNode
  /** What to show instead. `reset` re-renders the children from scratch. */
  fallback: (error: Error, reset: () => void) => ReactNode
  /** Called once per caught error, after it is logged. */
  onError?: (error: Error) => void
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    noteError(error, `boundary:${this.props.name}`)
    if (__DEV__ && info.componentStack) console.error(info.componentStack)
    this.props.onError?.(error)
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (this.state.error) return this.props.fallback(this.state.error, this.reset)
    return this.props.children
  }
}
