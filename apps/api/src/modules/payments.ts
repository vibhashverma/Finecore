import { DB_ERROR, isPgError } from "@fincore/db";
import { Router, type Response } from "express";
import { z } from "zod";
import {
  assertRecentReauth,
  customerIdOf,
  getAuth,
  requirePermission,
} from "../auth/middleware.js";
import type { Deps } from "../deps.js";
import { mapStripeEvent, verifySignature, type ProviderEvent } from "../integrations/provider.js";
import { audit } from "../lib/audit.js";
import {
  enqueue,
  lockBalances,
  postJournal,
  systemAccountId,
  withTx,
  type JournalLine,
  type Tx,
} from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { amountMinor, idParam, ok, parse, route } from "../lib/http.js";
import { runIdempotent } from "../lib/idempotency.js";
import { afterCursor, decodeCursor, page, pageQuery } from "../lib/pagination.js";

export const intentCreateBody = z.object({ wallet_id: z.uuid(), amount_minor: amountMinor });
export const intentConfirmBody = z.object({
  // SIMULATED test payment methods (or Stripe test cards like pm_card_visa in STRIPE_TEST mode). Never real cards.
  payment_method: z.enum([
    "pm_simulated_success",
    "pm_simulated_decline",
    "pm_card_visa",
    "pm_card_chargeDeclined",
  ]),
});
export const refundCreateBody = z.object({
  payment_intent_id: z.uuid(),
  amount_minor: amountMinor,
  reason: z.string().trim().min(3).max(500),
});
export const settlementResolveBody = z.object({
  recovered_minor: z
    .string()
    .regex(/^\d{1,16}$/)
    .transform(BigInt),
  note: z.string().trim().min(3).max(1000),
});

const eventSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.enum([
    "payment.processing",
    "payment.succeeded",
    "payment.failed",
    "refund.succeeded",
    "refund.failed",
    "payout.paid",
    "payout.failed",
  ]),
  created: z.number().int(),
  data: z.record(z.string(), z.unknown()),
});

interface IntentRow {
  id: string;
  customer_id: string;
  wallet_id: string;
  amount_minor: bigint;
  refunded_minor: bigint;
  currency: string;
  status: string;
  provider: string;
  provider_ref: string | null;
  transaction_id: string | null;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
}
const intentView = (p: IntentRow) => ({ ...p, simulated: true });

// ---- Provider event processing (runs in the job worker; idempotent and order-independent) -----------------------
async function setIntentStatus(c: Tx, id: string, to: string, extra = "") {
  await c.query(`UPDATE payment_intents SET status = $2 ${extra} WHERE id = $1`, [id, to]);
}

async function walletAccount(c: Tx, walletId: string) {
  const r = await c.query<{ account_id: string }>(`SELECT account_id FROM wallets WHERE id = $1`, [
    walletId,
  ]);
  return r.rows[0]?.account_id as string;
}

async function anomaly(c: Tx, detail: string, customerId: string | null = null) {
  await c.query(
    `INSERT INTO risk_alerts (kind, customer_id, score, reasons) VALUES ('WEBHOOK_ANOMALY', $1, 50, $2)`,
    [customerId, JSON.stringify([{ code: "WEBHOOK_ANOMALY", detail, weight: 50 }])],
  );
}

