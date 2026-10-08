-- Admin toggles (e.g. auto-approve pending shops after 24 hours)
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO app_settings (key, value) VALUES ('auto_approve_shops', '0');
