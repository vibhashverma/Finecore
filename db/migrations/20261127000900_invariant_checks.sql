-- migrate:up

-- Global ledger invariant check. Returns one row per violation; empty = healthy.
-- Run after every integration test, in CI, by the capstone script, and periodically as a metric.
CREATE FUNCTION ledger_invariant_violations() RETURNS TABLE (check_name text, detail text)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  -- 1. Every journal has >= 2 lines and balances.
  SELECT 'unbalanced_transaction',
         t.id::text || ': debits=' || coalesce(s.debits, 0) || ' credits=' || coalesce(s.credits, 0)
           || ' lines=' || coalesce(s.lines, 0)
    FROM transactions t
    LEFT JOIN (
      SELECT e.transaction_id,
             sum(e.amount_minor) FILTER (WHERE e.direction = 'DEBIT')  AS debits,
             sum(e.amount_minor) FILTER (WHERE e.direction = 'CREDIT') AS credits,
             count(*) AS lines
        FROM ledger_entries e GROUP BY e.transaction_id
    ) s ON s.transaction_id = t.id
   WHERE coalesce(s.lines, 0) < 2 OR coalesce(s.debits, 0) <> coalesce(s.credits, 0)

  UNION ALL
  -- 2. Across the whole ledger, per currency, Σ debits = Σ credits.
  SELECT 'global_imbalance', g.currency || ': debits=' || g.debits || ' credits=' || g.credits
    FROM (
      SELECT e.currency,
             coalesce(sum(e.amount_minor) FILTER (WHERE e.direction = 'DEBIT'), 0)  AS debits,
             coalesce(sum(e.amount_minor) FILTER (WHERE e.direction = 'CREDIT'), 0) AS credits
        FROM ledger_entries e GROUP BY e.currency
    ) g
   WHERE g.debits <> g.credits

  UNION ALL
  -- 3. Cached posted balances equal the ledger.
  SELECT 'posted_balance_drift',
         b.account_id::text || ': cached=' || b.posted_minor || ' ledger=' || coalesce(l.balance, 0)
    FROM account_balances b
    LEFT JOIN (
      SELECT e.account_id,
             sum(CASE WHEN e.direction = a.normal_side THEN e.amount_minor ELSE -e.amount_minor END) AS balance
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
       GROUP BY e.account_id
    ) l ON l.account_id = b.account_id
   WHERE b.posted_minor <> coalesce(l.balance, 0)

  UNION ALL
  -- 4. Cached held amounts equal the sum of active holds.
  SELECT 'held_balance_drift',
         b.account_id::text || ': cached=' || b.held_minor || ' holds=' || coalesce(h.held, 0)
    FROM account_balances b
    LEFT JOIN (
      SELECT account_id, sum(amount_minor) AS held FROM holds WHERE status = 'ACTIVE' GROUP BY account_id
    ) h ON h.account_id = b.account_id
   WHERE b.held_minor <> coalesce(h.held, 0)

  UNION ALL
  -- 5. No account below its floor (the CHECK should make this impossible).
  SELECT 'below_floor', b.account_id::text || ': available=' || (b.posted_minor - b.held_minor)
    FROM account_balances b
   WHERE b.posted_minor - b.held_minor < b.floor_minor

  UNION ALL
  -- 6. Every reversal nets its original to zero on every account.
  SELECT 'reversal_not_mirrored', r.id::text || ' reverses ' || r.reverses_transaction_id::text
    FROM transactions r
   WHERE r.reverses_transaction_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM ledger_entries e
        WHERE e.transaction_id IN (r.id, r.reverses_transaction_id)
        GROUP BY e.account_id
       HAVING sum(CASE e.direction WHEN 'DEBIT' THEN e.amount_minor ELSE -e.amount_minor END) <> 0)

  UNION ALL
  -- 7. Audit chain intact.
  SELECT 'audit_chain_broken', v.broken_seq || ': ' || v.problem FROM audit_log_verify_chain() v
$$;

-- migrate:down
DROP FUNCTION ledger_invariant_violations();
