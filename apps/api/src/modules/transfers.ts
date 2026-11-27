import { Router, type Response } from "express";
import { z } from "zod";
import {
  assertRecentReauth,
  customerIdOf,
  getAuth,
  requirePermission,
} from "../auth/middleware.js";
import { can } from "../auth/permissions.js";
import type { Deps } from "../deps.js";
import type { RiskScore, TransferFeatures } from "../integrations/analytics.js";
import { audit } from "../lib/audit.js";
import { enqueue, lockBalances, postJournal, systemAccountId, withTx, type Tx } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { amountMinor, idParam, ok, parse, route } from "../lib/http.js";
import { runIdempotent } from "../lib/idempotency.js";
import { afterCursor, decodeCursor, page, pageQuery } from "../lib/pagination.js";

export const transferCreateBody = z.object({
  source_wallet_id: z.uuid(),
  beneficiary_id: z.uuid(),
  amount_minor: amountMinor,
  description: z.string().trim().max(140).optional(),
});
export const reverseBody = z.object({ reason: z.string().trim().min(3).max(500) });

export interface TransferRow {
  id: string;
  customer_id: string;
  source_wallet_id: string;
  dest_wallet_id: string;
  beneficiary_id: string;
  amount_minor: bigint;
  fee_minor: bigint;
  currency: string;
  status: string;
  description: string | null;
  transaction_id: string | null;
  hold_id: string | null;
  risk_score: string | null;
  risk_reasons: unknown;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
}

export const transferView = (t: TransferRow) => ({
  id: t.id,
  status: t.status,
  source_wallet_id: t.source_wallet_id,
  beneficiary_id: t.beneficiary_id,
  amount_minor: t.amount_minor,
  fee_minor: t.fee_minor,
  currency: t.currency,
  description: t.description,
  transaction_id: t.transaction_id,
  risk:
    t.risk_score === null
      ? null
      : { score: Number(t.risk_score), reasons: t.risk_reasons, decision_support_only: true },
  failure_code: t.failure_code,
  created_at: t.created_at,
  updated_at: t.updated_at,
  simulated: true,
});

async function walletAccounts(c: Tx, t: TransferRow) {
  const r = await c.query<{ id: string; account_id: string }>(
    `SELECT id, account_id FROM wallets WHERE id = ANY($1::uuid[])`,
    [[t.source_wallet_id, t.dest_wallet_id]],
  );
  const m = new Map(r.rows.map((x) => [x.id, x.account_id]));
  return { source: m.get(t.source_wallet_id) as string, dest: m.get(t.dest_wallet_id) as string };
}

/** Posts the journal for a transfer already in PENDING (locks must be held by the caller). */
async function postTransferJournal(c: Tx, t: TransferRow, actorId: string | undefined) {
  const acc = await walletAccounts(c, t);
  const fees = await systemAccountId(c, "FEES_REVENUE", t.currency);
  const txnId = await postJournal(c, {
    kind: "TRANSFER",
    currency: t.currency,
    description: t.description ? `Transfer: ${t.description}` : "Wallet transfer",
    referenceType: "transfer",
    referenceId: t.id,
    createdBy: actorId,
    lines: [
      { accountId: acc.source, direction: "DEBIT", amount: t.amount_minor + t.fee_minor },
      { accountId: acc.dest, direction: "CREDIT", amount: t.amount_minor },
      { accountId: fees, direction: "CREDIT", amount: t.fee_minor },
    ],
  });
  const u = await c.query<TransferRow>(
    `UPDATE transfers SET status = 'POSTED', transaction_id = $2 WHERE id = $1 AND status = 'PENDING' RETURNING *`,
    [t.id, txnId],
  );
  await enqueue(c, "transfer.posted", { transfer_id: t.id }, `transfer.posted:${t.id}`);
  return u.rows[0] as TransferRow;
}

async function lockTransfer(c: Tx, id: string): Promise<TransferRow> {
  const r = await c.query<TransferRow>(`SELECT * FROM transfers WHERE id = $1 FOR UPDATE`, [id]);
  const t = r.rows[0];
  if (!t) throw new AppError("NOT_FOUND", "Transfer not found.");
  return t;
}

/** Ops CLEARED a held transfer: capture its hold and post it (called inside the alert transition's transaction). */
export async function releaseReviewedTransfer(
  c: Tx,
  transferId: string,
  approve: boolean,
  actorId: string,
) {
  const t = await lockTransfer(c, transferId);
  if (t.status !== "PENDING")
    throw new AppError("INVALID_STATE_TRANSITION", "Transfer is not awaiting review.");
  const acc = await walletAccounts(c, t);
  await lockBalances(c, [acc.source, acc.dest]);
  if (t.hold_id)
    await c.query(`UPDATE holds SET status = $2 WHERE id = $1 AND status = 'ACTIVE'`, [
      t.hold_id,
      approve ? "CAPTURED" : "RELEASED",
    ]);
  if (approve) return postTransferJournal(c, t, actorId);
  const u = await c.query<TransferRow>(
    `UPDATE transfers SET status = 'FAILED', failure_code = 'RISK_REJECTED' WHERE id = $1 RETURNING *`,
    [t.id],
  );
  await enqueue(c, "transfer.failed", { transfer_id: t.id }, `transfer.failed:${t.id}`);
  return u.rows[0] as TransferRow;
}

