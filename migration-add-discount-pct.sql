-- Run this ONCE in the D1 dashboard Console against your existing pos-db,
-- AFTER migration-add-item-code-and-min-qty.sql (if you haven't run that yet, do it first).
--
-- Adds products.discount_pct — a per-product default discount percentage (e.g. 10 = 10%).
-- When a shop adds this item to a bill, the cart line auto-fills its discount amount
-- from this %. The clerk can still edit the discount on that line manually per sale;
-- this is just a starting default. 0 = no default discount (unchanged behavior).

ALTER TABLE products ADD COLUMN discount_pct REAL NOT NULL DEFAULT 0;
