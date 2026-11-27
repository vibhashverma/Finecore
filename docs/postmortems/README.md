# Postmortems (Assessment 15)

Five simulated incidents, each reproduced by `pnpm --filter @fincore/api scenario incidents` against a real stack: embedded PostgreSQL 16, the real analytics service and the API with the SIMULATED provider. The full raw output (timestamps, queries, results) is in [`evidence/15/incident-reproductions.txt`](../../evidence/15/incident-reproductions.txt).

All postmortems are blameless. "Impact" describes the simulated environment; no real funds or people exist.

---

## INC-1: Duplicate and out-of-order payment events

**Timeline (UTC, 2026-11-27):**

- 17:21:17: a top-up of ₹250.00 was confirmed.
- The provider delivered each event **10 times**, in **reverse order** (`succeeded` before `processing`).
- 17:21:18: the worker processed `payment.succeeded`; the late `payment.processing` was marked `IGNORED`.

**Impact:** none. The wallet was credited exactly once: one `TOPUP` journal, with `deliveries = 10` on each event row.

**Root cause:** providers deliver at least once, with no ordering guarantee (simulated by fault injection).

**Why it was safe:**

- UNIQUE `(provider, provider_event_id)` in the inbox;
- order-independent processing driven by the state machine;
- a state guard (`SUCCEEDED` is never credited again);
- the job is idempotent under re-runs.

**Corrective action:** none needed in code. An `OutboxBacklog` alert now catches storms.

**Prevention:** the webhook replay and out-of-order tests in CI (`payments.test.ts`).

**Proof of recovery:** `SELECT reference_id, count(*) FROM transactions WHERE kind='TOPUP' GROUP BY 1 HAVING count(*) > 1` returns 0 rows.

## INC-2: Mismatched provider settlement

**Timeline:** at 17:21:18 the provider paid out ₹240.00 against ₹250.00 of captured payments. Reconciliation then ran automatically (job `settlement.reconcile`).

**Impact:** a ₹10.00 receivable gap. Item outcome: `AMOUNT_MISMATCH`, `diff_minor = 1000`.

**Root cause:** the provider short-paid (simulated, e.g. an undisclosed fee).

**Detection:** reconciliation in analytics (Decimal); settlement set to `MISMATCHED`; a `SETTLEMENT_MISMATCH` alert with score 80.

**Containment:** the books stayed balanced. The bank was debited ₹240, clearing credited ₹250, and suspense debited ₹10, so nothing was lost or hidden.

**Corrective action:** finance contacts the provider; on recovery, `POST /settlements/{id}/resolve` (runbook `settlement-mismatch.md`).

**Prevention:** a daily reconciliation job, plus an alert on any suspense balance older than 3 days (follow-up).

## INC-3: Attempt to post an unbalanced journal

**Timeline:** at 17:21:18 a buggy "adjustment" path inserted a journal header and a single CREDIT line of ₹50.00 to a wallet.

**Impact:** none. At COMMIT the deferred trigger raised `FC002 transaction … has 1 ledger entries; at least 2 are required`, and the whole transaction rolled back.

**Root cause:** an application bug (simulated): a posting path that bypassed `postJournal()`.

**Detection:** the database refused it; the error was logged with its `request_id`. If a superuser had forced it in, the `fincore_ledger_invariant_violations` metric would fire `LedgerInvariantViolated`.

**Corrective action:** every posting goes through `postJournal()`, which sorts and validates lines.

**Prevention:**

- the DB constraint (defense in depth);
- the CI invariant check after every DB test;
- the scripted proof in `scripts/ledger-proof.sql`.

## INC-4: Latency spike / analytics outage

**Timeline:**

- 17:21:18: baseline of 20 transfers measured (latencies in the evidence file).
- 17:21:19: the analytics process was killed.
- The next transfer returned `503 UPSTREAM_UNAVAILABLE` within the configured timeout, and its idempotency key was released.

**Impact:** transfers were unavailable while analytics was down. Correctly, no transfer was posted with a guessed fee.

**Root cause:** a dependency outage (simulated).

**Why it degraded safely:**

- timeouts on every outbound call;
- a circuit breaker (opens after 5 failures, so later calls fail fast);
- fail-closed for fees and fail-safe for risk (large transfers held);
- clients retry with the same Idempotency-Key.

**Corrective action:** restart analytics; transfers resume. A retry with the same key succeeds exactly once.

**Prevention:**

- the `ApiHighLatencyP95` and `ApiErrorRate` alerts;
- a readiness check;
- a follow-up to run 2 analytics replicas.

## INC-5: Suspicious activity alert

**Timeline:** at 17:21:18 a new customer account sent 6 transfers in under a minute to a beneficiary added minutes earlier, then one transfer **60×** its average.

**Detection:** analytics scored it **85**, with reasons `VELOCITY_HIGH`, `AMOUNT_SPIKE`, `NEW_BENEFICIARY` and `NEW_ACCOUNT`. That is at or above the review threshold of 70, so the API placed a hold and returned **202 PENDING**, and a `TRANSFER_RISK` alert was raised.

**Response:** an ops analyst moved the alert to `INVESTIGATING`, then `ESCALATED` it. The transfer became `FAILED` and the hold was released; no money moved.

**Root cause:** suspicious behaviour (simulated). **The score is decision support only; a human made the decision.**

**Prevention / follow-up:** tune the thresholds on synthetic populations (`tests/test_risk_and_api.py` checks that suspicious populations score higher), and keep the explainable reasons for customer communication.

---

**Proof of recovery for all incidents:** after the run, `ledger_invariant_violations()` returned 0 rows, Σ debits = Σ credits per currency, no journal or credit was duplicated, and no wallet was below zero. The script ends `RESULT: ALL CHECKS PASSED`.
