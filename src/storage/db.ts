import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite'

import type { FileEntry, Library } from '../types'
import type { LibraryDiff } from './libraryDiff'

/**
 * The library index, as a SQLite database.
 *
 * ## What this replaced, and why
 *
 * `library.json`: one blob holding every group and every file, re-serialised
 * and rewritten in full on every mutation — twice, because a hand-rolled `.bak`
 * copy was the only crash protection available. At a few thousand files that is
 * megabytes of `JSON.stringify` on the JS thread inside a 400ms debounce.
 *
 * Three things come from moving it here:
 *
 *  - **Row-level writes.** Renaming a group writes one row instead of the
 *    library. What actually changed is worked out by
 *    [libraryDiff.ts](libraryDiff.ts), which is pure and tested.
 *  - **Real crash safety.** WAL gives atomic, journalled commits. That retires
 *    the `.bak` copy *and* the `moveSync` workaround it existed to replace —
 *    `moveSync` on Android throws `NoSuchFileException` on the destination even
 *    when it has just been created, which is why temp-then-rename was never
 *    available here ([DETAIL.md §6.3](../../DETAIL.md)).
 *
 * There is deliberately **no per-group query API**, though the plan called for
 * one. The whole library is read once at startup and held in a normalized store
 * whose membership lookup is already O(1), so a `SELECT ... WHERE groupId = ?`
 * per row would cross into native code to answer something the map in memory
 * answers for free. The index below is still worth its keep — it serves the
 * ordering of the one full read.
 *
 * ## What this file is deliberately *not*
 *
 * It holds no policy. It opens the database, maps rows to `FileEntry`, and
 * applies a diff someone else computed. Every decision about what to write —
 * and especially what to delete — lives in the pure module next to it, where it
 * can be tested without a device. That split is on purpose: this is the
 * subsystem where a silent failure once deleted users' files, and the half of
 * it that cannot be tested should be the half with no decisions in it.
 *
 * ## Threading
 *
 * The synchronous API, on the JS thread, deliberately. A write is a handful of
 * small rows inside one transaction — far cheaper than the `JSON.stringify` it
 * replaces — and the alternative is making persistence async, which would mean
 * the flush on backgrounding could no longer be guaranteed to complete before
 * the process dies. Correctness on that path is worth more than the microseconds.
 */

/**
 * Schema version, for future migrations.
 *
 * Stored in `meta` rather than inferred from the tables present, so a migration
 * can be written against a known starting point instead of guessing.
 */
const SCHEMA_VERSION = 3

/**
 * Marks that the one-time import from `library.json` has been considered.
 *
 * **This flag, not "are there any rows", is what gates the import.** Using an
 * empty table as the trigger would mean a user who deletes every file gets the
 * entire old library resurrected from a stale JSON file on next launch — a
 * silent, confusing un-delete. The flag is set even when there was nothing to
 * import, so the question is asked exactly once per install.
 */
const MIGRATED_KEY = 'migratedFromJson'

let db: SQLiteDatabase | null = null

/** Row shape as stored. `null` rather than `undefined`, which is what SQLite returns. */
interface FileRow {
  id: string
  name: string
  storedName: string
  format: string
  groupId: string
  orderInGroup: number
  lastScroll: number | null
  lastProgress: number | null
  thumb: string | null
  thumbhash: string | null
  size: number | null
  addedAt: number
}

interface GroupRow {
  id: string
  title: string
  sortOrder: number
}

/**
 * Opens the database and creates the schema, once per process.
 *
 * `journal_mode = WAL` is the whole point of the move and is set before
 * anything else touches the file. It is persistent — stored in the database
 * header rather than per connection — but setting it every open costs nothing
 * and means a database restored from a backup is never left in rollback mode.
 */
