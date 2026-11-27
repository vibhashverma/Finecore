# ADR-003: Transfer concurrency control

- Status: Accepted (2026-11-27, Phase 0 review)
- Date: 2026-11-27

## Context

Concurrent debits against the same wallet must never overdraw it or double-spend. Opposing transfers (A→B while B→A) must not deadlock, or must recover safely. The test matrix requires 50 concurrent transfers from one wallet and opposing A↔B transfers.

## Options

| Option                                                                                     | Behaviour under a hot wallet                                                                                                       | Notes                                                                                                       |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **A. Pessimistic row locks** (`SELECT … FOR UPDATE` on `account_balances`, READ COMMITTED) | Requests queue on the row lock. Every request completes with either success or `INSUFFICIENT_FUNDS`. No wasted work.               | Needs deterministic lock order to avoid deadlocks. The lock is held only for the short posting transaction. |
| B. Optimistic (`version` column, `UPDATE … WHERE version = $v`)                            | Under 50-way contention most attempts conflict, which causes retry storms and needs a retry budget. Clients may see spurious 409s. | Good for low-contention edits (profile, dispute notes).                                                     |
| C. SERIALIZABLE everywhere                                                                 | Correct, but high abort rate on hot rows. Every code path must retry. Harder to reason about in a review.                          | Useful as a second layer for specific queries.                                                              |
| D. Single-writer queue per wallet                                                          | Strong ordering                                                                                                                    | Adds latency and infrastructure. Makes the synchronous API async.                                           |

## Decision

**Option A, pessimistic locking**, with these rules:

1. **Lock targets** are `account_balances` rows. Only customer wallets have one; system accounts are balance-derived and are never locked, so fee, clearing and suspense accounts don't serialise all traffic.
2. **Lock ordering:** collect every cached-balance account id the transaction will touch, sort ascending, and lock in a single query: `SELECT … WHERE account_id = ANY($1) ORDER BY account_id FOR UPDATE`. Opposing A↔B transfers then acquire locks in the same order, so there is no lock cycle.
3. **Check under lock:** the available balance is `posted_minor − held_minor`, read after the lock is acquired.
4. **DB backstop:** `CHECK (posted_minor − held_minor >= floor_minor)` on `account_balances`, which is maintained by trigger from entries and holds. If app logic regresses, the commit fails instead of overdrawing.
5. **Timeouts:** `SET LOCAL lock_timeout = '3s'` and `statement_timeout = '5s'` inside money transactions. A timeout maps to `503 UPSTREAM_UNAVAILABLE` with retry guidance, and the idempotency key is released.
6. **Retry:** the `withTransaction` helper retries SQLSTATE `40P01` (deadlock) and `40001` (serialization) up to 3 times with jittered backoff. Deadlocks are not expected, but this is defense in depth. Each retry is logged with `request_id`.
7. **No network I/O while holding locks.** Risk scoring and provider calls happen between transactions (PLAN §5).
8. **Optimistic `version` columns** are used for low-contention entities: disputes, risk alerts and profile edits. A conflict there returns `409 CONFLICT`.
9. **State transitions** use `UPDATE … SET status = $to WHERE id = $id AND status = $from RETURNING`. Zero rows means `409 INVALID_STATE_TRANSITION` (a compare-and-set), so two concurrent reversals can't both win. The UNIQUE `reverses_transaction_id` is a second barrier.

## Consequences

- Throughput on a single hot wallet is bounded by one posting transaction at a time, a few ms each. This is acceptable for retail wallets. A merchant-scale hot account would need sharded sub-accounts; that is documented as a limitation.
- Proof: the concurrency tests in Phase 4 run against real Postgres through Testcontainers. After each run, the global invariant query must pass, and Σ debited from the hot wallet must be ≤ its opening balance.
