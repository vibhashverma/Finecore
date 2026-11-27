# Runbook: settlement mismatch or failed payout

**What the system has already done:**

- **MISMATCHED:** the bank was debited with the actual amount and clearing was credited with the expected amount. The difference sits in `SETTLEMENT_SUSPENSE`.
- **FAILED:** the whole expected amount moved from clearing to suspense, and a `SETTLEMENT_FAILED` alert was raised.

**Steps:**

1. Inspect the reconciliation run:
   ```
   GET /api/v1/reconciliation/runs/{id}
   ```
   Each item's outcome is `MATCHED`, `AMOUNT_MISMATCH`, `MISSING_INTERNAL` or `MISSING_PROVIDER`.
2. Raise it with the provider, quoting the payout id. In test mode, the provider is the simulator.
3. When the funds arrive, finance (with step-up) calls:
   ```
   POST /settlements/{id}/resolve  {recovered_minor, note}
   ```
   This posts DR bank / CR suspense, and the settlement moves to `RESOLVED`.
4. Check the suspense balance:
   ```sql
   SELECT sum(CASE direction WHEN 'DEBIT' THEN amount_minor ELSE -amount_minor END)
     FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
    WHERE a.system_role = 'SETTLEMENT_SUSPENSE';
   ```

**Reproduce:** INC-2, and capstone step 3.
