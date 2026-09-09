/**
 * Declarations for untyped or subpath dependency entrypoints.
 *
 * The desktop project kept the equivalent in `vite-env.d.ts` and its notes are
 * explicit that a new untyped dep belongs here rather than as an `any` cast at
 * the call site — so the missing surface stays visible in one place.
 */

declare module 'mammoth/mammoth.browser' {
  interface ConvertResult {
    value: string
    messages: { type: string; message: string }[]
  }
  export function convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<ConvertResult>
  export function extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<ConvertResult>
}
