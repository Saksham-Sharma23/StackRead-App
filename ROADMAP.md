# StackRead — Feature roadmap

Features to add, in priority order, and the plan for putting some of them behind
a Pro paywall. Written 2026-10-11.

**Before starting any of it:** confirm the AUDIT4 and PDF-speed fixes on a real
device (release build). New features should not be built on unverified changes.

Legend: **Free** / **Pro** = which tier the feature belongs to · Effort is
S (a day or less), M (a few days), L (a week or more).

---

## 1. Gaps users hit immediately

| ☐ | Feature | Tier | Effort | Notes |
|---|---|---|---|---|
| ☑ | **"Open with" / "Share to StackRead"** | Free | M | Done 2026-10-11, not yet tested on a device: intent filters in `app.config.js`, `modules/incoming-files`, `storage/incoming.ts`. Files land in an "Opened files" group and open; duplicates open the existing copy. |
| ☐ | **Password-protected PDFs** | Free | S | `react-native-pdf` takes a `password` prop, but nothing asks for one. Detect the "Password required" error in `PdfRenderer`, show a prompt, and remount with the password. Never store it. |
| ☐ | **Visible search matches in PDFs** | Free | M | WebView formats highlight matches (`mark.sr-hit`). PDF search only counts matches and jumps to the page. Get match rectangles from `modules/pdf-text` and draw them over the page. PLAN.md §2.2. |
| ☐ | **"Continue reading" shelf** | Free | S | A row at the top of the board with files in progress. Progress (`progressKey`) and positions are already stored; this needs a last-opened timestamp. |
| ☐ | **Files deleted outside the app** | Free | S | A missing file's card only fails when opened (AUDIT3). Check existence on launch, alongside the prune, and offer to remove the card. |

## 2. Reading features expected in a paid reader

| ☐ | Feature | Tier | Effort | Notes |
|---|---|---|---|---|
| ☐ | **Bookmarks** | Free (limited) / Pro (unlimited) | M | Several named places per file, with a list sheet. PDFs can use the exact position (`renderers/pdfPosition`); WebView formats can use the character anchor (`getAnchor`). Store in SQLite, keyed by file id, and clear through `storage/lifecycle`. |
| ☐ | **Highlights and notes** | Pro | L | Select text, pick a colour, add a note; export all of a file's highlights as Markdown. EPUB, DOCX, MD, TXT and HTML first; PDF later. The strongest Pro feature. Anchor by character offset, not layout. |
| ☐ | **PDF night mode** | Pro | S–M | The 5 reader themes apply only to WebView formats; PDFs stay bright white. Add a colour-inversion or sepia filter on the PDF view. |
| ☐ | **Read aloud (TTS)** | Pro | M | Android's built-in text-to-speech for EPUB and text formats, highlighting the current sentence and continuing with the screen off. |
| ☐ | **Search inside documents across the library** | Pro | L | Library search matches file *names* only (`files_fts`). Index extracted text as well: EPUB and DOCX when files are prepared, PDF through `modules/pdf-text`. Results show a snippet and open at the match. |
| ☐ | **Reading stats** | Pro | M | Time per book, pages per day, streaks. Count reading time only while the reader is active and the app is in the foreground. |
| ☐ | **Extra themes and fonts** | Pro | S | The 5 themes stay free; extra reader themes and font choices are Pro. |

## 3. Library management

| ☐ | Feature | Tier | Effort | Notes |
|---|---|---|---|---|
| ☐ | **Sort and filter** | Free | S | By recent, name, progress or format; hide finished files. |
| ☑ | **Import a folder or ZIP as a group** | Free | M | Done 2026-10-11, not yet tested on a device. "+ New group" → folder or ZIP; subfolders flattened, natural order, "Name (2)" on a clash, 1,000 files per import, Cancel removes everything copied. `storage/bulkImport.ts`, `storage/zipUnpack.ts`. |
| ☐ | **Automatic backups** | Pro | M | Backup is manual today. Add a scheduled export to a chosen folder or Google Drive. Reuse `storage/backup.ts`. |
| ☐ | **FB2 format** | Free | S | XML, so it's one function in `prepare.ts` plus an entry in `formats.ts`. |
| ☐ | **ODT format** | Free | M | Zip + XML, similar to the DOCX path. |
| ☐ | **CBR comics** | Free | L | RAR needs a native decoder; check the licence (unrar) before choosing one. |
| ☐ | **MOBI / AZW3 (DRM-free only)** | Free | L | Harder format; only after the rest. |

