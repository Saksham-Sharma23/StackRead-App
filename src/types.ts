/**
 * Data model, ported from the desktop app.
 *
 * One deliberate deviation: desktop stores `storedPath` as an absolute path.
 * On Android an absolute path into app storage is *not* stable — it differs
 * per device and per user profile, and would break any backup/restore. So we
 * store `storedName` (the basename, e.g. `V1StGXR8_Z5j.pdf`) and resolve it
 * against the library directory at read time. Everything else is identical, so
 * a desktop <-> phone import remains a one-field mapping.
 */

export type FileFormat =
  | 'pdf'
  | 'epub'
  | 'image'
  | 'text'
  | 'markdown'
  | 'docx'
  | 'xlsx'
  | 'csv'
  | 'html'
  | 'comic'
  | 'archive'

export interface FileEntry {
  id: string
  /** Original filename, for display. */
  name: string
  /** Basename inside the library dir, e.g. `<id>.pdf`. Resolve with `fileUri()`. */
  storedName: string
  format: FileFormat
  /** Logical group membership. Never a folder — moving groups is a one-field change. */
  groupId: string
  /** Horizontal position within the group. */
  orderInGroup: number
  /**
   * Remembered reading position. **MMKV is the live source of truth.**
   *
   * Written only when the library is exported, which is the one moment the
   * position has to leave MMKV: an archive carries `library.json` and the file
   * bytes, and MMKV is in neither. Without this, restoring a backup on a new
   * phone reopened every book at page one — silent loss on a path the user is
   * told round-trips everything.
   *
   * Not written on every scroll, deliberately. That is what MMKV is for: it is
   * synchronous and JSI-backed, so it absorbs a write per scroll settle, while
   * the index is debounced, diffed and journalled. Mirroring hot state into it
   * would put a row write on the scroll path — the exact split
   * [store/scroll](store/scroll.ts) exists to maintain.
   *
   * Units follow the renderer: a page number for PDF, a pixel offset for the
   * WebView. That is the same value `getScroll` holds, deliberately — this is a
   * transport copy of it, not a second representation to keep in sync.
   */
  lastScroll?: number
  /**
   * Remembered reading progress, 0..100. Written with `lastScroll`, on export.
   *
   * Carried separately rather than recomputed on restore because progress comes
   * from the renderer's own geometry — for a reflowable book, nothing on the
   * receiving device can derive it from a scroll offset without laying the
   * whole document out first.
   */
  lastProgress?: number
  /** Basename of the generated preview, if one exists. Never a data URL. */
  thumb?: string
  /**
   * Base64 ThumbHash of the preview — a ~25-byte blurred stand-in.
   *
   * Small enough to live in the index, so it is available before any image is
   * read from disk: the card paints a plausible cover on its first frame rather
   * than an empty rectangle, then swaps to `thumb` when that decodes. Optional
   * because entries written before this field existed do not carry it, and
   * because not every file yields one.
   */
  thumbhash?: string
  /**
   * Size of the stored copy in bytes.
   *
   * Optional because entries written before this field existed do not carry it;
   * readers fall back to reading the file. Recorded at import rather than read
   * on demand because the bytes never change afterwards — the library owns its
   * copy, so a stat per render would be pure waste.
   */
  size?: number
  addedAt: number
}

export interface Group {
  id: string
  title: string
  /** Vertical position on the board. */
  order: number
}

export interface Library {
  groups: Group[]
  files: FileEntry[]
}

export const EMPTY_LIBRARY: Library = { groups: [], files: [] }
