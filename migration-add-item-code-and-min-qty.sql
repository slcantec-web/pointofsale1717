-- Run this ONCE in the D1 dashboard Console against your existing pos-db.
-- Adds:
--   1. shops.next_item_number   — atomic per-shop counter (same pattern as next_doc_number),
--      used to assign products.item_code automatically.
--   2. products.item_code       — system-assigned, sequential per shop. Not user-editable;
--      exists so a barcode can be linked to it later without a schema change.
--   3. products.low_stock_threshold — per-item minimum qty. Supersedes shops.low_stock_threshold,
--      which is left in place (harmless, just unused) rather than dropped, since SQLite's
--      DROP COLUMN support varies and this keeps the migration additive/safe on a live table.

ALTER TABLE shops ADD COLUMN next_item_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE products ADD COLUMN item_code TEXT;
ALTER TABLE products ADD COLUMN low_stock_threshold INTEGER;

-- Backfill item_code for any products that already exist, numbering sequentially per
-- shop in id order (i.e. the order they were originally created).
UPDATE products
SET item_code = (
  SELECT CAST(rn AS TEXT) FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY shop_id ORDER BY id) AS rn
    FROM products
  ) t
  WHERE t.id = products.id
)
WHERE item_code IS NULL;

-- Bring each shop's counter up past whatever was just backfilled, so the next product
-- created gets the next number instead of colliding with an existing one.
UPDATE shops
SET next_item_number = COALESCE(
  (SELECT MAX(CAST(item_code AS INTEGER)) + 1 FROM products WHERE products.shop_id = shops.id),
  1
);

-- item_code can now be made required going forward; existing rows are already backfilled.
-- (D1/SQLite can't add a NOT NULL column with no default to a populated table in one step,
-- which is why it was added nullable above and backfilled here instead.)
