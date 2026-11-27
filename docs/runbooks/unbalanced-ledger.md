# Runbook: ledger invariant violated / unbalanced journal

An unbalanced journal **cannot commit**: the deferred trigger raises FC002. So a violation reported by `ledger_invariant_violations()` means either someone bypassed the triggers (as superuser) or a cached balance has drifted. Treat both as critical.

1. See what is violated:
   ```sql
   SELECT * FROM ledger_invariant_violations();
   ```
2. Check for tampering:
   ```sql
   SELECT * FROM audit_log_verify_chain();
   ```
   Also review the Postgres logs for `DISABLE TRIGGER` or `ALTER TABLE`.
3. `posted_balance_drift`:
   - The ledger (`ledger_entries`) is the source of truth.
   - Recompute the cached balance as the owner, inside a maintenance window and an approved change, in one transaction.
   - Re-run the check afterwards.
4. `unbalanced_transaction` (a journal forced in by a superuser):
   - **Do not delete it.**
   - Post a balancing adjustment journal (finance, with step-up) that references it.
   - Re-run the check afterwards.
5. FC002 errors in the app logs mean the request failed and nothing persisted, which points to a posting bug:
   - Find the `request_id`.
   - Reproduce the bug in a test, fix it, and keep the regression test.

**Reproduce:** INC-3 in `scenario incidents`, or `packages/db/test/migrations-and-invariants.test.ts`.
