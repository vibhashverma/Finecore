# Assessment 08: Payment and notification integrations

**Status:** complete with the SIMULATED provider. The Stripe test-mode adapter is written but not exercised, because it needs a Stripe test account (ADR-010).

**Payment provider:**

- `SimulatedProvider`: asynchronous signed webhooks, with fault injection.
- `StripeTestProvider`: `sk_test_` keys only, with an idempotency key on every call.

**Webhooks:**

- HMAC-SHA256 over the raw body, 5-minute tolerance, constant-time compare.
- A bad signature or stale timestamp returns 400 and is audited.
- Events are deduplicated by provider event id.
- The endpoint returns 200 immediately; processing is asynchronous and doesn't depend on arrival order.

**Reconciliation:** provider ids are matched to payment intents via settlement lines; the analytics service computes the diffs.

**Notifications:** email goes to the Mailpit SMTP sandbox; SMS is a MOCK that only logs.

**Resilience (`src/lib/resilience.ts`):**

- timeouts on every call;
- retries with exponential backoff and full jitter, for idempotent calls only;
- a circuit breaker.

**Tests (`payments.test.ts`):**

- top-up; webhook replay ×4; out-of-order events; declines;
- bad and stale signatures; unknown references; provider outage;
- refunds;
- matched, short and failed settlements;
- notification retry, worker crash, dead-lettering and replay.
