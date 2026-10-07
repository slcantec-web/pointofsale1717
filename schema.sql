-- POS System D1 Schema
-- Multi-tenant, document-journal model (SAP-style: no mutation, only offsetting documents)

CREATE TABLE shops (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT NOT NULL,              -- internal/display name
    legal_name            TEXT,                        -- printed on receipt
    address               TEXT,
    contact_number        TEXT,
    footer_note           TEXT,                        -- e.g. "Thank you, come again"
    tracks_inventory      INTEGER NOT NULL DEFAULT 1,   -- 0 = non-inventory (billing only) mode
    paper_width           INTEGER NOT NULL DEFAULT 80,  -- 58 or 80 (mm)
    tax_rate              REAL NOT NULL DEFAULT 0,      -- e.g. 0.15 for 15%
    low_stock_threshold   INTEGER NOT NULL DEFAULT 5,   -- legacy/unused: superseded by products.low_stock_threshold (per-item minimum)
    next_doc_number       INTEGER NOT NULL DEFAULT 1,   -- atomic per-shop counter
    next_item_number       INTEGER NOT NULL DEFAULT 1,   -- atomic per-shop counter for products.item_code
    status                TEXT NOT NULL DEFAULT 'active', -- 'pending' | 'active' | 'rejected' — self-serve signups start pending
    active                INTEGER NOT NULL DEFAULT 1,
    created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id        INTEGER,                    -- NULL = super admin
    email          TEXT NOT NULL UNIQUE,
    role           TEXT NOT NULL,               -- 'super_admin' | 'shop'
    password_hash  TEXT,                        -- NULL = no password set yet, must use magic link
    active         INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (shop_id) REFERENCES shops(id)
);

CREATE TABLE magic_links (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    token       TEXT NOT NULL UNIQUE,
    expires_at  TEXT NOT NULL,
    used        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Item categories/groups, managed independently (add/rename/delete) from the
-- Products screen. products.item_group stores the group's *name* (not id) —
-- renaming a group here cascades an UPDATE to every product carrying the old
-- name; deleting a group clears item_group back to NULL on affected products.
CREATE TABLE item_groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id    INTEGER NOT NULL,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (shop_id) REFERENCES shops(id)
);

CREATE TABLE products (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id      INTEGER NOT NULL,
    item_code    TEXT NOT NULL,                 -- system-assigned, sequential per shop (from shops.next_item_number) — not user-editable; future barcode link target
    name         TEXT NOT NULL,
    unit_price   REAL NOT NULL DEFAULT 0,       -- selling price
    cost_price   REAL NOT NULL DEFAULT 0,       -- weighted avg (inventory mode) or manual (non-inventory)
    stock_qty    REAL,                          -- NULL when shop.tracks_inventory = 0
    low_stock_threshold  INTEGER,               -- per-item minimum qty; NULL = use the app's default (5)
    discount_pct REAL NOT NULL DEFAULT 0,        -- default line-discount %, auto-fills the bill's discount when this item is added (e.g. 10 = 10%)
    item_group   TEXT,                           -- free-text grouping/category (e.g. "Beverages"); NULL = ungrouped. Used to filter Bill/Products and the transaction report.
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (shop_id) REFERENCES shops(id)
);

-- Unified document journal: sales, reversals, stock-in, stock-in reversals.
-- Nothing here is ever UPDATEd after posting except print_count.
CREATE TABLE documents (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id           INTEGER NOT NULL,
    doc_type          TEXT NOT NULL,             -- SALE | REVERSAL | STOCK_IN | STOCK_IN_REVERSAL
    doc_number        INTEGER NOT NULL,          -- sequential per shop, shared across all doc_types
    reference_doc_id  INTEGER,                   -- NULL for originals; points to original for reversals/rebills
    subtotal          REAL NOT NULL DEFAULT 0,
    discount_amount   REAL NOT NULL DEFAULT 0,
    tax_amount        REAL NOT NULL DEFAULT 0,
    total             REAL NOT NULL DEFAULT 0,
    received_amount   REAL NOT NULL DEFAULT 0,       -- cash/payment received against this document (SALE only; 0 for other doc types)
    balance_due       REAL NOT NULL DEFAULT 0,       -- received_amount - total: negative = still owed (shouldn't happen, enforced at posting), positive = change given
    print_count       INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    created_by        INTEGER,                   -- users.id
    note              TEXT,
    FOREIGN KEY (shop_id) REFERENCES shops(id),
    FOREIGN KEY (reference_doc_id) REFERENCES documents(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE document_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id      INTEGER NOT NULL,
    product_id       INTEGER,                    -- NULL if product was deleted later; name is preserved below
    name             TEXT NOT NULL,               -- snapshot, survives product edits/deletes
    qty              REAL NOT NULL DEFAULT 0,
    unit_price       REAL NOT NULL DEFAULT 0,     -- 0/unused for STOCK_IN docs
    cost_price       REAL NOT NULL DEFAULT 0,     -- snapshot at time of document
    discount_amount  REAL NOT NULL DEFAULT 0,
    line_total       REAL NOT NULL DEFAULT 0,
    gp_amount        REAL NOT NULL DEFAULT 0,     -- 0/unused for STOCK_IN docs
    stock_effect     REAL NOT NULL DEFAULT 0,     -- +qty for STOCK_IN, -qty for SALE, sign-flipped for reversals
    FOREIGN KEY (document_id) REFERENCES documents(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE INDEX idx_users_shop ON users(shop_id);
CREATE INDEX idx_magic_links_token ON magic_links(token);
CREATE INDEX idx_magic_links_user ON magic_links(user_id);
CREATE INDEX idx_products_shop ON products(shop_id);
CREATE UNIQUE INDEX idx_products_shop_item_code ON products(shop_id, item_code);
CREATE INDEX idx_products_shop_group ON products(shop_id, item_group);
CREATE UNIQUE INDEX idx_item_groups_shop_name ON item_groups(shop_id, name);
CREATE INDEX idx_documents_shop ON documents(shop_id, created_at);
CREATE INDEX idx_documents_shop_number ON documents(shop_id, doc_number);
CREATE INDEX idx_documents_reference ON documents(reference_doc_id);
CREATE INDEX idx_document_items_document ON document_items(document_id);
CREATE INDEX idx_document_items_product ON document_items(product_id);
