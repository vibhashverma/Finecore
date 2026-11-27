# ADR-008: Idempotency storage

- Status: Accepted (Phase 4)
- Date: 2026-11-28

**Context.** Every money-moving POST must be safe to retry (brief §7).

**Decision.** Store keys in the `idempotency_keys` table in Postgres, keyed by `(user_id, key)`. Redis is not used for this.

1. **Claim.** A short transaction inserts `IN_PROGRESS` with a 60 s lease, using `ON CONFLICT DO NOTHING`. A concurrent duplicate waits for the claim, then sees the row.
2. **Complete atomically.** The business transaction writes `COMPLETED` together with the stored response in the **same commit** as the money movement. Either both commit or neither does.
3. **Replay rules:**
   - same body → the stored response, with an `Idempotent-Replayed` header;
   - different body → `422 IDEMPOTENCY_KEY_REUSED`;
   - lease still active → `409`;
   - lease expired → the request takes over the key. This is safe because of step 2.
4. **Which outcomes are stored.** Deterministic business outcomes are stored and replayed: VALIDATION_ERROR, NOT_FOUND, FORBIDDEN, LIMIT_EXCEEDED, INSUFFICIENT_FUNDS and INVALID_STATE_TRANSITION. Auth, conflict, rate-limit and 5xx results release the key so the client can retry.
5. **Expiry.** Keys expire after 24 h and are removed by housekeeping.

**Why Postgres, not Redis.** Atomicity with the ledger write is the whole point. A Redis key can't commit together with a Postgres transaction.
