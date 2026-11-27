import type { Deps } from "../deps.js";
import { processProviderEvent, reconcileSettlement } from "../modules/payments.js";

/**
 * Postgres-backed job queue over the transactional outbox (ADR-009).
 *  - claim: `FOR UPDATE SKIP LOCKED` + a 60 s lease (a crashed worker's job is retried after the lease);
 *  - retry: exponential backoff with jitter, up to MAX_ATTEMPTS, then DEAD + failed_jobs (admin replay);
 *  - every handler is idempotent (state-checked), so at-least-once delivery never double-applies money.
 */
export const MAX_ATTEMPTS = 5;
export type JobHandler = (
  deps: Deps,
  payload: Record<string, string>,
  ctx: { jobId: string; requestId: string },
) => Promise<void>;

async function notifyCustomerOfTransfer(
  deps: Deps,
  transferId: string,
  event: string,
  jobId: string,
) {
  const r = await deps.db.query<{
    email: string;
    user_id: string;
    amount_minor: bigint;
    currency: string;
    status: string;
  }>(
    `SELECT u.email, u.id AS user_id, t.amount_minor, t.currency, t.status FROM transfers t
       JOIN customers c ON c.id = t.customer_id JOIN users u ON u.id = c.user_id WHERE t.id = $1`,
    [transferId],
  );
  const t = r.rows[0];
  if (!t) return;
  const text = `Your SIMULATED transfer of ${t.amount_minor} minor units ${t.currency} is now ${t.status}. Reference ${transferId}.`;
  await deps.notifier.email(t.email, `Transfer ${event}`, text, `job-${jobId}`);
  await deps.notifier.sms(t.user_id, text);
}

export const JOB_HANDLERS: Record<string, JobHandler> = {
  "transfer.posted": (d, p, c) =>
    notifyCustomerOfTransfer(d, p.transfer_id as string, "posted", c.jobId),
  "transfer.reversed": (d, p, c) =>
    notifyCustomerOfTransfer(d, p.transfer_id as string, "reversed", c.jobId),
  "transfer.failed": (d, p, c) =>
    notifyCustomerOfTransfer(d, p.transfer_id as string, "failed", c.jobId),
  "payment.succeeded": async (d, p, c) => {
    const r = await d.db.query<{ email: string }>(
      `SELECT u.email FROM payment_intents pi JOIN customers cu ON cu.id = pi.customer_id JOIN users u ON u.id = cu.user_id WHERE pi.id = $1`,
      [p.payment_intent_id],
    );
    if (r.rows[0])
      await d.notifier.email(
        r.rows[0].email,
        "Top-up received",
        "Your SIMULATED top-up has been credited.",
        `job-${c.jobId}`,
      );
  },
  "risk.alert_created": (d, p, c) =>
    d.notifier.email(
      "ops-alerts@fincore.test",
      "New risk alert",
      `Alert ${p.alert_id} needs review (decision support only).`,
      `job-${c.jobId}`,
    ),
  "provider.event": (d, p, c) =>
    processProviderEvent(d, p.provider_event_row_id as string, c.requestId),
  "settlement.reconcile": async (d, p, c) => {
    const s = await d.db.query<{ status: string }>(`SELECT status FROM settlements WHERE id = $1`, [
      p.settlement_id,
    ]);
    if (s.rows[0]?.status === "EXPECTED")
      await reconcileSettlement(d, p.settlement_id as string, c.requestId);
  },
  "refund.submit": async (d, p) => {
    const r = await d.db.query<{
      id: string;
      status: string;
      amount_minor: bigint;
      provider_ref: string;
    }>(
      `SELECT rf.id, rf.status, rf.amount_minor, pi.provider_ref FROM refunds rf JOIN payment_intents pi ON pi.id = rf.payment_intent_id WHERE rf.id = $1`,
      [p.refund_id],
    );
    const rf = r.rows[0];
    if (!rf || rf.status !== "REQUESTED") return; // already submitted
    // The provider dedupes by refund id, so a retry after a crash cannot refund twice.
    const out = await d.provider.refund({
      refundId: rf.id,
      providerRef: rf.provider_ref,
      amountMinor: rf.amount_minor,
    });
    await d.db.query(
      `UPDATE refunds SET provider_ref = coalesce(provider_ref, $2), status = 'PROCESSING' WHERE id = $1 AND status = 'REQUESTED'`,
      [rf.id, out.providerRef],
    );
  },
};

