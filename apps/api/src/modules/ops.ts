import { Router, type Response } from "express";
import { z } from "zod";
import { assertRecentReauth, getAuth, requirePermission } from "../auth/middleware.js";
import type { Deps } from "../deps.js";
import { audit } from "../lib/audit.js";
import { withTx } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { idParam, ok, parse, route } from "../lib/http.js";
import { maskEmail } from "../lib/mask.js";
import { afterCursor, decodeCursor, page, pageQuery } from "../lib/pagination.js";
import { releaseReviewedTransfer } from "./transfers.js";

export const alertTransitionBody = z.object({
  to: z.enum(["INVESTIGATING", "CLEARED", "ESCALATED"]),
  note: z.string().trim().min(3).max(1000),
});
export const roleChangeBody = z.object({
  role: z.enum(["CUSTOMER", "SUPPORT", "OPS", "FINANCE", "ADMIN"]),
  action: z.enum(["grant", "revoke"]),
});

export function opsRouter(deps: Deps): Router {
  const r = Router();
  const reqId = (res: Response) => String(res.locals.requestId);

  // ---- Risk alerts: decision support for analysts; a score is never proof of fraud -------------------------------
  r.get(
    "/risk-alerts",
    requirePermission(deps, "risk:read"),
    route(async (req, res) => {
      const q = parse(
        pageQuery.extend({
          status: z.enum(["NEW", "INVESTIGATING", "CLEARED", "ESCALATED"]).optional(),
          kind: z.string().max(40).optional(),
        }),
        req.query,
      );
      const params: unknown[] = [];
      let where = "WHERE true";
      if (q.status) {
        params.push(q.status);
        where += ` AND a.status = $${params.length}`;
      }
      if (q.kind) {
        params.push(q.kind);
        where += ` AND a.kind = $${params.length}`;
      }
      where += afterCursor(decodeCursor(q.cursor), params, "a");
      params.push(q.limit + 1);
      const rows = await deps.db.query<{ id: string; created_at: Date }>(
        `SELECT a.id, a.kind, a.status, a.score, a.reasons, a.transfer_id, a.settlement_id, a.customer_id, a.assignee_id, a.resolution_note,
                t.amount_minor, t.currency, t.status AS transfer_status, a.created_at, a.updated_at
           FROM risk_alerts a LEFT JOIN transfers t ON t.id = a.transfer_id ${where} ORDER BY a.created_at, a.id LIMIT $${params.length}`,
        params,
      );
      const p = page(rows.rows, q.limit);
      ok(res, p.items, 200, {
        next_cursor: p.nextCursor,
        disclaimer: "Risk scores are decision support, not proof of fraud.",
      });
    }),
  );

  r.post(
    "/risk-alerts/:id/transition",
    requirePermission(deps, "risk:action"),
    route(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const body = parse(alertTransitionBody, req.body);
      const a = getAuth(res);
      const out = await withTx(
        deps.db,
        { actorId: a.userId, requestId: reqId(res), reason: body.note },
        async (c) => {
          const al = (
            await c.query<{ status: string; transfer_id: string | null }>(
              `SELECT status, transfer_id FROM risk_alerts WHERE id = $1 FOR UPDATE`,
              [id],
            )
          ).rows[0];
          if (!al) throw new AppError("NOT_FOUND", "Alert not found.");
          let transferStatus: string | null = null;
          // Closing a transfer alert decides the held transfer: CLEARED posts it, ESCALATED fails it and releases the hold.
          if (
            al.transfer_id &&
            (body.to === "CLEARED" || body.to === "ESCALATED") &&
            al.status === "INVESTIGATING"
          ) {
            const t = (
              await c.query<{ status: string }>(`SELECT status FROM transfers WHERE id = $1`, [
                al.transfer_id,
              ])
            ).rows[0];
            if (t?.status === "PENDING")
              transferStatus = (
                await releaseReviewedTransfer(c, al.transfer_id, body.to === "CLEARED", a.userId)
              ).status;
          }
          const u = await c.query(
            `UPDATE risk_alerts SET status = $2, assignee_id = $3, resolution_note = $4, version = version + 1 WHERE id = $1 RETURNING id, status, kind, transfer_id`,
            [id, body.to, a.userId, body.note],
          ); // DB state machine: NEW → INVESTIGATING → CLEARED | ESCALATED
          await audit(c, {
            actorId: a.userId,
            actorRoles: a.roles,
            action: "risk_alert.transition",
            resourceType: "risk_alert",
            resourceId: id,
            outcome: "ALLOWED",
            requestId: reqId(res),
            metadata: { to: body.to, transfer_status: transferStatus },
          });
          return { ...u.rows[0], transfer_status: transferStatus };
        },
      );
      ok(res, out);
    }),
  );

  // ---- Audit log (read-only) ---------------------------------------------------------------------------------------
  r.get(
    "/audit-log",
    requirePermission(deps, "audit:read"),
    route(async (req, res) => {
      const q = parse(
        z.object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: z
            .string()
            .regex(/^\d{1,18}$/)
            .optional(),
          action: z.string().max(80).optional(),
          outcome: z.enum(["ALLOWED", "DENIED", "ERROR"]).optional(),
          resource_id: z.string().max(80).optional(),
        }),
        req.query,
      );
      const params: unknown[] = [];
      let where = "WHERE true";
      for (const [col, val] of [
        ["action", q.action],
        ["outcome", q.outcome],
        ["resource_id", q.resource_id],
      ] as const) {
        if (val) {
          params.push(val);
          where += ` AND ${col} = $${params.length}`;
        }
      }
      if (q.cursor) {
        params.push(q.cursor);
        where += ` AND chain_seq < $${params.length}`;
      }
      params.push(q.limit + 1);
      const rows = await deps.db.query<{ chain_seq: bigint }>(
        `SELECT chain_seq, occurred_at, actor_id, actor_roles, action, resource_type, resource_id, outcome, request_id, metadata
           FROM audit_log ${where} ORDER BY chain_seq DESC LIMIT $${params.length}`,
        params,
      );
      const items = rows.rows.slice(0, q.limit);
      const last = items[items.length - 1];
      const chain = await deps.db.query(
        `SELECT count(*)::int AS problems FROM audit_log_verify_chain()`,
      );
      ok(res, items, 200, {
        next_cursor: rows.rows.length > q.limit && last ? String(last.chain_seq) : null,
        chain_intact: chain.rows[0]?.problems === 0,
      });
    }),
  );

  // ---- Admin: failed jobs (dead letters) and controlled replay -----------------------------------------------------
  r.get(
    "/admin/failed-jobs",
    requirePermission(deps, "admin:manage"),
    route(async (_req, res) => {
      const rows = await deps.db.query(
        `SELECT f.id, f.outbox_id, f.topic, f.error, f.attempts, f.failed_at, f.replayed_at FROM failed_jobs f ORDER BY f.failed_at DESC LIMIT 100`,
      );
      ok(res, rows.rows);
    }),
  );

  r.post(
    "/admin/failed-jobs/:id/replay",
    requirePermission(deps, "admin:manage"),
    route(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const a = getAuth(res);
      await assertRecentReauth(deps, res, "failed_job.replay");
      await withTx(deps.db, { actorId: a.userId, requestId: reqId(res) }, async (c) => {
        const f = (
          await c.query<{ outbox_id: bigint; replayed_at: Date | null }>(
            `SELECT outbox_id, replayed_at FROM failed_jobs WHERE id = $1 FOR UPDATE`,
            [id],
          )
        ).rows[0];
        if (!f) throw new AppError("NOT_FOUND", "Failed job not found.");
        if (f.replayed_at) throw new AppError("CONFLICT", "This job was already replayed.");
        // Handlers are idempotent (state-checked), so a replay can never double-apply an effect.
        await c.query(
          `UPDATE outbox SET status = 'PENDING', attempts = 0, next_attempt_at = now(), last_error = NULL WHERE id = $1 AND status = 'DEAD'`,
          [f.outbox_id],
        );
        await c.query(
          `UPDATE failed_jobs SET replayed_at = now(), replayed_by = $2 WHERE id = $1`,
          [id, a.userId],
        );
        await audit(c, {
          actorId: a.userId,
          actorRoles: a.roles,
          action: "failed_job.replay",
          resourceType: "failed_job",
          resourceId: id,
          outcome: "ALLOWED",
          requestId: reqId(res),
        });
      });
      ok(res, { replayed: true });
    }),
  );

  // ---- Admin: users and roles -----------------------------------------------------------------------------------
  r.get(
    "/admin/users",
    requirePermission(deps, "admin:manage"),
    route(async (req, res) => {
      const q = parse(pageQuery, req.query);
      const params: unknown[] = [];
      const where = `WHERE true${afterCursor(decodeCursor(q.cursor), params, "u")}`;
      params.push(q.limit + 1);
      const rows = await deps.db.query<{
        id: string;
        email: string;
        status: string;
        roles: string[];
        created_at: Date;
      }>(
        `SELECT u.id, u.email, u.status, array(SELECT role_code FROM user_roles WHERE user_id = u.id ORDER BY 1) AS roles, u.created_at
           FROM users u ${where} ORDER BY u.created_at, u.id LIMIT $${params.length}`,
        params,
      );
      const p = page(rows.rows, q.limit);
      ok(
        res,
        p.items.map((u) => ({ ...u, email: maskEmail(u.email) })),
        200,
        { next_cursor: p.nextCursor },
      );
    }),
  );

  r.post(
    "/admin/users/:id/roles",
    requirePermission(deps, "admin:manage"),
    route(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const body = parse(roleChangeBody, req.body);
      const a = getAuth(res);
      await assertRecentReauth(deps, res, "role.change");
      if (id === a.userId && body.action === "revoke" && body.role === "ADMIN")
        throw new AppError("CONFLICT", "You cannot remove your own admin role.");
      await withTx(deps.db, { actorId: a.userId, requestId: reqId(res) }, async (c) => {
        const u = (await c.query(`SELECT 1 FROM users WHERE id = $1`, [id])).rowCount;
        if (!u) throw new AppError("NOT_FOUND", "User not found.");
        if (body.action === "grant")
          await c.query(
            `INSERT INTO user_roles (user_id, role_code, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [id, body.role, a.userId],
          );
        else
          await c.query(`DELETE FROM user_roles WHERE user_id = $1 AND role_code = $2`, [
            id,
            body.role,
          ]);
        await audit(c, {
          actorId: a.userId,
          actorRoles: a.roles,
          action: `role.${body.action}`,
          resourceType: "user",
          resourceId: id,
          outcome: "ALLOWED",
          requestId: reqId(res),
          metadata: { role: body.role },
        });
      });
      ok(res, { user_id: id, role: body.role, action: body.action });
    }),
  );

  return r;
}
