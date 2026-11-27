# ADR-010: Payment provider adapter

- Status: Accepted (Phase 7)
- Date: 2026-11-28

**Decision.** A `PaymentProvider` port with two adapters.

**`SimulatedProvider` (SIMULATED).** The default, used in all tests, E2E and the capstone.

- Deterministic.
- Asynchronous signed webhooks.
- Failure injection: duplicate deliveries, reversed order, outage, payout short-pay and payout failure.

**`StripeTestProvider` (TEST MODE).**

- Form-encoded REST calls with an `Idempotency-Key` per operation.
- **Refuses any key that isn't `sk_test_`**, both in config validation and in the constructor.
- Maps Stripe webhook types onto FinCore's neutral events.
- Not exercised by automated tests: it needs a Stripe test account (LIMITATIONS).

**Webhooks.**

- HMAC-SHA256 over `t.rawBody`, using the same scheme as Stripe.
- 5-minute tolerance and a constant-time compare.
- The raw body is preserved (the webhook route bypasses the JSON parser).
- Events are deduplicated by `(provider, provider_event_id)`, then processed asynchronously and independently of arrival order.

**No network I/O while holding DB locks.** Provider calls happen between transactions. A failure marks the intent and returns 503 with the idempotency key released.
