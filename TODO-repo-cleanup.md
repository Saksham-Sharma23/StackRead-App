# Repo cleanup — to-do list

Work top to bottom, one item at a time. Tick `[x]` when done. Each item is
small, and the app keeps working after every one. Run `npm run check` after any
item that touches code or tests.

Delete this file when the last item is done.

---

## Phase 1 — Clean the root (low risk, no app code changes)

### Decisions first
- [x] **1. Choose the licence** — All rights reserved: "All rights reserved" (recommended, given the
      planned Pro features) or MIT under your own name
- [x] **2. Decide public or private repo** — private (set on GitHub by you): private hides the code and history
      entirely; recommended if you keep "All rights reserved"

### Files
- [x] **3. Replace `LICENSE`** with the chosen licence and your name (it is
      currently Expo's template: "Copyright 650 Industries")
- [ ] **4. Commit `PRIVACY.md`**: already written and hosted on Google Sites;
      just not in git yet
- [x] **5. Keep `docs/` local**: it stays gitignored and never goes to GitHub
      (your choice). Reorganised into `setup/`, `release/`, `play-store/` and
      `marketing/`, with an index at `docs/README.md`
- [x] **6. Create the docs folders** and move the existing guides into them;
      add the new guides: signing, Play Store path, console answers, store
      listing, testers, LinkedIn post, feature-graphic script
- [ ] **7. Decide where the root notes go**: `AUDIT.md`–`AUDIT4.md`,
      `TASKS.md`, `TASKS2.md`, `DETAIL.md`, `PLAN.md`, `ROADMAP.md`
  - Option A: move them into `docs/` too, so they leave the repo (cleanest root;
    about 30 code comments and CLAUDE.md would then point at local-only files)
  - Option B: move them into a tracked folder such as `notes/` (root clean,
    still in git)
- [x] **8. Fix links to the moved guides**: CLAUDE.md, DETAIL.md, the
      workflow's error message, and the links inside the guides themselves
- [ ] **9. Delete the image folders from git**: `design/`, `screenshots/`,
      `stackreadrelease/` (keep `stackreadrelease/bugs/Fix.md` →
      `docs/history/`)
- [ ] **10. Add `CHANGELOG.md`** with entries for 0.1.0 and 1.5.0
- [ ] **11. Add `.gitattributes`** (`* text=auto eol=lf`) and normalise the
      mixed line endings in one commit
- [ ] **12. Run `npm run check`**, then commit:
      `chore: tidy repo root`

**Result:** the root holds only README, CHANGELOG, LICENSE, PRIVACY, CLAUDE,
AGENTS and config files.

---

## Phase 2 — Tooling (low risk)

- [ ] **13. Add `.github/workflows/ci.yml`**: typecheck + tests on every push
      and pull request (~2 min)
- [ ] **14. Add `.nvmrc`** (`24`) and `"engines": { "node": ">=22.6" }` in
      `package.json`
- [ ] **15. Add `.editorconfig`** (2-space indent, LF, UTF-8)
- [ ] **16. Add Prettier** (`.prettierrc` matching the current style: no
      semicolons, single quotes) and `npm run format`
- [ ] **17. Add ESLint** (`eslint-config-expo`) and `npm run lint`
- [ ] **18. Fix the first lint run's warnings**, in one or more commits
- [ ] **19. Add lint to `npm run check`** and to `ci.yml`
- [ ] **20. Commit**: `chore: add CI, lint and formatting`

---

## Phase 3 — Reorganise `src/` (medium risk, optional)

Do one folder per commit. Update imports and the tests that read source by
path (14 test files) in the same commit, then run `npm run check`.

- [ ] **21. `src/types/`**: move `types.ts`, `search/types.ts`,
      `untyped-modules.d.ts`
- [ ] **22. `src/diagnostics/`**: move `crashLog.ts`, `perf.ts`, `scrub.ts`
      out of `ui/` (keep `index.ts` importing `perf` first — it is
      load-bearing)
- [ ] **23. `src/components/common/`**: ActionSheet, SheetShell, Dropdown,
      PopoverMenu, ToolButton, NavBarScrim, LoadingCover, ErrorBoundary
- [ ] **24. `src/components/board/`**: FileCard, GroupRow, DraggableCard,
      AddTile, MoreTile, EmptyBoard, LibrarySearch, MoveSheet, UndoToast,
      PdfCoverFactory, useSnippet, useThumbnail
- [ ] **25. `src/components/reader/`**: HorizontalPager, ScrollPageIndicator,
      PageDots, pageDotsGeometry, TocSheet, ReaderSettingsSheet, SearchBar,
      ReaderTransition
- [ ] **26. `src/storage/index/`**: db, library, libraryDiff, validateLibrary
- [ ] **27. `src/storage/files/`**: files, paths, lifecycle, pruneGuard,
      formats
- [ ] **28. `src/storage/import/`**: bulkImport, bulkImportRules, zipUnpack,
      incoming, incomingName
- [ ] **29. `src/storage/covers/`**: covers, coverSelect, thumbs, thumbhash,
      pdfPreview, snippet
- [ ] **30. Update CLAUDE.md §7 "Where things live"** and the README's
      project layout
- [ ] **31. Commit**: `refactor: group src/ by concern`

---

## Habits from now on

- [ ] **32. Commit messages** in the form `feat: …`, `fix: …`, `docs: …`,
      `chore: …`, `refactor: …` — no more "fixes"
- [ ] **33. Update `CHANGELOG.md`** with every release tag
- [ ] **34. Delete this file**
