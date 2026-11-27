# Runbook: stuck jobs / dead letters

1. **Check the backlog:**
   ```sql
   SELECT topic, status, count(*), min(next_attempt_at) FROM outbox GROUP BY 1, 2;
   ```
   Confirm the workers are up: `/readyz` on port 4100.
2. **After a worker crash:** its jobs are re-claimed automatically once their 60 s lease expires. Handlers check state before acting, so a re-run cannot apply an effect twice.
3. **Dead letters:**
   1. List them with `GET /api/v1/admin/failed-jobs` and read the `error` field.
   2. Fix the cause (for example, restore analytics).
   3. Replay with `POST /admin/failed-jobs/{id}/replay` (admin, with step-up). Each failure can be replayed once.
4. **Email jobs failing** means SMTP/Mailpit is down. They retry with backoff; notification delivery is at-least-once.

**Reproduce:** `apps/api/test/payments.test.ts`, the jobs section.
