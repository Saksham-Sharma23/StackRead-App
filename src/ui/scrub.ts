/**
 * Removes file paths and URIs from error text before it is logged or stored.
 *
 * Native file errors quote the path they failed on, and an imported file's
 * cached copy is named after the original document — so an error message can
 * carry a document title the app itself never logs ([AUDIT4 D6](../../AUDIT4.md)).
 * This record is what crash reporting will upload; it must not hold one.
 */
export function scrubPaths(text: string): string {
  return text
    .replace(/\b(?:file|content):\/\/[^\s'"`)]+/g, '<uri>')
    .replace(/\/(?:data|storage|sdcard|mnt)\/[^\s'"`)]+/g, '<path>')
}
