# Assessment 07: Transfer consistency engine

**Status:** complete (ADR-003, ADR-008). Code: `apps/api/src/modules/transfers.ts`.

**Flow, step by step:**

1. Claim the idempotency key.
2. Check ownership in SQL.
3. Apply limits and step-up.
4. Get the Decimal fee from analytics. If that fails, refuse the transfer (fail closed).
5. Get the risk score. If that fails, apply the fail-safe policy.
6. **One database transaction:**
   - lock both balance rows in ascending id order;
   - check available funds under the lock;
   - write the transfer and journal, or a hold plus an alert;
   - write the outbox row;
   - store the idempotent response;
   - write the audit row last.

**Database backstops:**

- the balance check and the overdraft CHECK;
- the state machine (FC006 → 409);
- single reversal only;
- `withTx` retries 40001/40P01 with jitter;
- `lock_timeout` of 3 s.

**Why pessimistic locking:** under optimistic locking, a hot wallet would cause retry storms. Locking in a fixed order keeps the A↔B case deadlock-free.

**Tests:**

- 50 concurrent transfers: exactly 10 post, with no overdraft.
- A↔B ×20: all succeed.
- The same key ×5, and ×10 concurrently: one transfer.
- A different body with the same key: 422.
- A stored 422 is replayed unchanged.
- Reversal, and a second reversal (409).

**Capstone:** 33 of 50 posted; 10 retries produced 1 transfer; the debit was exactly posted × (amount + fee).
