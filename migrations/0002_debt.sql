-- Task: Debt tracking table
CREATE TABLE IF NOT EXISTS debt_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ym TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('add', 'pay')),
  name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  date TEXT,
  comment TEXT DEFAULT '',
  position INTEGER NOT NULL,
  deleted INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_debt_entries_ym ON debt_entries (ym, position);
