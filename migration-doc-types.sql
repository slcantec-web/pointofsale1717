-- Document type registry (labels for reports / audit across the app)
CREATE TABLE IF NOT EXISTS doc_types (
  code       TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'other', -- sale | stock | other
  sort_order INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO doc_types (code, label, category, sort_order) VALUES
  ('SALE',              'Sale',              'sale',  10),
  ('REVERSAL',          'Sale void',         'sale',  20),
  ('STOCK_IN',          'Stock in',          'stock', 30),
  ('STOCK_ADJUST',      'Stock adjust',      'stock', 40),
  ('STOCK_IN_REVERSAL', 'Stock in void',     'stock', 50);
