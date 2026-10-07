-- Run this ONCE in the D1 dashboard Console against your existing pos-db.
--
-- Adds documents.received_amount and documents.balance_due, so a sale records how
-- much cash the customer actually handed over and the resulting balance (negative =
-- still owed — shouldn't happen going forward, since the Worker now rejects a sale
-- if received_amount is less than the total; positive = change given back).
-- Both default to 0, so existing rows (and any doc type other than SALE) are
-- unaffected — this is purely additive.

ALTER TABLE documents ADD COLUMN received_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN balance_due REAL NOT NULL DEFAULT 0;

-- Backfill existing SALE documents so old receipts/history show "no shortfall"
-- (received = total, balance = 0) rather than 0 received against a nonzero total.
UPDATE documents SET received_amount = total WHERE doc_type = 'SALE';
