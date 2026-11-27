-- Global ledger invariant check (brief §9). Exit status is non-zero if any invariant is violated.
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/invariant-check.sql
\pset footer off
\echo '== Ledger totals per currency (debits must equal credits) =='
SELECT currency,
       sum(amount_minor) FILTER (WHERE direction = 'DEBIT')  AS total_debits_minor,
       sum(amount_minor) FILTER (WHERE direction = 'CREDIT') AS total_credits_minor,
       count(DISTINCT transaction_id)                         AS journals
  FROM ledger_entries
 GROUP BY currency
 ORDER BY currency;

\echo '== Invariant violations (empty = healthy) =='
SELECT * FROM ledger_invariant_violations();

SELECT count(*) > 0 AS has_violations FROM ledger_invariant_violations() \gset
\if :has_violations
  \echo 'FAIL: ledger invariants violated'
  SELECT 1/0 AS invariant_check_failed;
\else
  \echo 'OK: all ledger invariants hold'
\endif
