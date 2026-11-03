CREATE TABLE items (
  id TEXT PRIMARY KEY,
  num INTEGER,
  batch INTEGER,
  title TEXT,
  caption TEXT,
  alts TEXT,
  numbers TEXT,
  source TEXT,
  kind TEXT,
  aspect REAL,
  media TEXT,
  thumb TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created TEXT,
  updated_at TEXT
);
--> statement-breakpoint
CREATE TABLE decisions (
  item_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  caption TEXT,
  note TEXT,
  schedule_at TEXT,
  tweet_url TEXT,
  error TEXT,
  version INTEGER,
  request_id TEXT,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  item_id TEXT,
  payload TEXT,
  status TEXT NOT NULL,
  result TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX requests_status ON requests (status, run_at);
--> statement-breakpoint
CREATE TABLE kv (
  k TEXT PRIMARY KEY,
  v TEXT,
  at TEXT
);
