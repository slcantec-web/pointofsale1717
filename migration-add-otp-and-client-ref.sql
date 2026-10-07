CREATE TABLE otp_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX idx_otp_email_purpose ON otp_codes(email, purpose, created_at);
ALTER TABLE documents ADD COLUMN client_ref TEXT;
CREATE UNIQUE INDEX idx_documents_client_ref ON documents(shop_id, client_ref) WHERE client_ref IS NOT NULL;
