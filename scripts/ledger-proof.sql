-- Assessment 03 evidence: shows, statement by statement, that the database itself refuses ledger
-- tampering and unbalanced journals. Run as the APP role (fincore_api), the same role the API uses:
--   psql "$APP_DATABASE_URL" -a -f scripts/ledger-proof.sql > evidence/03/ledger-proof.txt 2>&1
-- Every attempt runs inside a transaction that ends in ROLLBACK, so the database is left unchanged.
\set ON_ERROR_STOP off
\set VERBOSITY default

\echo '--- 1. A balanced journal commits (then rolled back to keep the demo data clean)'
BEGIN;
WITH alice AS (SELECT w.account_id FROM wallets w WHERE w.account_number = 'FC1000000001'),
     bob   AS (SELECT w.account_id FROM wallets w WHERE w.account_number = 'FC1000000003'),
     t     AS (INSERT INTO transactions (kind, currency, description) VALUES ('TRANSFER', 'INR', 'proof: balanced') RETURNING id)
INSERT INTO ledger_entries (transaction_id, account_id, currency, direction, amount_minor)
SELECT t.id, alice.account_id, 'INR', 'DEBIT', 10000 FROM t, alice
UNION ALL
SELECT t.id, bob.account_id, 'INR', 'CREDIT', 10000 FROM t, bob;
SET CONSTRAINTS ALL IMMEDIATE;  -- run the deferred balance check now instead of at COMMIT
SELECT 'balanced journal accepted' AS result;
ROLLBACK;

\echo '--- 2. An UNBALANCED journal is refused (FC002)'
BEGIN;
WITH alice AS (SELECT w.account_id FROM wallets w WHERE w.account_number = 'FC1000000001'),
     bob   AS (SELECT w.account_id FROM wallets w WHERE w.account_number = 'FC1000000003'),
     t     AS (INSERT INTO transactions (kind, currency, description) VALUES ('TRANSFER', 'INR', 'proof: unbalanced') RETURNING id)
INSERT INTO ledger_entries (transaction_id, account_id, currency, direction, amount_minor)
SELECT t.id, alice.account_id, 'INR', 'DEBIT', 10000 FROM t, alice
UNION ALL
SELECT t.id, bob.account_id, 'INR', 'CREDIT', 9999 FROM t, bob;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;

\echo '--- 3. UPDATE on ledger_entries is refused (no privilege for the app role)'
BEGIN;
UPDATE ledger_entries SET amount_minor = 1 WHERE id = (SELECT min(id) FROM ledger_entries);
ROLLBACK;

\echo '--- 4. DELETE on ledger_entries is refused'
BEGIN;
DELETE FROM ledger_entries WHERE id = (SELECT min(id) FROM ledger_entries);
ROLLBACK;

\echo '--- 5. Overdraft is refused by the balance CHECK (chandra has 10000.00 INR = 1000000 minor)'
BEGIN;
WITH chandra AS (SELECT w.account_id FROM wallets w WHERE w.account_number = 'FC1000000004'),
     bob     AS (SELECT w.account_id FROM wallets w WHERE w.account_number = 'FC1000000003'),
     t       AS (INSERT INTO transactions (kind, currency, description) VALUES ('TRANSFER', 'INR', 'proof: overdraft') RETURNING id)
INSERT INTO ledger_entries (transaction_id, account_id, currency, direction, amount_minor)
SELECT t.id, chandra.account_id, 'INR', 'DEBIT', 1000001 FROM t, chandra
UNION ALL
SELECT t.id, bob.account_id, 'INR', 'CREDIT', 1000001 FROM t, bob;
ROLLBACK;

\echo '--- 6. Writing a balance directly is refused'
BEGIN;
UPDATE account_balances SET posted_minor = 999999999;
ROLLBACK;

\echo '--- 7. Invariant check (must be empty)'
SELECT * FROM ledger_invariant_violations();
