# Runbook: duplicate or out-of-order provider webhooks

**Why this is usually harmless:**

- `provider_events (provider, provider_event_id)` is UNIQUE, so a redelivery only increments `deliveries`.
- Processing is driven by the state machine. A late `payment.processing` after `SUCCEEDED` is marked `IGNORED`, and so is a second success for a `SUCCEEDED` intent.

**Steps:**

1. Look at the delivery pattern:
   ```sql
   SELECT type, status, deliveries, received_at FROM provider_events ORDER BY received_at DESC LIMIT 50;
   ```
2. Confirm nothing was credited twice. This should return 0 rows:
   ```sql
   SELECT reference_id, count(*) FROM transactions WHERE kind = 'TOPUP' GROUP BY 1 HAVING count(*) > 1;
   ```
3. Check events with `status = 'FAILED'`: unknown references or amount mismatches. Each one raised a `WEBHOOK_ANOMALY` alert.
   - A success for a `CANCELED` or `FAILED` intent means the provider captured money we never credited.
   - Refund it with the provider and record an adjustment.
4. If deliveries fail signature checks (`webhook.signature_invalid` in the audit log), rotate `WEBHOOK_SECRET`.

**Reproduce:** `pnpm --filter @fincore/api scenario incidents` (INC-1).
