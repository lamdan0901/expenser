-- Task 1: initial schema for expenser

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

CREATE INDEX idx_entries_ym ON entries (ym, kind, position);
CREATE INDEX idx_fixed_rows_ym ON fixed_rows (ym, kind, position);