/** Applies one inbox event. Out-of-order and duplicate events are resolved by the state machine, not arrival order. */
export async function processProviderEvent(
  deps: Deps,
  eventRowId: string,
  requestId: string,
): Promise<void> {
  await withTx(deps.db, { requestId, reason: "provider webhook" }, async (c) => {
    const er = await c.query<{
      id: string;
      provider: string;
      type: ProviderEvent["type"];
      payload: ProviderEvent;
      status: string;
    }>(`SELECT id, provider, type, payload, status FROM provider_events WHERE id = $1 FOR UPDATE`, [
      eventRowId,
    ]);
    const ev = er.rows[0];
    if (!ev || ev.status !== "RECEIVED") return; // already handled: replay-safe
    const d = ev.payload.data;
    let outcome: "PROCESSED" | "IGNORED" | "FAILED" = "PROCESSED";
    let error: string | null = null;

    if (ev.type.startsWith("payment.")) {
      const pr = await c.query<IntentRow>(
        `SELECT * FROM payment_intents WHERE provider = $1 AND provider_ref = $2 FOR UPDATE`,
        [ev.provider, String(d.provider_ref)],
      );
      const pi = pr.rows[0];
      if (!pi) {
        outcome = "FAILED";
        error = "unknown payment reference";
        await anomaly(c, `event ${ev.payload.id}: unknown payment reference`);
      } else if (
        d.amount_minor !== undefined &&
        String(d.amount_minor) !== pi.amount_minor.toString()
      ) {
        outcome = "FAILED";
        error = "amount does not match the payment intent";
        await anomaly(c, `event ${ev.payload.id}: amount mismatch`, pi.customer_id);
      } else if (ev.type === "payment.processing") {
        if (pi.status === "REQUIRES_CONFIRMATION") await setIntentStatus(c, pi.id, "PROCESSING");
        else outcome = "IGNORED"; // late/out-of-order: state already moved on
      } else if (ev.type === "payment.succeeded") {
        if (pi.status === "REQUIRES_CONFIRMATION") await setIntentStatus(c, pi.id, "PROCESSING"); // processing event lost/late
        if (pi.status === "REQUIRES_CONFIRMATION" || pi.status === "PROCESSING") {
          const walletAcc = await walletAccount(c, pi.wallet_id);
          await lockBalances(c, [walletAcc]);
          const txn = await postJournal(c, {
            kind: "TOPUP",
            currency: pi.currency,
            description: "Wallet top-up (SIMULATED card payment)",
            referenceType: "payment_intent",
            referenceId: pi.id,
            lines: [
              {
                accountId: await systemAccountId(c, "PROVIDER_CLEARING", pi.currency),
                direction: "DEBIT",
                amount: pi.amount_minor,
              },
              { accountId: walletAcc, direction: "CREDIT", amount: pi.amount_minor },
            ],
          });
          await c.query(
            `UPDATE payment_intents SET status = 'SUCCEEDED', transaction_id = $2 WHERE id = $1`,
            [pi.id, txn],
          );
          await enqueue(
            c,
            "payment.succeeded",
            { payment_intent_id: pi.id },
            `payment.succeeded:${pi.id}`,
          );
        } else if (pi.status === "SUCCEEDED") {
          outcome = "IGNORED"; // a second success event for the same payment: never credit twice
        } else {
          outcome = "FAILED";
          error = `success received for a ${pi.status} payment`;
          await anomaly(
            c,
            `payment ${pi.id} succeeded at provider but is ${pi.status} internally: reconcile`,
            pi.customer_id,
          );
        }
      } else if (ev.type === "payment.failed") {
        if (pi.status === "REQUIRES_CONFIRMATION") await setIntentStatus(c, pi.id, "PROCESSING");
        if (pi.status === "REQUIRES_CONFIRMATION" || pi.status === "PROCESSING") {
          await setIntentStatus(c, pi.id, "FAILED", ", failure_code = 'PROVIDER_DECLINED'");
        } else outcome = "IGNORED";
      }
    } else if (ev.type.startsWith("refund.")) {
      const rr = await c.query<{
        id: string;
        payment_intent_id: string;
        amount_minor: bigint;
        status: string;
      }>(
        `SELECT id, payment_intent_id, amount_minor, status FROM refunds WHERE id = $1 FOR UPDATE`,
        [String(d.refund_id)],
      );
      const rf = rr.rows[0];
      if (!rf) {
        outcome = "FAILED";
        error = "unknown refund";
      } else if (rf.status === "SUCCEEDED" || rf.status === "FAILED") {
        outcome = "IGNORED";
      } else {
        if (rf.status === "REQUESTED")
          await c.query(`UPDATE refunds SET status = 'PROCESSING' WHERE id = $1`, [rf.id]);
        const pi = (
          await c.query<IntentRow>(`SELECT * FROM payment_intents WHERE id = $1 FOR UPDATE`, [
            rf.payment_intent_id,
          ])
        ).rows[0] as IntentRow;
        const walletAcc = await walletAccount(c, pi.wallet_id);
        await lockBalances(c, [walletAcc]);
        const hold = `SELECT id FROM holds WHERE reference_type = 'refund' AND reference_id = $1 AND status = 'ACTIVE'`;
        if (ev.type === "refund.succeeded") {
          await c.query(`UPDATE holds SET status = 'CAPTURED' WHERE id IN (${hold})`, [rf.id]);
          const txn = await postJournal(c, {
            kind: "REFUND",
            currency: pi.currency,
            description: "Refund to card (SIMULATED)",
            referenceType: "refund",
            referenceId: rf.id,
            lines: [
              { accountId: walletAcc, direction: "DEBIT", amount: rf.amount_minor },
              {
                accountId: await systemAccountId(c, "PROVIDER_CLEARING", pi.currency),
                direction: "CREDIT",
                amount: rf.amount_minor,
              },
            ],
          });
          await c.query(
            `UPDATE refunds SET status = 'SUCCEEDED', provider_ref = $2, transaction_id = $3 WHERE id = $1`,
            [rf.id, String(d.provider_ref ?? ""), txn],
          );
        } else {
          await c.query(`UPDATE holds SET status = 'RELEASED' WHERE id IN (${hold})`, [rf.id]);
          await c.query(
            `UPDATE payment_intents SET refunded_minor = refunded_minor - $2 WHERE id = $1`,
            [pi.id, rf.amount_minor.toString()],
          );
          await c.query(`UPDATE refunds SET status = 'FAILED' WHERE id = $1`, [rf.id]);
        }
      }
    } else if (ev.type === "payout.paid" || ev.type === "payout.failed") {
      const lines = z
        .array(z.object({ provider_ref: z.string(), amount_minor: z.string().regex(/^\d+$/) }))
        .parse(d.lines ?? []);
      const currency = String(d.currency);
      const exp = await c.query<{ expected: bigint }>(
        `SELECT coalesce(sum(amount_minor - refunded_minor), 0)::bigint AS expected FROM payment_intents
          WHERE provider = $1 AND provider_ref = ANY($2::text[]) AND status = 'SUCCEEDED'`,
        [ev.provider, lines.map((l) => l.provider_ref)],
      );
      const expected = exp.rows[0]?.expected ?? 0n;
      const s = await c.query<{ id: string }>(
        `INSERT INTO settlements (provider, provider_payout_id, currency, expected_minor, actual_minor, value_date)
         VALUES ($1, $2, $3, $4, $5, current_date) ON CONFLICT (provider, provider_payout_id) DO NOTHING RETURNING id`,
        [
          ev.provider,
          String(d.payout_id),
          currency,
          expected.toString(),
          ev.type === "payout.paid" ? String(d.amount_minor) : null,
        ],
      );
      const settlementId = s.rows[0]?.id;
      if (!settlementId)
        outcome = "IGNORED"; // same payout reported again under a new event id
      else {
        for (const l of lines)
          await c.query(
            `INSERT INTO settlement_lines (settlement_id, provider_ref, amount_minor) VALUES ($1, $2, $3)`,
            [settlementId, l.provider_ref, l.amount_minor],
          );
        if (ev.type === "payout.paid") {
          await enqueue(
            c,
            "settlement.reconcile",
            { settlement_id: settlementId },
            `settlement.reconcile:${settlementId}`,
          );
        } else {
          // Failed settlement: the receivable moves to suspense and ops are alerted. Recoverable via /settlements/:id/resolve.
          await c.query(`UPDATE settlements SET status = 'FAILED' WHERE id = $1`, [settlementId]);
          await postJournal(c, {
            kind: "SETTLEMENT",
            currency,
            description: `Failed provider payout ${String(d.payout_id)} moved to suspense`,
            referenceType: "settlement",
            referenceId: settlementId,
            lines: [
              {
                accountId: await systemAccountId(c, "SETTLEMENT_SUSPENSE", currency),
                direction: "DEBIT",
                amount: expected,
              },
              {
                accountId: await systemAccountId(c, "PROVIDER_CLEARING", currency),
                direction: "CREDIT",
                amount: expected,
              },
            ],
          });
          await c.query(
            `INSERT INTO risk_alerts (kind, settlement_id, score, reasons) VALUES ('SETTLEMENT_FAILED', $1, 90, $2)`,
            [
              settlementId,
              JSON.stringify([
                {
                  code: "SETTLEMENT_FAILED",
                  detail: `payout ${String(d.payout_id)} failed`,
                  weight: 90,
                },
              ]),
            ],
          );
        }
      }
    }
    await c.query(
      `UPDATE provider_events SET status = $2, error = $3, processed_at = now() WHERE id = $1`,
      [ev.id, outcome, error],
    );
  });
}