## 4. Known issues from PLAN.md — verify first

Listed as not started in PLAN.md (2026-09-10); check whether later work fixed them.

- ☐ Spreadsheet text invisible on some themes — PLAN.md §2.4
- ☐ The card's ⋯ menu invisible on light covers — PLAN.md §2.5
- ☐ Design pass: 19 spacing values, 12 radii, 16 font sizes, 6 touch targets under 44 pt — PLAN.md §3

## 5. Suggested order

1. "Open with" + password PDFs
2. Continue reading + sort/filter
3. Paywall foundation (§6), shipped with one Pro feature: PDF night mode
4. Bookmarks, then highlights and notes
5. PDF search highlighting, read aloud, reading stats
6. Cross-library content search, automatic backups, new formats

---

## 6. Paywall plan

### Rules from Google

- Digital features in a Play Store app must be sold through **Google Play Billing**.
  No Stripe or PayPal links for in-app features.
- Needs a **Play Console account** (one-time $25) and the app uploaded to at least
  the **internal testing** track. In-app purchases do not work from a sideloaded
  APK. Build an AAB with the release workflow: **Run workflow → aab**.
- Add test accounts as **licence testers**, so test purchases cost nothing.

### Library

- **RevenueCat (`react-native-purchases`)** — recommended. Works with Expo dev
  builds, checks receipts on its own server (no backend to write), and handles
  renewals, refunds and restores. Free up to about $2.5k monthly revenue.
- Alternative: `react-native-iap` / `expo-iap`. Cheaper, but checking receipts
  and handling renewals then needs your own server.
- Either one is a new native module, so it needs a native rebuild.

### Pricing

- **One-time "Pro unlock"** — the best fit for an offline reader.
- **Subscription** — only once Pro includes something with an ongoing cost
  (cloud sync, Drive backups).
- Consider offering both: a lifetime unlock plus an optional subscription, with a
  7-day free trial.
- The free tier must stay genuinely useful: every format, the board, basic
  search, a few bookmarks, manual backup.

### Implementation steps

- ☐ Create the products in Play Console and RevenueCat, with one `pro` entitlement.
- ☐ `store/pro.ts` + `usePro()` — entitlement state, cached in MMKV so Pro works
  offline; refreshed from RevenueCat on launch and when the app returns to the
  foreground.
- ☐ `<ProGate feature="…">` — one shared gate. It shows the paywall sheet with a
  short description of the feature, rather than hiding it. Gate the *action*
  ("Add highlight") so free users can see what Pro offers.
- ☐ Paywall sheet — price fetched from Play (never hard-coded), "Restore
  purchases", terms and privacy links.
- ☐ Restore on reinstall — `allowBackup` is false, so a reinstall starts empty;
  "Restore purchases" brings Pro back.
- ☐ First gated feature end to end: PDF night mode.
- ☐ Tests: the gate logic and the entitlement cache, as pure functions.

### Before launch

- ☐ **Fix the LICENSE.** It is Expo's template MIT notice ("650 Industries"). A
  public MIT repo lets anyone build a copy without the paywall. Make it
  proprietary, or keep the repo private.
- ☐ Privacy policy URL (RevenueCat processes purchase data) and an accurate Play
  **Data safety** form.
- ☐ For a subscription: clear price, renewal and "cancel anytime" wording.
- ☐ Test with a licence tester: buy, cancel, refund, restore, offline, reinstall.
- ☐ Accept that client-side gating can be cracked. RevenueCat's server checks
  protect what matters; nothing more is worth building for an indie app.
