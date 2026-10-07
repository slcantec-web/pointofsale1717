-- Run this ONCE in the D1 dashboard Console against your existing pos-db,
-- AFTER migration-add-item-group.sql (that one adds products.item_group; run it
-- first if you haven't already — this migration assumes that column exists).
--
-- Adds a proper item_groups table so categories are managed (add/rename/delete)
-- from the Products screen instead of being free-typed per product. products.item_group
-- keeps storing the group's *name* (not an id) for simplicity — renaming a group here
-- cascades an UPDATE to every product carrying the old name; deleting a group clears
-- item_group back to NULL on any product that had it (the product itself is otherwise
-- untouched).
--
-- Backfills one row per distinct item_group value already in use on any product, so
-- nothing you've already typed disappears from the manager list.

CREATE TABLE item_groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id    INTEGER NOT NULL,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (shop_id) REFERENCES shops(id)
);
CREATE UNIQUE INDEX idx_item_groups_shop_name ON item_groups(shop_id, name);

INSERT INTO item_groups (shop_id, name)
SELECT DISTINCT shop_id, item_group FROM products WHERE item_group IS NOT NULL AND TRIM(item_group) <> '';