/** Behavioural features for risk scoring, computed by the data owner (Express) from indexed queries. */
async function riskFeatures(
  deps: Deps,
  customerId: string,
  amount: bigint,
  currency: string,
  beneficiaryCreatedAt: Date,
): Promise<TransferFeatures> {
  const r = await deps.db.query<{
    last_hour: number;
    amount_24h: bigint;
    avg_30d: bigint;
    distinct_24h: number;
    account_age_days: number;
  }>(
    `SELECT count(*) FILTER (WHERE t.created_at > now() - interval '1 hour')::int AS last_hour,
            coalesce(sum(t.amount_minor) FILTER (WHERE t.created_at > now() - interval '24 hours' AND t.status IN ('PENDING', 'POSTED')), 0)::bigint AS amount_24h,
            coalesce(avg(t.amount_minor) FILTER (WHERE t.created_at > now() - interval '30 days' AND t.status = 'POSTED'), 0)::bigint AS avg_30d,
            count(DISTINCT t.dest_wallet_id) FILTER (WHERE t.created_at > now() - interval '24 hours')::int AS distinct_24h,
            (SELECT extract(day FROM now() - c.created_at)::int FROM customers c WHERE c.id = $1) AS account_age_days
       FROM transfers t WHERE t.customer_id = $1 AND t.currency = $2`,
    [customerId, currency],
  );
  const f = r.rows[0];
  return {
    amount_minor: amount,
    currency,
    hour_utc: new Date().getUTCHours(),
    beneficiary_age_hours: Math.floor((Date.now() - beneficiaryCreatedAt.getTime()) / 3_600_000),
    account_age_days: f?.account_age_days ?? 0,
    transfers_last_hour: f?.last_hour ?? 0,
    amount_last_24h_minor: f?.amount_24h ?? 0n,
    avg_amount_30d_minor: f?.avg_30d ?? 0n,
    distinct_beneficiaries_24h: f?.distinct_24h ?? 0,
  };
}

