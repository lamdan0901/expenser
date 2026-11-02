# Expenser — Design

**Date:** 2026-11-02
**Status:** draft, awaiting owner approval

## Intent

A personal expense ledger for a single user. Life moves fast; money moves
faster. The app exists so the owner can log an expense or income the moment
it happens — a few seconds, no friction — and later review any month as a
Notion-style table, same look they already keep their notes in.

Fully hosted on Cloudflare: Workers + D1. No login system; a passcode gate
on first open, remembered afterwards via cookie.

## Why

The owner currently tracks this in a Notion table (see `design.png` in the
repo root): dark Notion-style sheet with columns Name / Amount / Date /
Comment, page icons, a SUM footer, and manual mental math for the monthly
balance. That manual summing and the lack of month separation are the pain
this app removes.

## Goals

- Log an entry in under ~5 seconds: type name + amount, Enter, done.
- Money in / money out are distinct and clearly colored.
- Each month is its own sheet; navigate between months freely.
- Fixed (recurring) income and expenses appear automatically every month.
- A free-form notes area for one-off remarks that don't belong in the ledgers.
- Month totals computed for them: initial, income, expense, ending balance.

## Non-goals

- Multi-user, accounts, sharing.
- Bank sync / imports.
- Budgets, categories, analytics, charts.
- Offline / PWA.

## Anti-goals (would be failure)

- Any extra step between "money moved" and "it's logged" (no modal, no
  page change, no required fields beyond the essentials).
- Cluttered screen where the log is buried under dashboards.

## Constraints & decisions (owner + sessions)

- **Hosting:** Cloudflare Workers, static assets + API in one worker;
  D1 for storage. Everything on Cloudflare, no other service.
- **Access:** public URL; single shared passcode input shown on first open.
  Verified passcode sets a signed cookie (long expiry). Passcode lives as a
  Worker secret. Without it, API rejects and UI shows only the passcode view.
- **Single user.** No per-row ownership.
- **UI reference:** `mockup.html` at repo root is the approved visual and
  interaction reference (dark Notion-like tables). `design.png` is the
  original inspiration. Note: the mockup shows `$` as a formatting
  placeholder; the real app uses VND per the currency decision below.
- **Currency (owner decision):** VND, no decimals, `₫` symbol, comma
  thousands separators (e.g., `500,000 ₫`). Input convention: the user
  enters only the thousands part — typing `500` means `500,000 ₫` (all
  numeric inputs are ×1000, including the initial balance). Amounts are
  stored as full VND integers in the DB (1000 × input), which also sidesteps
  float rounding: `amount` columns are integers, not REAL.
- **Desktop first.** Owner logs from the computer most of the time.
  Mobile support is nice-to-have, not a design driver.

## The month model

- A "month" is a sheet identified by `YYYY-MM`. A month materializes on
  its **first write** (first entry logged, or first fixed-row edit in that
  sheet). Merely viewing a month never creates it; viewing an empty month
  shows empty sections and a virtual balance preview (see below).
- **Fixed items are snapshots (owner decision).** When a month materializes,
  current fixed income/expense templates are copied into it as rows.
  Editing rules:
  - Editing a fixed row in the **current month** (or any unmaterialized/
    current-and-future context) edits the *template* and also refreshes the
    current month's snapshot copy. The changed price applies to the current
    and new months only — **past months keep the old value** (owner decision).
  - Editing a fixed row in an already-materialized **past month** changes
    that month's local copy only, never the template.
  - Deleting a fixed row likewise mirrors these rules (delete from current
    month = template deletion, past copies survive as snapshots).
  - One-off tweaks to a recurring item belong in the monthly table instead.
- **Initial balance** is a single app-level setting (the owner's Notion
  "Initial bugets" number), entered during first-run setup (my call; change
  later via ⚙). It applies to every month identically; no auto-carry-over —
  the owner logs a previous month's remainder as an income row ("prev
  month"), matching their existing habit. Ending balance per month =
  initial + fixed income + income entries − fixed expenses − expense entries.
  An unmaterialized month's balance preview computes from initial + live
  templates, so flipping through future months already shows sensible totals.
- **Entry date vs sheet month (owner decision):** an entry always belongs to
  the sheet being viewed. The composer's date picker is restricted to days
  within the open month (`min`/`max` = first and last day of that month);
  cross-month dates are impossible by design, so no routing or notices are
  needed.
- **Passcode** is pre-seeded as a Worker secret at deploy time (not chosen
  at first open). The gate appears on first open and whenever the signed
  cookie is missing/expired; passcode attempts are rate-limited per IP
  (simple counter in Durable Object or KV — builder's choice). After the
  first successful verify, a one-time setup screen asks for the initial
  balance.

## Data model (D1)

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,          -- 'initial_balance' (full VND integer)
  value TEXT NOT NULL
);

CREATE TABLE templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('fixed_income','fixed_expense')),
  name TEXT NOT NULL,
  amount INTEGER NOT NULL,       -- full VND (input x1000); direction comes from kind
  comment TEXT DEFAULT '',
  position INTEGER NOT NULL,     -- ordering within kind
  deleted INTEGER DEFAULT 0      -- soft delete so old months keep history
);

