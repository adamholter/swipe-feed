CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  title TEXT,
  batch TEXT,
  parts TEXT NOT NULL,
  status TEXT NOT NULL,
  request_id TEXT,
  url TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deferred_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
ALTER TABLE items ADD COLUMN thread_id TEXT;
