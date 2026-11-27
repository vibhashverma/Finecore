# Live technical review: preparation

## 60-second architecture

Next.js UI → Caddy → Express API (owns every write) → PostgreSQL 16, the system of record, where the ledger rules are enforced by triggers, constraints and grants.

FastAPI analytics does Decimal fees and interest, reconciliation diffs and explainable risk scores. It is stateless apart from read-only views.

Workers drain a transactional outbox (a Postgres job queue) for webhooks, reconciliation, refunds and notifications.

## Likely questions, with short answers

**How do you guarantee the ledger balances?**
A deferred constraint trigger checks Σ debits = Σ credits and at least two lines at COMMIT. Lines can only be added in the database transaction that created the journal. A global invariant function runs in tests, the capstone and as a metric.

**What stops an overdraft under concurrency?**

1. An app-level check after locking balance rows in ascending id order.
2. A DB CHECK `posted − held ≥ floor` on trigger-maintained balances.

50 concurrent requests produce exactly floor(balance ÷ amount) successes.

**Why pessimistic locking?**
Hot wallets cause optimistic-locking retry storms. Ordered locks make deadlocks impossible between transfers. Transactions are short, and there is no network I/O while locks are held.

**What happens on a retry after a timeout?**
The Idempotency-Key response commits in the same transaction as the money movement, so the retry gets the stored response.

**What about duplicate webhooks?**
The inbox has a UNIQUE provider event id. Processing follows the state machine, so out-of-order events are safe.

**Can the app delete ledger rows?**
No. It has no grant, and a trigger blocks even the owner. A superuser could bypass the triggers, but the audit hash chain would show it.

**Why floats nowhere?**
`BIGINT` minor units in the DB; `bigint` in TypeScript (the pg int8 parser and the JSON replacer); strings on the wire; `Decimal` in Python; floats rejected by both schemas.

**How is the risk score used?**
It's explainable decision support. A score of 70 or more puts a hold on the funds and an analyst decides. It is never proof of fraud.

**What is mocked?**
See [LIMITATIONS.md](LIMITATIONS.md): the provider is a SIMULATOR (the Stripe adapter is untested), SMS is a MOCK, email goes to the Mailpit sandbox, MFA delivery is SIMULATED, all funds and KYC are SIMULATED, and the VM deployment hasn't been executed.

## Live-change drills (where to edit)

**Change the transfer limit or the step-up threshold.**

- Edit `TRANSFER_MAX_MINOR` / `TRANSFER_REAUTH_THRESHOLD_MINOR` in `apps/api/src/config.ts` (or the environment).
- Test in `transfers.test.ts` › "over the per-transfer limit".

**Add a new fee rule.**

- Add a new migration inserting into `fee_schedules` with a new `effective_from` (versioned, never edited).
- Update `calculations.py` and its tests only if the formula changes.

**Add a risk rule.**

- Edit `services/analytics/src/fincore_analytics/risk.py` with a new `add(code, detail, weight)`.
- Test in `test_risk_and_api.py`.

**Debug an injected defect.**

1. Get the `request_id` from the response or the UI error reference.
2. Search the JSON logs for it.
3. Inspect `audit_log` and `state_transitions` (they record the request id).
4. Run `SELECT * FROM ledger_invariant_violations()`.
5. Reproduce in a test, fix, and add a regression test.

## Commands

```bash
pnpm test                                   # all TS suites (DB tests on embedded Postgres 16)
cd services/analytics && uv run pytest      # analytics
pnpm --filter @fincore/api scenario capstone
pnpm --filter @fincore/api scenario incidents
API_INTERNAL_URL=http://127.0.0.1:4400 pnpm build && pnpm --filter @fincore/web test:e2e
```
