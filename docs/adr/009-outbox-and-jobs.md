# ADR-009: Transactional outbox as a Postgres job queue (instead of BullMQ)

- Status: Accepted (Phase 4). Supersedes the BullMQ plan in PLAN §2.
- Date: 2026-11-28

**Context.** Side effects (notifications, webhook processing, reconciliation, refund submission) must happen if and only if the business change committed. They must also be retry-safe, and failed work must be recoverable.

The user asked to proceed without Docker. No Redis can run locally on Windows, which would leave BullMQ code untestable here.

**Decision.** The `outbox` table _is_ the queue.

- Rows are written in the same transaction as the business change. `dedupe_key` is UNIQUE.
- Workers claim rows with `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` and a **60 s lease**. A crashed worker's job becomes visible again after the lease expires.
- Retries use exponential backoff with full jitter. After 5 attempts a job becomes `DEAD` and goes to `failed_jobs`. Replay is `POST /admin/failed-jobs/{id}/replay` (admin, with step-up).
- Every handler checks state before acting, so at-least-once execution never double-applies money (tested: crash-mid-job, replay).

**Trade-offs:**

- Polling adds about 500 ms of latency, and throughput is bounded by Postgres. Both are fine at this scale.
- Redis is still used, but only for rate limiting and caching, where losing data is harmless.
- BullMQ could be reintroduced as a dispatcher fed by the outbox, without changing the handlers.