export function transfersRouter(deps: Deps): Router {
  const r = Router();
  const reqId = (res: Response) => String(res.locals.requestId);

  r.post(
    "/transfers",
    requirePermission(deps, "transfers:create"),
    route(async (req, res) => {
      const a = getAuth(res);
      const customerId = customerIdOf(res);
      await runIdempotent(deps.db, req, res, a.userId, async (finish) => {
        const body = parse(transferCreateBody, req.body);
        const cfg = deps.config;

        // 1. Ownership and state (scoped by customer in the query → 404 for anything not theirs).
        const src = (
          await deps.db.query<{ account_id: string; currency: string; status: string }>(
            `SELECT account_id, currency, status FROM wallets WHERE id = $1 AND customer_id = $2`,
            [body.source_wallet_id, customerId],
          )
        ).rows[0];
        if (!src) throw new AppError("NOT_FOUND", "Source wallet not found.");
        const ben = (
          await deps.db.query<{
            dest_wallet_id: string;
            dest_account_id: string;
            currency: string;
            status: string;
            created_at: Date;
          }>(
            `SELECT w.id AS dest_wallet_id, w.account_id AS dest_account_id, w.currency, w.status, b.created_at
             FROM beneficiaries b JOIN wallets w ON w.id = b.target_wallet_id
            WHERE b.id = $1 AND b.customer_id = $2 AND b.deleted_at IS NULL`,
            [body.beneficiary_id, customerId],
          )
        ).rows[0];
        if (!ben) throw new AppError("NOT_FOUND", "Beneficiary not found.");
        if (ben.dest_wallet_id === body.source_wallet_id)
          throw new AppError("VALIDATION_ERROR", "Source and destination must differ.", [
            { path: "beneficiary_id", message: "same wallet" },
          ]);
        if (ben.currency !== src.currency)
          throw new AppError("VALIDATION_ERROR", "Currencies must match (FX is not supported).", [
            { path: "beneficiary_id", message: "currency mismatch" },
          ]);
        if (src.status !== "ACTIVE" || ben.status !== "ACTIVE")
          throw new AppError("INVALID_STATE_TRANSITION", "Both wallets must be active.");

        // 2. Limits and step-up confirmation for large amounts.
        if (body.amount_minor > cfg.TRANSFER_MAX_MINOR)
          throw new AppError("LIMIT_EXCEEDED", "Amount exceeds the per-transfer limit.");
        if (body.amount_minor >= cfg.TRANSFER_REAUTH_THRESHOLD_MINOR)
          await assertRecentReauth(deps, res, "transfer.create_large");

        // 3. Fee (Decimal, analytics service). No fee quote → no transfer (never guess money).
        const s = (
          await deps.db.query<{
            flat_minor: bigint;
            rate_bps: number;
            min_minor: bigint;
            max_minor: bigint | null;
          }>(
            `SELECT flat_minor, rate_bps, min_minor, max_minor FROM fee_schedules
            WHERE kind = 'TRANSFER' AND currency = $1 AND effective_from <= now() ORDER BY effective_from DESC LIMIT 1`,
            [src.currency],
          )
        ).rows[0];
        if (!s) throw new Error(`no fee schedule for ${src.currency}`);
        let fee: bigint;
        try {
          fee = await deps.analytics.calculateFee(body.amount_minor, src.currency, s, reqId(res));
        } catch {
          throw new AppError(
            "UPSTREAM_UNAVAILABLE",
            "Fee calculation is temporarily unavailable. Retry with the same Idempotency-Key.",
          );
        }

        // 4. Risk (decision support). Fail-safe if analytics is down: hold larger transfers for review.
        let risk: RiskScore | null = null;
        try {
          risk = await deps.analytics.scoreTransfer(
            await riskFeatures(deps, customerId, body.amount_minor, src.currency, ben.created_at),
            reqId(res),
          );
        } catch (err) {
          deps.logger.warn(
            { request_id: reqId(res), err: (err as Error).message },
            "risk scoring unavailable: applying fail-safe policy",
          );
        }
        const review = risk
          ? risk.score >= cfg.RISK_REVIEW_SCORE
          : body.amount_minor >= cfg.RISK_FAILSAFE_REVIEW_MINOR;
        const reasons = risk?.reasons ?? [
          {
            code: "SCORING_UNAVAILABLE",
            detail: "Risk service unavailable; fail-safe review policy applied",
            weight: 0,
          },
        ];

        // 5. One atomic money transaction (ADR-003): ordered locks → balance check → transfer + journal/hold →
        //    outbox → idempotent response → audit (last).
        return withTx(deps.db, { actorId: a.userId, requestId: reqId(res) }, async (c) => {
          const balances = await lockBalances(c, [src.account_id, ben.dest_account_id]);
          const b = balances.get(src.account_id);
          if (!b || b.posted_minor - b.held_minor - (body.amount_minor + fee) < b.floor_minor)
            throw new AppError(
              "INSUFFICIENT_FUNDS",
              "Insufficient available funds (amount plus fee).",
            );
          const ins = await c.query<TransferRow>(
            `INSERT INTO transfers (customer_id, source_wallet_id, dest_wallet_id, beneficiary_id, amount_minor, fee_minor, currency, description, risk_score, risk_reasons)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [
              customerId,
              body.source_wallet_id,
              ben.dest_wallet_id,
              body.beneficiary_id,
              body.amount_minor.toString(),
              fee.toString(),
              src.currency,
              body.description ?? null,
              risk?.score ?? null,
              JSON.stringify(reasons),
            ],
          );
          let t = (
            await c.query<TransferRow>(
              `UPDATE transfers SET status = 'PENDING' WHERE id = $1 RETURNING *`,
              [ins.rows[0]?.id],
            )
          ).rows[0] as TransferRow;
          let status: number;
          if (review) {
            const hold = await c.query<{ id: string }>(
              `INSERT INTO holds (account_id, amount_minor, reason, reference_type, reference_id) VALUES ($1, $2, 'RISK_REVIEW', 'transfer', $3) RETURNING id`,
              [src.account_id, (body.amount_minor + fee).toString(), t.id],
            );
            t = (
              await c.query<TransferRow>(
                `UPDATE transfers SET hold_id = $2 WHERE id = $1 RETURNING *`,
                [t.id, hold.rows[0]?.id],
              )
            ).rows[0] as TransferRow;
            const alert = await c.query<{ id: string }>(
              `INSERT INTO risk_alerts (kind, customer_id, transfer_id, score, reasons) VALUES ('TRANSFER_RISK', $1, $2, $3, $4) RETURNING id`,
              [customerId, t.id, risk?.score ?? 0, JSON.stringify(reasons)],
            );
            await enqueue(
              c,
              "risk.alert_created",
              { alert_id: alert.rows[0]?.id },
              `risk.alert:${alert.rows[0]?.id}`,
            );
            status = 202;
          } else {
            t = await postTransferJournal(c, t, a.userId);
            status = 201;
          }
          const out = await finish(c, status, transferView(t));
          await audit(c, {
            actorId: a.userId,
            actorRoles: a.roles,
            action: "transfer.create",
            resourceType: "transfer",
            resourceId: t.id,
            outcome: "ALLOWED",
            requestId: reqId(res),
            metadata: { amount_minor: t.amount_minor, currency: t.currency, status: t.status },
          });
          return out;
        });
      });
    }),
  );

  r.get(
    "/transfers",
    route(async (req, res) => {
      const a = getAuth(res);
      const q = parse(
        pageQuery.extend({
          status: z.enum(["INITIATED", "PENDING", "POSTED", "FAILED", "REVERSED"]).optional(),
          customer_id: z.uuid().optional(),
        }),
        req.query,
      );
      const params: unknown[] = [];
      let where = "WHERE true";
      if (can(a.roles, "customers:read")) {
        if (q.customer_id) {
          params.push(q.customer_id);
          where += ` AND t.customer_id = $${params.length}`;
        }
      } else {
        params.push(customerIdOf(res));
        where += ` AND t.customer_id = $${params.length}`;
      }
      if (q.status) {
        params.push(q.status);
        where += ` AND t.status = $${params.length}`;
      }
      where += afterCursor(decodeCursor(q.cursor), params, "t");
      params.push(q.limit + 1);
      const rows = await deps.db.query<TransferRow>(
        `SELECT t.* FROM transfers t ${where} ORDER BY t.created_at, t.id LIMIT $${params.length}`,
        params,
      );
      const p = page(rows.rows, q.limit);
      ok(res, p.items.map(transferView), 200, { next_cursor: p.nextCursor });
    }),
  );

  r.get(
    "/transfers/:id",
    route(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const a = getAuth(res);
      const rows = can(a.roles, "customers:read")
        ? await deps.db.query<TransferRow>(`SELECT * FROM transfers WHERE id = $1`, [id])
        : await deps.db.query<TransferRow>(
            `SELECT * FROM transfers WHERE id = $1 AND customer_id = $2`,
            [id, customerIdOf(res)],
          );
      const t = rows.rows[0];
      if (!t) throw new AppError("NOT_FOUND", "Transfer not found.");
      ok(res, transferView(t));
    }),
  );

  /** Full reversal of a POSTED transfer (finance + step-up + idempotency). Original journal stays untouched. */
  r.post(
    "/transfers/:id/reverse",
    requirePermission(deps, "reversals:create"),
    route(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const a = getAuth(res);
      await assertRecentReauth(deps, res, "transfer.reverse");
      await runIdempotent(deps.db, req, res, a.userId, async (finish) => {
        const body = parse(reverseBody, req.body);
        return withTx(
          deps.db,
          { actorId: a.userId, requestId: reqId(res), reason: body.reason },
          async (c) => {
            const t = await lockTransfer(c, id);
            if (t.status !== "POSTED" || !t.transaction_id)
              throw new AppError(
                "INVALID_STATE_TRANSITION",
                `A ${t.status} transfer cannot be reversed.`,
              );
            const acc = await walletAccounts(c, t);
            await lockBalances(c, [acc.source, acc.dest]);
            const lines = await c.query<{
              account_id: string;
              direction: "DEBIT" | "CREDIT";
              amount_minor: bigint;
            }>(
              `SELECT account_id, direction, amount_minor FROM ledger_entries WHERE transaction_id = $1`,
              [t.transaction_id],
            );
            const revId = await postJournal(c, {
              kind: "REVERSAL",
              currency: t.currency,
              description: `Reversal of transfer ${t.id}`,
              referenceType: "transfer",
              referenceId: t.id,
              reverses: t.transaction_id,
              createdBy: a.userId,
              lines: lines.rows.map((l) => ({
                accountId: l.account_id,
                direction: l.direction === "DEBIT" ? "CREDIT" : "DEBIT",
                amount: l.amount_minor,
              })),
            });
            await c.query(
              `INSERT INTO reversals (transfer_id, transaction_id, requested_by, reason) VALUES ($1, $2, $3, $4)`,
              [t.id, revId, a.userId, body.reason],
            );
            const u = await c.query<TransferRow>(
              `UPDATE transfers SET status = 'REVERSED' WHERE id = $1 AND status = 'POSTED' RETURNING *`,
              [t.id],
            );
            await enqueue(
              c,
              "transfer.reversed",
              { transfer_id: t.id },
              `transfer.reversed:${t.id}`,
            );
            const out = await finish(c, 200, {
              ...transferView(u.rows[0] as TransferRow),
              reversal_transaction_id: revId,
            });
            await audit(c, {
              actorId: a.userId,
              actorRoles: a.roles,
              action: "transfer.reverse",
              resourceType: "transfer",
              resourceId: t.id,
              outcome: "ALLOWED",
              requestId: reqId(res),
              metadata: { reversal_transaction_id: revId },
            });
            return out;
          },
        );
      });
    }),
  );

  return r;
}