/** Compares a settlement's lines with the ledger (analytics, Decimal) and posts the settlement journal. */
export async function reconcileSettlement(
  deps: Deps,
  settlementId: string,
  requestId: string,
  actorId?: string,
): Promise<string> {
  const s = (
    await deps.db.query<{
      id: string;
      provider: string;
      currency: string;
      status: string;
      expected_minor: bigint;
      actual_minor: bigint | null;
    }>(
      `SELECT id, provider, currency, status, expected_minor, actual_minor FROM settlements WHERE id = $1`,
      [settlementId],
    )
  ).rows[0];
  if (!s) throw new AppError("NOT_FOUND", "Settlement not found.");
  if (s.status !== "EXPECTED")
    throw new AppError("INVALID_STATE_TRANSITION", `Settlement is already ${s.status}.`);
  const providerLines = (
    await deps.db.query<{ provider_ref: string; amount_minor: bigint }>(
      `SELECT provider_ref, amount_minor FROM settlement_lines WHERE settlement_id = $1`,
      [settlementId],
    )
  ).rows;
  const internal = (
    await deps.db.query<{ provider_ref: string; amount_minor: bigint }>(
      `SELECT provider_ref, (amount_minor - refunded_minor) AS amount_minor FROM payment_intents
      WHERE provider = $1 AND provider_ref = ANY($2::text[]) AND status = 'SUCCEEDED'`,
      [s.provider, providerLines.map((l) => l.provider_ref)],
    )
  ).rows;
  const result = await deps.analytics.compareReconciliation(internal, providerLines, requestId);
  const actual = s.actual_minor ?? 0n;
  return withTx(deps.db, { actorId, requestId, reason: "reconciliation" }, async (c) => {
    const lock = await c.query<{ status: string }>(
      `SELECT status FROM settlements WHERE id = $1 FOR UPDATE`,
      [settlementId],
    );
    if (lock.rows[0]?.status !== "EXPECTED")
      throw new AppError("INVALID_STATE_TRANSITION", "Settlement was reconciled concurrently.");
    const run = await c.query<{ id: string }>(
      `INSERT INTO reconciliation_runs (settlement_id, created_by) VALUES ($1, $2) RETURNING id`,
      [settlementId, actorId ?? null],
    );
    const runId = run.rows[0]?.id as string;
    for (const it of result.items) {
      await c.query(
        `INSERT INTO reconciliation_items (run_id, provider_ref, payment_intent_id, outcome, expected_minor, actual_minor, diff_minor)
         VALUES ($1, $2, (SELECT id FROM payment_intents WHERE provider = $3 AND provider_ref = $2), $4, $5, $6, $7)`,
        [
          runId,
          it.provider_ref,
          s.provider,
          it.outcome,
          it.expected_minor.toString(),
          it.actual_minor.toString(),
          it.diff_minor.toString(),
        ],
      );
    }
    const matched =
      result.items.every((i) => i.outcome === "MATCHED") && actual === s.expected_minor;
    const diff = s.expected_minor - actual; // > 0: provider paid less than owed
    const lines: JournalLine[] = [
      {
        accountId: await systemAccountId(c, "SETTLEMENT_BANK", s.currency),
        direction: "DEBIT",
        amount: actual,
      },
      {
        accountId: await systemAccountId(c, "PROVIDER_CLEARING", s.currency),
        direction: "CREDIT",
        amount: s.expected_minor,
      },
    ];
    if (!matched && diff !== 0n) {
      lines.push({
        accountId: await systemAccountId(c, "SETTLEMENT_SUSPENSE", s.currency),
        direction: diff > 0n ? "DEBIT" : "CREDIT",
        amount: diff > 0n ? diff : -diff,
      });
    }
    if (actual > 0n || s.expected_minor > 0n) {
      await postJournal(c, {
        kind: "SETTLEMENT",
        currency: s.currency,
        description: `Provider settlement ${settlementId}`,
        referenceType: "settlement",
        referenceId: settlementId,
        createdBy: actorId,
        lines,
      });
    }
    await c.query(`UPDATE settlements SET status = $2 WHERE id = $1`, [
      settlementId,
      matched ? "MATCHED" : "MISMATCHED",
    ]);
    if (!matched) {
      await c.query(
        `INSERT INTO risk_alerts (kind, settlement_id, score, reasons) VALUES ('SETTLEMENT_MISMATCH', $1, 80, $2)`,
        [
          settlementId,
          JSON.stringify([
            {
              code: "SETTLEMENT_MISMATCH",
              detail: `expected ${s.expected_minor} received ${actual}`,
              weight: 80,
            },
          ]),
        ],
      );
    }
    await c.query(
      `UPDATE reconciliation_runs SET status = 'COMPLETED', completed_at = now(), summary = $2 WHERE id = $1`,
      [
        runId,
        JSON.stringify({
          expected_minor: s.expected_minor.toString(),
          actual_minor: actual.toString(),
          diff_minor: diff.toString(),
          items: result.items.length,
          matched,
        }),
      ],
    );
    await audit(c, {
      actorId,
      action: "reconciliation.run",
      resourceType: "settlement",
      resourceId: settlementId,
      outcome: "ALLOWED",
      requestId,
      metadata: { matched },
    });
    return runId;
  });
}

