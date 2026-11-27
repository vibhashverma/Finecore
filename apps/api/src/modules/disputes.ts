import { Router, type Response } from "express";
import { z } from "zod";
import { assertRecentReauth, getAuth, requirePermission } from "../auth/middleware.js";
import { can } from "../auth/permissions.js";
import type { Deps } from "../deps.js";
import { audit } from "../lib/audit.js";
import { lockBalances, postJournal, withTx } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { idParam, ok, parse, route } from "../lib/http.js";
import { afterCursor, decodeCursor, page, pageQuery } from "../lib/pagination.js";
import { isUniqueViolation } from "./payments.js";

export const disputeCreateBody = z.object({
  transfer_id: z.uuid(),
  reason: z.string().trim().min(3).max(1000),
  amount_minor: z
    .string()
    .regex(/^[1-9]\d{0,15}$/)
    .transform(BigInt)
    .optional(),
  customer_id: z.uuid().optional(), // support agents raising on behalf of a customer
});
export const disputeTransitionBody = z.object({
  to: z.enum(["UNDER_REVIEW", "RESOLVED_CUSTOMER", "RESOLVED_MERCHANT", "REJECTED"]),
  note: z.string().trim().min(3).max(1000),
});

interface DisputeRow {
  id: string;
  customer_id: string;
  transfer_id: string | null;
  amount_minor: bigint;
  currency: string;
  status: string;
  hold_id: string | null;
  created_at: Date;
}

