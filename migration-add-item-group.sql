-- Run this ONCE in the D1 dashboard Console against your existing pos-db.
--
-- Adds products.item_group — a free-text grouping/category field (e.g. "Beverages",
-- "Snacks", "Hardware"). Optional per product; NULL/blank = ungrouped.
--
-- Used to:
--   1. Filter products by group on the BILL screen (quick group chips above the pick list)
--      and on the PRODUCTS list.
--   2. Filter the new item-wise transaction report by group.
--
-- No table of groups — a product's group is just whatever text you type, and the
-- frontend offers autocomplete/quick-filter chips built from whatever group names
-- already exist on your products, so you don't need to predefine anything.

ALTER TABLE products ADD COLUMN item_group TEXT;

CREATE INDEX IF NOT EXISTS idx_products_shop_group ON products(shop_id, item_group);