export function webhooksRouter(deps: Deps): Router {
  const r = Router();

  async function ingest(res: Response, provider: "SIMULATOR" | "STRIPE_TEST", ev: ProviderEvent) {
    const requestId = String(res.locals.requestId);
    const inserted = await withTx(deps.db, { requestId }, async (c) => {
      const q = await c.query<{ id: string; inserted: boolean }>(
        `INSERT INTO provider_events (provider, provider_event_id, type, payload) VALUES ($1, $2, $3, $4)
         ON CONFLICT (provider, provider_event_id) DO UPDATE SET deliveries = provider_events.deliveries + 1
         RETURNING id, (xmax = 0) AS inserted`,
        [provider, ev.id, ev.type, JSON.stringify(ev)],
      );
      const row = q.rows[0];
      if (row?.inserted)
        await enqueue(
          c,
          "provider.event",
          { provider_event_row_id: row.id },
          `provider.event:${row.id}`,
        );
      return row?.inserted ?? false;
    });
    // Acknowledge fast; processing happens in the worker. Duplicates are acknowledged but do nothing.
    ok(res, { received: true, duplicate: !inserted });
  }

  function rejectSignature(res: Response, provider: string): never {
    void audit(deps.db, {
      action: "webhook.signature_invalid",
      outcome: "DENIED",
      requestId: String(res.locals.requestId),
      metadata: { provider },
    });
    deps.logger.warn(
      { request_id: res.locals.requestId, provider },
      "webhook rejected: bad signature or stale timestamp",
    );
    throw new AppError("VALIDATION_ERROR", "Invalid webhook signature.");
  }

  r.post(
    "/webhooks/payments",
    route(async (req, res) => {
      const raw = req.body as Buffer;
      if (
        !Buffer.isBuffer(raw) ||
        !verifySignature(deps.config.WEBHOOK_SECRET, req.header("fincore-signature"), raw)
      )
        rejectSignature(res, "SIMULATOR");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new AppError("VALIDATION_ERROR", "Webhook body is not valid JSON.");
      }
      await ingest(res, "SIMULATOR", parse(eventSchema, parsed) as ProviderEvent);
    }),
  );

  // Stripe TEST MODE webhooks (same HMAC scheme). Only active when a Stripe webhook secret is configured.
  r.post(
    "/webhooks/stripe",
    route(async (req, res) => {
      const secret = deps.config.STRIPE_WEBHOOK_SECRET;
      if (!secret) throw new AppError("NOT_FOUND", "Stripe test mode is not configured.");
      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw) || !verifySignature(secret, req.header("stripe-signature"), raw))
        rejectSignature(res, "STRIPE_TEST");
      const mapped = mapStripeEvent(
        JSON.parse(raw.toString("utf8")) as Parameters<typeof mapStripeEvent>[0],
      );
      if (!mapped) return ok(res, { received: true, ignored: true });
      await ingest(res, "STRIPE_TEST", mapped);
    }),
  );
  return r;
}