export function disputesRouter(deps: Deps): Router {
  const r = Router();
  const reqId = (res: Response) => String(res.locals.requestId);

  r.post(
    "/disputes",
    requirePermission(deps, "disputes:create"),
    route(async (req, res) => {
      const a = getAuth(res);
      const body = parse(disputeCreateBody, req.body);
      const customerId = a.customerId ?? body.customer_id;
      if (!customerId)
        throw new AppError(
          "VALIDATION_ERROR",
          "customer_id is required when raising on behalf of a customer.",
          [{ path: "customer_id", message: "required" }],
        );
      try {
        const d = await withTx(
          deps.db,
          { actorId: a.userId, requestId: reqId(res), reason: body.reason },
          async (c) => {
            // Scoped by customer in the query: you can only dispute your own (or, for support, the named customer's) transfer.
            const t = (
              await c.query<{
                id: string;
                amount_minor: bigint;
                currency: string;
                status: string;
                dest_wallet_id: string;
              }>(
                `SELECT id, amount_minor, currency, status, dest_wallet_id FROM transfers WHERE id = $1 AND customer_id = $2 FOR UPDATE`,
                [body.transfer_id, customerId],
              )
            ).rows[0];
            if (!t) throw new AppError("NOT_FOUND", "Transfer not found.");
            if (t.status !== "POSTED")
              throw new AppError(
                "INVALID_STATE_TRANSITION",
                "Only posted transfers can be disputed.",
              );
            const amount = body.amount_minor ?? t.amount_minor;
            if (amount > t.amount_minor)
              throw new AppError(
                "VALIDATION_ERROR",
                "Dispute amount exceeds the transfer amount.",
                [{ path: "amount_minor", message: "too large" }],
              );
            const dr = (
              await c.query<DisputeRow>(
                `INSERT INTO disputes (customer_id, raised_by, transfer_id, amount_minor, currency, reason) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [customerId, a.userId, t.id, amount.toString(), t.currency, body.reason],
              )
            ).rows[0] as DisputeRow;
            // Freeze the disputed amount at the recipient if available (best effort; resolution re-checks funds).
            const destAcc = (
              await c.query<{ account_id: string }>(
                `SELECT account_id FROM wallets WHERE id = $1`,
                [t.dest_wallet_id],
              )
            ).rows[0]?.account_id as string;
            const bal = (await lockBalances(c, [destAcc])).get(destAcc);
            if (bal && bal.posted_minor - bal.held_minor - amount >= bal.floor_minor) {
              const h = await c.query<{ id: string }>(
                `INSERT INTO holds (account_id, amount_minor, reason, reference_type, reference_id) VALUES ($1, $2, 'DISPUTE', 'dispute', $3) RETURNING id`,
                [destAcc, amount.toString(), dr.id],
              );
              await c.query(`UPDATE disputes SET hold_id = $2 WHERE id = $1`, [
                dr.id,
                h.rows[0]?.id,
              ]);
            }
            await audit(c, {
              actorId: a.userId,
              actorRoles: a.roles,
              action: "dispute.create",
              resourceType: "dispute",
              resourceId: dr.id,
              outcome: "ALLOWED",
              requestId: reqId(res),
              metadata: { on_behalf: !a.customerId },
            });
            return dr;
          },
        );
        ok(res, { ...d, simulated: true }, 201);
      } catch (err) {
        if (isUniqueViolation(err))
          throw new AppError("CONFLICT", "An open dispute already exists for this transfer.");
        throw err;
      }
    }),
  );

  r.get(
    "/disputes",
    route(async (req, res) => {
      const a = getAuth(res);
      const q = parse(pageQuery.extend({ status: z.string().max(30).optional() }), req.query);
      const params: unknown[] = [];
      let where = "WHERE true";
      if (!can(a.roles, "disputes:read_all")) {
        if (!a.customerId)
          throw new AppError("FORBIDDEN", "You do not have permission to view disputes.");
        params.push(a.customerId);
        where += ` AND d.customer_id = $${params.length}`;
      }
      if (q.status) {
        params.push(q.status);
        where += ` AND d.status = $${params.length}`;
      }
      where += afterCursor(decodeCursor(q.cursor), params, "d");
      params.push(q.limit + 1);
      const rows = await deps.db.query<DisputeRow>(
        `SELECT d.* FROM disputes d ${where} ORDER BY d.created_at, d.id LIMIT $${params.length}`,
        params,
      );
      const p = page(rows.rows, q.limit);
      ok(res, p.items, 200, { next_cursor: p.nextCursor });
    }),
  );

  r.post(
    "/disputes/:id/transition",
    requirePermission(deps, "disputes:resolve"),
    route(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const body = parse(disputeTransitionBody, req.body);
      const a = getAuth(res);
      if (body.to === "RESOLVED_CUSTOMER") await assertRecentReauth(deps, res, "dispute.resolve");
      const out = await withTx(
        deps.db,
        { actorId: a.userId, requestId: reqId(res), reason: body.note },
        async (c) => {
          const d = (
            await c.query<DisputeRow>(`SELECT * FROM disputes WHERE id = $1 FOR UPDATE`, [id])
          ).rows[0];
          if (!d) throw new AppError("NOT_FOUND", "Dispute not found.");
          // Support agents resolve only up to their limit; above it, finance must decide (brief §2).
          if (
            body.to !== "UNDER_REVIEW" &&
            !a.roles.includes("FINANCE") &&
            d.amount_minor > deps.config.SUPPORT_DISPUTE_LIMIT_MINOR
          ) {
            throw new AppError(
              "FORBIDDEN",
              "This dispute exceeds the support resolution limit; finance must resolve it.",
            );
          }
          let txnId: string | null = null;
          if (body.to === "RESOLVED_CUSTOMER" && d.transfer_id) {
            const t = (
              await c.query<{ source_wallet_id: string; dest_wallet_id: string }>(
                `SELECT source_wallet_id, dest_wallet_id FROM transfers WHERE id = $1`,
                [d.transfer_id],
              )
            ).rows[0];
            const accs = (
              await c.query<{ id: string; account_id: string }>(
                `SELECT id, account_id FROM wallets WHERE id = ANY($1::uuid[])`,
                [[t?.source_wallet_id, t?.dest_wallet_id]],
              )
            ).rows;
            const src = accs.find((x) => x.id === t?.source_wallet_id)?.account_id as string;
            const dst = accs.find((x) => x.id === t?.dest_wallet_id)?.account_id as string;
            await lockBalances(c, [src, dst]);
            if (d.hold_id)
              await c.query(
                `UPDATE holds SET status = 'CAPTURED' WHERE id = $1 AND status = 'ACTIVE'`,
                [d.hold_id],
              );
            txnId = await postJournal(c, {
              kind: "DISPUTE",
              currency: d.currency,
              description: `Dispute ${d.id} resolved in customer's favour`,
              referenceType: "dispute",
              referenceId: d.id,
              createdBy: a.userId,
              lines: [
                { accountId: dst, direction: "DEBIT", amount: d.amount_minor },
                { accountId: src, direction: "CREDIT", amount: d.amount_minor },
              ],
            });
          } else if ((body.to === "RESOLVED_MERCHANT" || body.to === "REJECTED") && d.hold_id) {
            await c.query(
              `UPDATE holds SET status = 'RELEASED' WHERE id = $1 AND status = 'ACTIVE'`,
              [d.hold_id],
            );
          }
          const resolved = body.to !== "UNDER_REVIEW";
          const u = await c.query<DisputeRow>(
            `UPDATE disputes SET status = $2, resolution_note = $3, resolved_by = $4, transaction_id = coalesce($5, transaction_id), version = version + 1
            WHERE id = $1 RETURNING *`,
            [id, body.to, resolved ? body.note : null, resolved ? a.userId : null, txnId],
          ); // the DB state machine rejects illegal transitions (FC006 → 409)
          await audit(c, {
            actorId: a.userId,
            actorRoles: a.roles,
            action: "dispute.transition",
            resourceType: "dispute",
            resourceId: id,
            outcome: "ALLOWED",
            requestId: reqId(res),
            metadata: { to: body.to },
          });
          return u.rows[0];
        },
      );
      ok(res, out);
    }),
  );

  return r;
}
