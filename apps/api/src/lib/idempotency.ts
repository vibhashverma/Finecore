import { createHash } from "node:crypto";
import type { Request } from "express";
import { z } from "zod";
import { AppError } from "./errors.js";
import { canonicalJson } from "./http.js";
import type { Db, Tx } from "./db.js";

/**
 * Idempotency for money-moving POSTs (brief §7, ADR-008).
 *   1. claim:     short transaction; INSERT IN_PROGRESS with a 60 s lease (unique (user_id, key)).
 *   2. execute:   the business transaction calls complete() so the result and the key commit TOGETHER.
 *   3. replay:    same key + same body + COMPLETED → stored response; different body → 422; in progress → 409.
 *   Deterministic 4xx results are stored; transient failures release the key so the client can retry.
 */
export type Claim = { kind: "fresh" } | { kind: "replay"; status: number; body: unknown };

const keySchema = z.uuid();

export function readIdempotencyKey(req: Request): string {
  const key = req.header("idempotency-key");
  if (!key || !keySchema.safeParse(key).success) {
    throw new AppError(
      "VALIDATION_ERROR",
      "An Idempotency-Key header (UUID) is required for this request.",
      [{ path: "Idempotency-Key", message: "required UUID" }],
    );
  }
  return key.toLowerCase();
}

export function requestHash(route: string, body: unknown): Buffer {
  return createHash("sha256")
    .update(`${route}\n${canonicalJson(body)}`)
    .digest();
}

export async function claim(
  db: Db,
  userId: string,
  key: string,
  route: string,
  hash: Buffer,
): Promise<Claim> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    // Waits (briefly) on a concurrent claim of the same key, then sees its row.
    const ins = await c.query(
      `INSERT INTO idempotency_keys (user_id, key, route, request_hash, status, locked_until)
       VALUES ($1, $2, $3, $4, 'IN_PROGRESS', now() + interval '60 seconds')
       ON CONFLICT (user_id, key) DO NOTHING`,
      [userId, key, route, hash],
    );
    if (ins.rowCount === 1) {
      await c.query("COMMIT");
      return { kind: "fresh" };
    }
    const r = await c.query<{
      route: string;
      request_hash: Buffer;
      status: string;
      response_code: number | null;
      response_body: unknown;
      lease_active: boolean;
      expired: boolean;
    }>(
      `SELECT route, request_hash, status, response_code, response_body,
              locked_until > now() AS lease_active, expires_at < now() AS expired
         FROM idempotency_keys WHERE user_id = $1 AND key = $2 FOR UPDATE`,
      [userId, key],
    );
    const row = r.rows[0];
    if (!row) throw new Error("idempotency row vanished");
    if (row.expired) {
      await c.query(
        `UPDATE idempotency_keys SET route = $3, request_hash = $4, status = 'IN_PROGRESS', response_code = NULL,
                response_body = NULL, locked_until = now() + interval '60 seconds', created_at = now(),
                expires_at = now() + interval '24 hours'
          WHERE user_id = $1 AND key = $2`,
        [userId, key, route, hash],
      );
      await c.query("COMMIT");
      return { kind: "fresh" };
    }
    if (row.route !== route || !row.request_hash.equals(hash)) {
      await c.query("ROLLBACK");
      throw new AppError(
        "IDEMPOTENCY_KEY_REUSED",
        "This Idempotency-Key was already used with a different request.",
      );
    }
    if (row.status === "COMPLETED") {
      await c.query("COMMIT");
      return { kind: "replay", status: row.response_code ?? 200, body: row.response_body };
    }
    if (row.lease_active) {
      await c.query("ROLLBACK");
      throw new AppError(
        "CONFLICT",
        "A request with this Idempotency-Key is still in progress. Retry shortly.",
      );
    }
    // Lease expired (e.g. the process crashed mid-request): take over. The money transaction is atomic with
    // completion, so a crashed attempt either fully committed (status COMPLETED) or left no effect.
    await c.query(
      `UPDATE idempotency_keys SET locked_until = now() + interval '60 seconds' WHERE user_id = $1 AND key = $2`,
      [userId, key],
    );
    await c.query("COMMIT");
    return { kind: "fresh" };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export async function complete(
  c: Tx | Db,
  userId: string,
  key: string,
  status: number,
  body: unknown,
) {
  await c.query(
    `UPDATE idempotency_keys SET status = 'COMPLETED', response_code = $3, response_body = $4
      WHERE user_id = $1 AND key = $2`,
    [
      userId,
      key,
      status,
      JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
    ],
  );
}

export async function release(db: Db, userId: string, key: string) {
  await db.query(
    `DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2 AND status = 'IN_PROGRESS'`,
    [userId, key],
  );
}

/** Business outcomes that are stored and replayed. Auth/rate/conflict/5xx results release the key instead. */
const STORED_ERRORS = new Set([
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "FORBIDDEN",
  "LIMIT_EXCEEDED",
  "INSUFFICIENT_FUNDS",
  "INVALID_STATE_TRANSITION",
]);

export type Finish = (
  c: Tx,
  status: number,
  data: unknown,
) => Promise<{ status: number; body: unknown }>;

/**
 * Wraps a money-moving handler with the idempotency protocol. The handler must call `finish(c, status, data)`
 * INSIDE its business transaction, so the stored response commits atomically with the money movement.
 */
export async function runIdempotent(
  db: Db,
  req: Request,
  res: import("express").Response,
  userId: string,
  handler: (finish: Finish) => Promise<{ status: number; body: unknown }>,
): Promise<void> {
  const key = readIdempotencyKey(req);
  const routeKey = `${req.method} ${req.baseUrl}${req.path}`;
  const claimed = await claim(db, userId, key, routeKey, requestHash(routeKey, req.body));
  if (claimed.kind === "replay") {
    res.setHeader("Idempotent-Replayed", "true");
    res.status(claimed.status).json(claimed.body);
    return;
  }
  const requestId = String(res.locals.requestId);
  try {
    const out = await handler(async (c, status, data) => {
      const body = { data, meta: { request_id: requestId } };
      await complete(c, userId, key, status, body);
      return { status, body };
    });
    res.status(out.status).json(out.body);
  } catch (err) {
    if (err instanceof AppError && STORED_ERRORS.has(err.code)) {
      const body = {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
          request_id: requestId,
        },
      };
      await complete(db, userId, key, err.status, body);
    } else {
      await release(db, userId, key);
    }
    throw err;
  }
}