export function getDb(): SQLiteDatabase {
  if (db) return db

  const opened = openDatabaseSync('stackread.db')

  opened.execSync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = OFF;

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
      id        TEXT PRIMARY KEY NOT NULL,
      title     TEXT NOT NULL,
      sortOrder INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      id           TEXT PRIMARY KEY NOT NULL,
      name         TEXT NOT NULL,
      storedName   TEXT NOT NULL,
      format       TEXT NOT NULL,
      groupId      TEXT NOT NULL,
      orderInGroup INTEGER NOT NULL,
      lastScroll   REAL,
      lastProgress REAL,
      thumb        TEXT,
      thumbhash    TEXT,
      size         INTEGER,
      addedAt      INTEGER NOT NULL
    );

    -- Membership becomes a range scan rather than a filter over every file.
    CREATE INDEX IF NOT EXISTS files_by_group ON files (groupId, orderInGroup);

    /*
     * Full-text search over file names.
     *
     * There was no way to find a file by name at all — the board is the only
     * index, so a large library meant scrolling. FTS5 makes that a query, and
     * the index is already SQLite so it costs one virtual table.
     *
     * content=files makes this an **external-content** table: the text is not
     * duplicated, FTS5 reads it back from files by rowid. That keeps the
     * database roughly the size it already was, at the cost of the triggers
     * below — without them the index silently drifts from the table.
     *
     * unicode61 remove_diacritics 2 so searching "resume" finds "résumé",
     * which matters for a library of papers and books far more than it would
     * for a code search.
     */
    CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
      name,
      content = files,
      content_rowid = rowid,
      tokenize = "unicode61 remove_diacritics 2"
    );

    /*
     * Triggers, not manual maintenance.
     *
     * The alternative is remembering to update the index at every write site,
     * which is the same shape as the bug class this project has already been
     * bitten by twice — a rule written down rather than enforced. In the
     * database the index cannot drift, including on the INSERT OR REPLACE
     * that applyDiff uses, which fires delete-then-insert.
     */
    CREATE TRIGGER IF NOT EXISTS files_fts_insert AFTER INSERT ON files BEGIN
      INSERT INTO files_fts (rowid, name) VALUES (new.rowid, new.name);
    END;

    CREATE TRIGGER IF NOT EXISTS files_fts_delete AFTER DELETE ON files BEGIN
      INSERT INTO files_fts (files_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
    END;

    CREATE TRIGGER IF NOT EXISTS files_fts_update AFTER UPDATE ON files BEGIN
      INSERT INTO files_fts (files_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
      INSERT INTO files_fts (rowid, name) VALUES (new.rowid, new.name);
    END;
  `)

  /*
   * No foreign key from files.groupId to groups.id, deliberately.
   *
   * A group is a *logical tag*, and the store already drops a file whose group
   * has gone. A cascade here would move that decision into the database, where
   * a bug in group deletion becomes silent file deletion — the exact failure
   * mode this subsystem has already been burned by once.
   */

  /*
   * Schema 1 -> 2: `lastProgress`.
   *
   * Added with ALTER rather than by recreating the table, so an existing
   * library keeps its rows. `CREATE TABLE IF NOT EXISTS` above already carries
   * the column for a fresh install, which means this only ever fires on an
   * upgrade — and it is wrapped because "duplicate column name" is the expected
   * result of running it twice, not an error worth surfacing.
   */
  try {
    const cols = opened.getAllSync<{ name: string }>('PRAGMA table_info(files)')
    if (!cols.some((c) => c.name === 'lastProgress')) {
      opened.execSync('ALTER TABLE files ADD COLUMN lastProgress REAL')
    }
  } catch (err) {
    console.warn('[stackread] could not add lastProgress column', err)
  }

  /*
   * Schema 2 -> 3: populate the FTS index for a library that predates it.
   *
   * The triggers only fire on writes from here on, so an existing library would
   * have an empty index and search would find nothing in exactly the libraries
   * that most need it. `rebuild` asks FTS5 to re-read the content table, which
   * is the documented way to do this and is correct to run more than once —
   * though the flag below means it normally runs once per upgrade.
   */
  try {
    if (getMetaFrom(opened, 'ftsBuilt') !== '1') {
      opened.execSync("INSERT INTO files_fts (files_fts) VALUES ('rebuild')")
      opened.runSync('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['ftsBuilt', '1'])
    }
  } catch (err) {
    // A search index that cannot be built must not stop the library opening.
    // Search then returns nothing, which is a degraded feature, not a dead app.
    console.warn('[stackread] could not build the search index', err)
  }

  opened.runSync('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
    'schemaVersion',
    String(SCHEMA_VERSION),
  ])

  db = opened
  return opened
}

/** Reads a meta value from a database that is still being opened. */
function getMetaFrom(database: SQLiteDatabase, key: string): string | null {
  const row = database.getFirstSync<{ value: string }>(
    'SELECT value FROM meta WHERE key = ?',
    [key],
  )
  return row?.value ?? null
}

export function getMeta(key: string): string | null {
  const row = getDb().getFirstSync<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])
  return row?.value ?? null
}

export function setMeta(key: string, value: string): void {
  getDb().runSync('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value])
}

export function hasMigratedFromJson(): boolean {
  return getMeta(MIGRATED_KEY) === '1'
}

export function markMigratedFromJson(): void {
  setMeta(MIGRATED_KEY, '1')
}

/**
 * Reads the whole library.
 *
 * Still a full read: the board shows every group and the reader needs its
 * group's files, so there is no useful subset to load at startup. What changed
 * is the *write* path — this is one query per table rather than parsing a
 * megabyte of JSON, and it is ordered by the database rather than in JS.
 */
export function readLibrary(): Library {
  const database = getDb()

  const groupRows = database.getAllSync<GroupRow>(
    'SELECT id, title, sortOrder FROM groups ORDER BY sortOrder ASC',
  )
  const fileRows = database.getAllSync<FileRow>(
    'SELECT id, name, storedName, format, groupId, orderInGroup, lastScroll, lastProgress, thumb, thumbhash, size, addedAt' +
      ' FROM files ORDER BY groupId ASC, orderInGroup ASC',
  )

  return {
    groups: groupRows.map((r) => ({ id: r.id, title: r.title, order: r.sortOrder })),
    files: fileRows.map(toEntry),
  }
}

/**
 * Maps a row back to a `FileEntry`.
 *
 * SQLite returns `null` for an absent value; the type uses optional fields. The
 * two are not interchangeable — `thumbhash: null` would defeat the
 * `thumbhash ?? previous` fallback in `setThumb` and blank a working
 * placeholder — so absent columns are dropped rather than passed through.
 */
function toEntry(row: FileRow): FileEntry {
  const entry: FileEntry = {
    id: row.id,
    name: row.name,
    storedName: row.storedName,
    format: row.format as FileEntry['format'],
    groupId: row.groupId,
    orderInGroup: row.orderInGroup,
    addedAt: row.addedAt,
  }
  if (row.lastScroll !== null) entry.lastScroll = row.lastScroll
  if (row.lastProgress !== null) entry.lastProgress = row.lastProgress
  if (row.thumb !== null) entry.thumb = row.thumb
  if (row.thumbhash !== null) entry.thumbhash = row.thumbhash
  if (row.size !== null) entry.size = row.size
  return entry
}

/**
 * Finds files whose name matches a query, most relevant first.
 *
 * ## Why FTS5 rather than a LIKE scan
 *
 * `LIKE '%term%'` cannot use an index, so it is a full table scan per
 * keystroke — fine at fifty files, a visible stall at several thousand, which
 * is exactly the size where search stops being optional. FTS5 answers from an
 * index and ranks by relevance for free.
 *
 * ## Why the query is rewritten rather than passed through
 *
 * FTS5's match syntax is a small language: bare `-`, `*`, `"` and `NEAR` are
 * operators, so a user typing a filename with a hyphen gets a syntax error
 * rather than results. Each term is therefore quoted, which makes it a literal,
 * and a trailing `*` is added to the last term so results appear while typing
 * rather than only on a completed word.
 */
/**
 * The no-results answer, shared.
 *
 * A module constant rather than a fresh object: this is returned on every
 * keystroke that matches nothing, and it flows into React state. A new
 * `{ files: [], total: 0 }` each time is a new reference each time, which is
 * the re-render trap CLAUDE.md documents for selectors, reached from the other
 * direction.
 */
const EMPTY_PAGE: SearchPage = { files: [], total: 0 }

/**
 * A page of search results, plus how many there are in total.
 *
 * `total` is what the query matched, not what `files` holds. The two differ
 * whenever the limit bites, and telling them apart is the whole point: a list
 * that silently stops at fifty is indistinguishable from a library that
 * contains fifty matches.
 */
export interface SearchPage {
  files: FileEntry[]
  total: number
}

export function searchFiles(query: string, limit = 50): SearchPage {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    // A double quote is the one character that can still escape the quoting
    // below; doubling it is how SQLite escapes a quote inside a quoted string.
    .map((t) => t.replace(/"/g, '""'))

  if (!terms.length) return EMPTY_PAGE

  const match = terms
    .map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`))
    .join(' ')

  try {
    const rows = getDb().getAllSync<FileRow>(
      'SELECT f.id, f.name, f.storedName, f.format, f.groupId, f.orderInGroup,' +
        ' f.lastScroll, f.lastProgress, f.thumb, f.thumbhash, f.size, f.addedAt' +
        ' FROM files_fts JOIN files f ON f.rowid = files_fts.rowid' +
        ' WHERE files_fts MATCH ? ORDER BY rank LIMIT ?',
      [match, limit],
    )
    /*
     * The count is a second query, not `rows.length`.
     *
     * FTS5 has no windowed total, and `rows` is bounded by the same `LIMIT`
     * whose effect the count exists to describe — reading it would report
     * "50 of 50" for every library with more than fifty matches, which is the
     * exact misreport this replaces.
     *
     * It is a `count(*)` over the same MATCH, so it answers from the same
     * index without materialising or ranking a single row: the cost is
     * traversing the posting lists, not building result objects. Ranking is
     * what makes the first query expensive, and this one does not rank.
     */
    const counted = getDb().getFirstSync<{ n: number }>(
      'SELECT count(*) AS n FROM files_fts WHERE files_fts MATCH ?',
      [match],
    )

    return { files: rows.map(toEntry), total: counted?.n ?? rows.length }
  } catch (err) {
    /*
     * A malformed match expression is a user typing, not a bug.
     *
     * Despite the quoting above, FTS5 can still reject an expression — an
     * unbalanced construct, a term that is entirely punctuation. Returning no
     * results is the correct answer to "no files match what you typed"; letting
     * it throw would break the board on a keystroke.
     */
    console.warn('[stackread] search query rejected', err)
    return EMPTY_PAGE
  }
}

/**
 * Applies one diff, atomically.
 *
 * The transaction is the crash-safety guarantee: a kill mid-write leaves the
 * database at the previous commit, never at a half-applied library where a file
 * has been removed from its group but still exists as a row.
 *
 * Deletes run before upserts so that a file moved between groups in the same
 * batch cannot collide with itself.
 *
 * **Throws on failure, deliberately.** The caller keeps its shadow copy
 * unchanged when this throws, so the same rows are retried on the next save
 * rather than being dropped. The previous implementation caught, logged and
 * returned — which is exactly how a write failure became invisible in
 * [DETAIL.md §6.3](../../DETAIL.md).
 */
export function applyDiff(diff: LibraryDiff): void {
  const database = getDb()

  database.withTransactionSync(() => {
    for (const id of diff.fileIdsDeleted) {
      database.runSync('DELETE FROM files WHERE id = ?', [id])
    }
    for (const id of diff.groupIdsDeleted) {
      database.runSync('DELETE FROM groups WHERE id = ?', [id])
    }

    for (const group of diff.groupsUpserted) {
      database.runSync(
        'INSERT OR REPLACE INTO groups (id, title, sortOrder) VALUES (?, ?, ?)',
        [group.id, group.title, group.order],
      )
    }

    for (const file of diff.filesUpserted) {
      database.runSync(
        'INSERT OR REPLACE INTO files' +
          ' (id, name, storedName, format, groupId, orderInGroup, lastScroll, lastProgress, thumb, thumbhash, size, addedAt)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          file.id,
          file.name,
          file.storedName,
          file.format,
          file.groupId,
          file.orderInGroup,
          file.lastScroll ?? null,
          file.lastProgress ?? null,
          file.thumb ?? null,
          file.thumbhash ?? null,
          file.size ?? null,
          file.addedAt,
        ],
      )
    }
  })
}

/**
 * Replaces the entire contents in one transaction.
 *
 * For a restore, where the incoming library bears no relation to what is there
 * and diffing it would be pure overhead. Separate from `applyDiff` because
 * "delete everything first" is a destructive operation that should be spelled
 * out at the call site, not reachable by passing an unusual diff.
 */
export function replaceAll(library: Library): void {
  const database = getDb()

  database.withTransactionSync(() => {
    database.runSync('DELETE FROM files')
    database.runSync('DELETE FROM groups')

    for (const group of library.groups) {
      database.runSync('INSERT INTO groups (id, title, sortOrder) VALUES (?, ?, ?)', [
        group.id,
        group.title,
        group.order,
      ])
    }

    for (const file of library.files) {
      database.runSync(
        'INSERT INTO files' +
          ' (id, name, storedName, format, groupId, orderInGroup, lastScroll, lastProgress, thumb, thumbhash, size, addedAt)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          file.id,
          file.name,
          file.storedName,
          file.format,
          file.groupId,
          file.orderInGroup,
          file.lastScroll ?? null,
          file.lastProgress ?? null,
          file.thumb ?? null,
          file.thumbhash ?? null,
          file.size ?? null,
          file.addedAt,
        ],
      )
    }
  })
}
