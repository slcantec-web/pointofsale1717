CREATE TABLE shops (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT NOT NULL,
    legal_name            TEXT,
    address               TEXT,
    contact_number        TEXT,
    footer_note           TEXT,
    tracks_inventory      INTEGER NOT NULL DEFAULT 1,
    paper_width           INTEGER NOT NULL DEFAULT 80,
    paper_size            TEXT NOT NULL DEFAULT '80mm',
    tax_rate              REAL NOT NULL DEFAULT 0,
    low_stock_threshold   INTEGER NOT NULL DEFAULT 5,
    next_doc_number       INTEGER NOT NULL DEFAULT 1,
    next_item_number      INTEGER NOT NULL DEFAULT 1,
    status                TEXT NOT NULL DEFAULT 'active',
    active                INTEGER NOT NULL DEFAULT 1,
    created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id        INTEGER,
    email          TEXT NOT NULL UNIQUE,
    role           TEXT NOT NULL,
    password_hash  TEXT,
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
    item_code    TEXT NOT NULL,
    name         TEXT NOT NULL,
    unit_price   REAL NOT NULL DEFAULT 0,
    cost_price   REAL NOT NULL DEFAULT 0,
    stock_qty    REAL,
    low_stock_threshold INTEGER,
    discount_pct REAL NOT NULL DEFAULT 0,
    item_group   TEXT,
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (shop_id) REFERENCES shops(id)
);

CREATE TABLE documents (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id           INTEGER NOT NULL,
    doc_type          TEXT NOT NULL,
    doc_number        INTEGER NOT NULL,
    reference_doc_id  INTEGER,
    subtotal          REAL NOT NULL DEFAULT 0,
    discount_amount   REAL NOT NULL DEFAULT 0,
    tax_amount        REAL NOT NULL DEFAULT 0,
    total             REAL NOT NULL DEFAULT 0,
    received_amount   REAL NOT NULL DEFAULT 0,
    balance_due       REAL NOT NULL DEFAULT 0,
    print_count       INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    created_by        INTEGER,
    note              TEXT,
    client_ref        TEXT,
    FOREIGN KEY (shop_id) REFERENCES shops(id),
    FOREIGN KEY (reference_doc_id) REFERENCES documents(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE document_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id      INTEGER NOT NULL,
    product_id       INTEGER,
    name             TEXT NOT NULL,
    qty              REAL NOT NULL DEFAULT 0,
    unit_price       REAL NOT NULL DEFAULT 0,
    cost_price       REAL NOT NULL DEFAULT 0,
    discount_amount  REAL NOT NULL DEFAULT 0,
    line_total       REAL NOT NULL DEFAULT 0,
    gp_amount        REAL NOT NULL DEFAULT 0,
    stock_effect     REAL NOT NULL DEFAULT 0,
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

CREATE UNIQUE INDEX idx_documents_client_ref ON documents(shop_id, client_ref) WHERE client_ref IS NOT NULL;

CREATE TABLE otp_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT NOT NULL,
    purpose     TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    used        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_otp_email_purpose ON otp_codes(email, purpose, created_at);

CREATE TABLE shop_name_requests (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id         INTEGER NOT NULL,
    current_name    TEXT NOT NULL,
    requested_name  TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    note            TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at     TEXT,
    resolved_by     INTEGER,
    FOREIGN KEY (shop_id) REFERENCES shops(id),
    FOREIGN KEY (resolved_by) REFERENCES users(id)
);
CREATE INDEX idx_shop_name_requests_status ON shop_name_requests(status, created_at);
CREATE INDEX idx_shop_name_requests_shop ON shop_name_requests(shop_id, created_at);