CREATE TABLE months (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ym TEXT NOT NULL UNIQUE,       -- '2026-11'
  materialized_at TEXT           -- set on first write to that sheet
);

CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ym TEXT NOT NULL,              -- which month sheet it lives on
  kind TEXT NOT NULL CHECK (kind IN ('income','expense','note')),
  name TEXT NOT NULL,
  amount INTEGER,                -- NULL for notes; full VND, positive number
  date TEXT,                     -- ISO 'YYYY-MM-DD'; must fall inside ym
  comment TEXT DEFAULT '',
  position INTEGER NOT NULL,     -- ordering on the sheet (new = top)
  deleted INTEGER DEFAULT 0
);

CREATE TABLE fixed_rows (
  -- a materialized month's snapshot of a template at first write
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ym TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fixed_income','fixed_expense')),
  template_id INTEGER,           -- NULL for rows created directly in a month
  name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  comment TEXT DEFAULT '',
  position INTEGER NOT NULL,
  deleted INTEGER DEFAULT 0
);
```

- Sums: income = fixed income snapshot + income entries; expense likewise.
  Dates on entries are validated to fall inside the sheet's month.

## API (Worker routes, all JSON, behind passcode cookie)

```
GET   /api/me                     → {verified, setup_done}
POST  /api/passcode               → verify (rate-limited), set signed cookie
PUT   /api/settings/initial       → initial balance (first-run setup + ⚙)
GET   /api/month/:ym              → sheet view: fixed rows (snapshot if
                                    materialized, else virtual from live
                                    templates) + entries + initial balance;
                                    read-only, never materializes
POST  /api/month/:ym/entry        → create entry (first write materializes)
PATCH /api/entry/:id               → inline edit; also top-level reorder via
                                    position patches
DELETE /api/entry/:id              → soft delete
POST  /api/fixed/:ym              → new fixed item (current month: creates
                                    template + snapshot; past month:
                                    snapshot only)
PATCH /api/fixed/:id               → edit fixed row (snapshot-with-template-
                                    refresh rules for current month;
                                    snapshot-only for past months)
DELETE /api/fixed/:id              → mirror of the patch rules
GET   /api/summary/:ym            → {initial, income, expense, ending}
GET   /api/month/:ym/export       → CSV of the sheet
```

## UI spec (from approved mockup)

**Chrome**

- Sticky top bar: brand, month switcher `◀ November 2026 ▶`, Today chip,
  Export, and ⚙ (initial balance, passcode stays a deploy-time secret).
- Sticky bottom balance bar: 🏦 Initial · 📥 Income (fixed + this month) ·
  📤 Expense (fixed + this month) · ⚖ Ending — always visible.
- No top summary cards (owner explicitly removed them).

**Fast capture composer** (directly under the top bar, always visible)

- Segmented direction toggle: 📤 Expense / 📥 Income (Esc flips).
- Fields: name (focus on load; `N` refocuses), amount (VND thousands —
  type `500` → `500,000 ₫`), optional comment, date picker chip defaulting
  to "Today" (picking non-today highlights it and shows the short date;
  resets to today after save). The picker is constrained to days inside the
  open sheet's month — entries always belong to the sheet being viewed
  (owner decision).
- Enter (from any field) routes the entry into Income or Expenses table,
  inserts it at the top of that list with a brief flash.
- Disabled/hidden until passcode verified.

**Tables** — five sections, Notion-like dark style, in this order:

1. 📥 Income — this month
2. 📤 Expenses — this month
3. 💰 Fixed Income *(repeats every month)*
4. 📌 Fixed Expenses *(repeats every month)*
5. 📝 Extra & Notes *(no math unless you want)*

- Columns: Item · Amount · Date (this-month and notes only) · Comment ·
  `＋/···` actions. Fixed sections have no Date column.
- Newest entries at the top of their section by default.
- Drag handle (⠿ on row hover) reorders within the section, live drop marker.
- Inline editing: click name/amount/comment to edit; Enter commits; the
  amount editor opens with the full formatted value so edits are unambiguous.
- Footer SUM per numeric section (notes excluded from all totals).
- Colors and signs per the mockup, but VND formatting everywhere: `₫`
  appended (e.g., `500,000 ₫`), comma separators, no decimals; inputs take
  thousands (×1000 on commit), tabular numerals.
- Notes rows have no amount column and never contribute to sums.

**Months**

- Switching months swaps the sheet; `◀ ▶` step one month, Today chip jumps
  back. Current month's URL is deep-linkable (`/#2026-11`).
- Old months show exactly what was logged then, fixed rows included as
  they were that month.
- Export ⬇: CSV of the visible month.

## Left to the builder

- Workbook/asset bundling choice for the Worker (single worker, static
  assets + JSON API — no framework mandate; vanilla JS/TS acceptable and
  recommended given scale).
- Exact styling tokens, animations, and responsive breakpoints beyond the
  reference mockup.
- Cookie signing implementation (HMAC via WebCrypto, `expenser_auth`).
- CSV format details.
- Migration/schema plumbing, `wrangler.toml`, and dev/prod wiring.

## Success check

- A new entry takes: click name → type → Tab → amount → Enter. Nothing else.
- Moving to last month shows the same five sections with that month's data.
- The ending balance never requires mental math.
