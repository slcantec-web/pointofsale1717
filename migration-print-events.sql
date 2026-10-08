-- Print / reprint history per document
-- original = first successful print
-- copy = any later normal print
-- original_reprint = paper-jam recovery (slip shows ORIGINAL again; logged separately)

CREATE TABLE IF NOT EXISTS print_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id      INTEGER NOT NULL,
  document_id  INTEGER NOT NULL,
  print_kind   TEXT NOT NULL,          -- original | copy | original_reprint
  print_number INTEGER NOT NULL,       -- 1, 2, 3… per document
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  created_by   INTEGER,
  FOREIGN KEY (shop_id) REFERENCES shops(id),
  FOREIGN KEY (document_id) REFERENCES documents(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_print_events_doc ON print_events(document_id, created_at);
CREATE INDEX IF NOT EXISTS idx_print_events_shop ON print_events(shop_id, created_at);
