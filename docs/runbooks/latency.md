# Runbook: latency spike / dependency outage

1. **Start in Grafana:** p95 latency per route (`http_request_duration_seconds`) and the 5xx rate. `/transfers` calls analytics twice: the fee (1.5 s timeout) and the risk score (300 ms).
2. **If analytics is down:**
   - Transfers return `503 UPSTREAM_UNAVAILABLE`. The fee cannot be quoted, so the API fails closed rather than guess an amount.
   - The circuit breaker opens after 5 failures, so later calls fail fast instead of piling up.
   - Clients retry with the same Idempotency-Key.
   - If only risk scoring is down, the fail-safe policy applies: transfers of ₹10,000 or more are held for review.
3. **If transactions are waiting on locks:**
   - Money transactions set `lock_timeout = 3s` and map lock timeouts to 503.
   - Look for long-running transactions:
     ```sql
     SELECT pid, now() - xact_start, state, query FROM pg_stat_activity WHERE state <> 'idle' ORDER BY 2 DESC;
     ```
4. **If one wallet is hot:** transactions on a single wallet serialise on its balance row by design (ADR-003). Some queuing is expected during bursts.

**Reproduce:** INC-4 (baseline p50/p95 latency, then the outage).
