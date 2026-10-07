-- Run this ONCE in the D1 dashboard Console against your existing pos-db.
-- Safe to run even though the table already has data — password_hash starts
-- NULL for every existing user, which just means they keep using magic-link
-- login until they set a password.

ALTER TABLE users ADD COLUMN password_hash TEXT;