export function paymentsRouter(deps: Deps): Router {
  const r = Router();
  const reqId = (res: Response) => String(res.locals.requestId);

  const loadOwnIntent = async (c: Tx, res: Response, id: string) => {
    const q = await c.query<IntentRow>(
      `SELECT * FROM payment_intents WHERE id = $1 AND customer_id = $2 FOR UPDATE`,
      [id, customerIdOf(res)],
    );
    const pi = q.rows[0];
    if (!pi) throw new AppError("NOT_FOUND", "Payment intent not found.");
    return pi;
  };

  r.post(
    "/payment-intents",
    requirePermission(deps, "payments:create"),
    route(async (req, res) => {
      const a = getAuth(res);
      await runIdempotent(deps.db, req, res, a.userId, async (finish) => {
        const body = parse(intentCreateBody, req.body);
        if (body.amount_minor > deps.config.TRANSFER_MAX_MINOR)
          throw new AppError("LIMIT_EXCEEDED", "Amount exceeds the top-up limit.");
        const w = (
          await deps.db.query<{ currency: string; status: string }>(
            `SELECT currency, status FROM wallets WHERE id = $1 AND customer_id = $2`,
            [body.wallet_id, customerIdOf(res)],
          )
        ).rows[0];
        if (!w) throw new AppError("NOT_FOUND", "Wallet not found.");
        if (w.status !== "ACTIVE")
          throw new AppError("INVALID_STATE_TRANSITION", "Wallet is not active.");
        const created = (
          await deps.db.query<IntentRow>(
            `INSERT INTO payment_intents (customer_id, wallet_id, amount_minor, currency, provider) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [
              customerIdOf(res),
              body.wallet_id,
              body.amount_minor.toString(),
              w.currency,
              deps.provider.name,
            ],
          )
        ).rows[0] as IntentRow;
        // Provider call OUTSIDE any DB transaction (no locks held during network I/O).
        let providerRef: string;
        try {
          ({ providerRef } = await deps.provider.createPayment({
            intentId: created.id,
            amountMinor: created.amount_minor,
            currency: created.currency,
          }));
        } catch {
          await deps.db.query(
            `UPDATE payment_intents SET status = 'CANCELED', failure_code = 'PROVIDER_UNAVAILABLE' WHERE id = $1`,
            [created.id],
          );
          throw new AppError(
            "UPSTREAM_UNAVAILABLE",
            "The payment provider is unavailable. Retry with the same Idempotency-Key.",
          );
        }
        return withTx(deps.db, { actorId: a.userId, requestId: reqId(res) }, async (c) => {
          const u = await c.query<IntentRow>(
            `UPDATE payment_intents SET provider_ref = $2, status = 'REQUIRES_CONFIRMATION' WHERE id = $1 RETURNING *`,
            [created.id, providerRef],
          );
          const out = await finish(c, 201, intentView(u.rows[0] as IntentRow));
          await audit(c, {
            actorId: a.userId,
            action: "payment_intent.create",
            resourceType: "payment_intent",
            resourceId: created.id,
            outcome: "ALLOWED",
            requestId: reqId(res),
            metadata: { amount_minor: created.amount_minor },
          });
          return out;
        });
      });
    }),
  );

  r.post(
    "/payment-intents/:id/confirm",
    requirePermission(deps, "payments:create"),
    route(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const a = getAuth(res);
      await runIdempotent(deps.db, req, res, a.userId, async (finish) => {
        const body = parse(intentConfirmBody, req.body);
        const pi = (
          await deps.db.query<IntentRow>(
            `SELECT * FROM payment_intents WHERE id = $1 AND customer_id = $2`,
            [id, customerIdOf(res)],
          )
        ).rows[0];
        if (!pi) throw new AppError("NOT_FOUND", "Payment intent not found.");
        if (pi.status !== "REQUIRES_CONFIRMATION" || !pi.provider_ref)
          throw new AppError(
            "INVALID_STATE_TRANSITION",
            `A ${pi.status} payment cannot be confirmed.`,
          );
        try {
          await deps.provider.confirmPayment({
            providerRef: pi.provider_ref,
            paymentMethod: body.payment_method,
          });
        } catch {
          throw new AppError(
            "UPSTREAM_UNAVAILABLE",
            "The payment provider is unavailable. Retry with the same Idempotency-Key.",
          );
        }
        return withTx(deps.db, { actorId: a.userId, requestId: reqId(res) }, async (c) => {
          // The provider's webhook may already have advanced the state (it wins): only move forward.
          const u = await c.query<IntentRow>(
            `UPDATE payment_intents SET status = 'PROCESSING' WHERE id = $1 AND status = 'REQUIRES_CONFIRMATION' RETURNING *`,
            [id],
          );
          const cur =
            u.rows[0] ??
            (await c.query<IntentRow>(`SELECT * FROM payment_intents WHERE id = $1`, [id])).rows[0];
          return finish(c, 202, intentView(cur as IntentRow));
        });
      });
    }),
  );

  r.post(
    "/payment-intents/:id/cancel",
    requirePermission(deps, "payments:create"),
    route(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const a = getAuth(res);
      const out = await withTx(deps.db, { actorId: a.userId, requestId: reqId(res) }, async (c) => {
        const pi = await loadOwnIntent(c, res, id);
        if (!["CREATED", "REQUIRES_CONFIRMATION"].includes(pi.status))
          throw new AppError(
            "INVALID_STATE_TRANSITION",
            `A ${pi.status} payment cannot be canceled.`,
          );
        return (
          await c.query<IntentRow>(
            `UPDATE payment_intents SET status = 'CANCELED' WHERE id = $1 RETURNING *`,
            [id],
          )
        ).rows[0];
      });
      ok(res, intentView(out as IntentRow));
    }),
  );

  r.get(
    "/payment-intents",
    requirePermission(deps, "payments:create"),
    route(async (req, res) => {
      const q = parse(pageQuery, req.query);
      const params: unknown[] = [customerIdOf(res)];
      const where = `customer_id = $1${afterCursor(decodeCursor(q.cursor), params)}`;
      params.push(q.limit + 1);
      const rows = await deps.db.query<IntentRow>(
        `SELECT * FROM payment_intents WHERE ${where} ORDER BY created_at, id LIMIT $${params.length}`,
        params,
      );
      const p = page(rows.rows, q.limit);
      ok(res, p.items.map(intentView), 200, { next_cursor: p.nextCursor });
    }),
  );

  r.get(
    "/payment-intents/:id",
    route(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const pi = (
        await deps.db.query<IntentRow>(
          `SELECT * FROM payment_intents WHERE id = $1 AND customer_id = $2`,
          [id, customerIdOf(res)],
        )
      ).rows[0];
      if (!pi) throw new AppError("NOT_FOUND", "Payment intent not found.");
      ok(res, intentView(pi));
    }),
  );

  // ---- Refunds (finance + step-up + idempotency). Funds are held now, moved when the provider confirms. ---------
  r.post(
    "/refunds",
    requirePermission(deps, "refunds:create"),
    route(async (req, res) => {
      const a = getAuth(res);
      await assertRecentReauth(deps, res, "refund.create");
      await runIdempotent(deps.db, req, res, a.userId, async (finish) => {
        const body = parse(refundCreateBody, req.body);
        return withTx(
          deps.db,
          { actorId: a.userId, requestId: reqId(res), reason: body.reason },
          async (c) => {
            const pi = (
              await c.query<IntentRow>(`SELECT * FROM payment_intents WHERE id = $1 FOR UPDATE`, [
                body.payment_intent_id,
              ])
            ).rows[0];
            if (!pi) throw new AppError("NOT_FOUND", "Payment intent not found.");
            if (pi.status !== "SUCCEEDED")
              throw new AppError(
                "INVALID_STATE_TRANSITION",
                "Only succeeded payments can be refunded.",
              );
            if (body.amount_minor > pi.amount_minor - pi.refunded_minor)
              throw new AppError("LIMIT_EXCEEDED", "Amount exceeds the refundable remainder.");
            const walletAcc = await walletAccount(c, pi.wallet_id);
            await lockBalances(c, [walletAcc]);
            const rf = (
              await c.query<{ id: string; status: string; created_at: Date }>(
                `INSERT INTO refunds (payment_intent_id, amount_minor, reason, requested_by) VALUES ($1, $2, $3, $4) RETURNING id, status, created_at`,
                [pi.id, body.amount_minor.toString(), body.reason, a.userId],
              )
            ).rows[0] as { id: string; status: string; created_at: Date };
            await c.query(
              `UPDATE payment_intents SET refunded_minor = refunded_minor + $2 WHERE id = $1`,
              [pi.id, body.amount_minor.toString()],
            );
            // Reserve the funds now (fails with INSUFFICIENT_FUNDS if the customer already spent them).
            await c.query(
              `INSERT INTO holds (account_id, amount_minor, reason, reference_type, reference_id) VALUES ($1, $2, 'TRANSFER_PENDING', 'refund', $3)`,
              [walletAcc, body.amount_minor.toString(), rf.id],
            );
            await enqueue(c, "refund.submit", { refund_id: rf.id }, `refund.submit:${rf.id}`);
            const out = await finish(c, 202, {
              id: rf.id,
              payment_intent_id: pi.id,
              amount_minor: body.amount_minor,
              status: rf.status,
              created_at: rf.created_at,
              simulated: true,
            });
            await audit(c, {
              actorId: a.userId,
              actorRoles: a.roles,
              action: "refund.create",
              resourceType: "refund",
              resourceId: rf.id,
              outcome: "ALLOWED",
              requestId: reqId(res),
              metadata: { amount_minor: body.amount_minor },
            });
            return out;
          },
        );
      });
    }),
  );

  // ---- Settlements & reconciliation (finance runs, ops reads) ------------------------------------------------------
  r.get(
    "/settlements",
    requirePermission(deps, "reconciliation:read"),
    route(async (req, res) => {
      const q = parse(pageQuery.extend({ status: z.string().max(20).optional() }), req.query);
      const params: unknown[] = [];
      let where = "WHERE true";
      if (q.status) {
        params.push(q.status);
        where += ` AND status = $${params.length}`;
      }
      where += afterCursor(decodeCursor(q.cursor), params);
      params.push(q.limit + 1);
      const rows = await deps.db.query<{ id: string; created_at: Date }>(
        `SELECT * FROM settlements ${where} ORDER BY created_at, id LIMIT $${params.length}`,
        params,
      );
      const p = page(rows.rows, q.limit);
      ok(res, p.items, 200, { next_cursor: p.nextCursor });
    }),
  );

  r.post(
    "/reconciliation/runs",
    requirePermission(deps, "reconciliation:run"),
    route(async (req, res) => {
      const { settlement_id } = parse(z.object({ settlement_id: z.uuid() }), req.body);
      const a = getAuth(res);
      let runId: string;
      try {
        runId = await reconcileSettlement(deps, settlement_id, reqId(res), a.userId);
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError(
          "UPSTREAM_UNAVAILABLE",
          "Reconciliation could not complete (analytics unavailable). It will be retried.",
        );
      }
      ok(res, { run_id: runId }, 201);
    }),
  );

  r.get(
    "/reconciliation/runs/:id",
    requirePermission(deps, "reconciliation:read"),
    route(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const run = (await deps.db.query(`SELECT * FROM reconciliation_runs WHERE id = $1`, [id]))
        .rows[0];
      if (!run) throw new AppError("NOT_FOUND", "Reconciliation run not found.");
      const items = (
        await deps.db.query(
          `SELECT provider_ref, payment_intent_id, outcome, expected_minor, actual_minor, diff_minor FROM reconciliation_items WHERE run_id = $1 ORDER BY provider_ref`,
          [id],
        )
      ).rows;
      ok(res, { ...run, items });
    }),
  );

  /** Recovery of a MISMATCHED/FAILED settlement: recovered funds leave suspense; state → RESOLVED. */
  r.post(
    "/settlements/:id/resolve",
    requirePermission(deps, "reconciliation:run"),
    route(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const a = getAuth(res);
      await assertRecentReauth(deps, res, "settlement.resolve");
      const body = parse(settlementResolveBody, req.body);
      await withTx(
        deps.db,
        { actorId: a.userId, requestId: reqId(res), reason: body.note },
        async (c) => {
          const s = (
            await c.query<{ status: string; currency: string }>(
              `SELECT status, currency FROM settlements WHERE id = $1 FOR UPDATE`,
              [id],
            )
          ).rows[0];
          if (!s) throw new AppError("NOT_FOUND", "Settlement not found.");
          if (body.recovered_minor > 0n) {
            await postJournal(c, {
              kind: "SETTLEMENT",
              currency: s.currency,
              description: `Recovered settlement funds (${id})`,
              referenceType: "settlement",
              referenceId: id,
              createdBy: a.userId,
              lines: [
                {
                  accountId: await systemAccountId(c, "SETTLEMENT_BANK", s.currency),
                  direction: "DEBIT",
                  amount: body.recovered_minor,
                },
                {
                  accountId: await systemAccountId(c, "SETTLEMENT_SUSPENSE", s.currency),
                  direction: "CREDIT",
                  amount: body.recovered_minor,
                },
              ],
            });
          }
          await c.query(`UPDATE settlements SET status = 'RESOLVED' WHERE id = $1`, [id]); // FC006 → 409 unless MISMATCHED/FAILED
          await audit(c, {
            actorId: a.userId,
            actorRoles: a.roles,
            action: "settlement.resolve",
            resourceType: "settlement",
            resourceId: id,
            outcome: "ALLOWED",
            requestId: reqId(res),
            metadata: { recovered_minor: body.recovered_minor },
          });
        },
      );
      ok(res, { id, status: "RESOLVED" });
    }),
  );

  return r;
}

export function isUniqueViolation(err: unknown) {
  return isPgError(err) && err.code === DB_ERROR.UNIQUE_VIOLATION;
}