export interface RunResult {
  done: number;
  retried: number;
  dead: number;
}

export async function runDueJobs(
  deps: Deps,
  batch = 10,
  handlers: Record<string, JobHandler> = JOB_HANDLERS,
): Promise<RunResult> {
  const claimed = await deps.db.query<{
    id: bigint;
    topic: string;
    payload: Record<string, string>;
    attempts: number;
  }>(
    `UPDATE outbox SET attempts = attempts + 1, next_attempt_at = now() + interval '60 seconds'
      WHERE id IN (SELECT id FROM outbox WHERE status = 'PENDING' AND next_attempt_at <= now()
                    ORDER BY next_attempt_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, topic, payload, attempts`,
    [batch],
  );
  const result: RunResult = { done: 0, retried: 0, dead: 0 };
  for (const job of claimed.rows) {
    const jobId = job.id.toString();
    const requestId = `job_${jobId}`;
    try {
      const handler = handlers[job.topic];
      if (!handler) throw new Error(`no handler for topic ${job.topic}`);
      await handler(deps, job.payload, { jobId, requestId });
      await deps.db.query(
        `UPDATE outbox SET status = 'DONE', processed_at = now(), last_error = NULL WHERE id = $1`,
        [job.id],
      );
      result.done++;
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      deps.logger.warn(
        { request_id: requestId, topic: job.topic, attempts: job.attempts, err: message },
        "job failed",
      );
      if (job.attempts >= MAX_ATTEMPTS) {
        await deps.db.query(`UPDATE outbox SET status = 'DEAD', last_error = $2 WHERE id = $1`, [
          job.id,
          message,
        ]);
        await deps.db.query(
          `INSERT INTO failed_jobs (outbox_id, topic, error, attempts) VALUES ($1, $2, $3, $4) ON CONFLICT (outbox_id) DO UPDATE SET error = EXCLUDED.error, attempts = EXCLUDED.attempts, failed_at = now(), replayed_at = NULL`,
          [job.id, job.topic, message, job.attempts],
        );
        result.dead++;
      } else {
        const delayMs = Math.round(Math.random() * 1000 * 2 ** job.attempts); // full jitter
        await deps.db.query(
          `UPDATE outbox SET next_attempt_at = now() + make_interval(secs => $2::double precision / 1000), last_error = $3 WHERE id = $1`,
          [job.id, delayMs, message],
        );
        result.retried++;
      }
    }
  }
  return result;
}

/** Periodic maintenance: expire idempotency keys (24 h) and release expired holds. */
export async function housekeeping(deps: Deps): Promise<void> {
  await deps.db.query(`DELETE FROM idempotency_keys WHERE expires_at < now()`);
  await deps.db.query(
    `UPDATE holds SET status = 'RELEASED' WHERE status = 'ACTIVE' AND expires_at < now()`,
  );
}

/** Worker loop with graceful drain: stop() waits for the in-flight batch to finish. */
export function startJobLoop(deps: Deps, intervalMs = 500) {
  let stopped = false;
  let lastHousekeeping = 0;
  const loop = (async () => {
    while (!stopped) {
      try {
        const r = await runDueJobs(deps);
        if (Date.now() - lastHousekeeping > 60_000) {
          await housekeeping(deps);
          lastHousekeeping = Date.now();
        }
        if (r.done + r.retried + r.dead > 0) continue; // drain quickly while there is work
      } catch (err) {
        deps.logger.error({ err }, "job loop error");
      }
      await new Promise((res) => setTimeout(res, intervalMs));
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}
