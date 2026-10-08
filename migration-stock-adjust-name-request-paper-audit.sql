-- Migration: stock adjust, shop name requests, paper sizes, audit support
-- Run in D1 console after schema is in place.

-- Paper size: keep paper_width for backward compat; add paper_size TEXT.
-- Values: '58mm' | '80mm' | 'A4' | 'Letter'
ALTER TABLE shops ADD COLUMN paper_size TEXT;

UPDATE shops SET paper_size = CASE
  WHEN paper_width = 58 THEN '58mm'
  WHEN paper_width = 80 THEN '80mm'
  ELSE '80mm'
END
WHERE paper_size IS NULL;

-- Shop name change requests (shop requests → super_admin approves)
CREATE TABLE IF NOT EXISTS shop_name_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id         INTEGER NOT NULL,
  current_name    TEXT NOT NULL,
  requested_name  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT,
  resolved_by     INTEGER,
  FOREIGN KEY (shop_id) REFERENCES shops(id),
  FOREIGN KEY (resolved_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_shop_name_requests_status ON shop_name_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_shop_name_requests_shop ON shop_name_requests(shop_id, created_at);
