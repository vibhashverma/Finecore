import { randomInt } from "node:crypto";
import { DB_ERROR, isPgError } from "@fincore/db";
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
import { audit } from "../lib/audit.js";
import { withTx } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { currency, idParam, ok, parse, route } from "../lib/http.js";
import { maskAccountNumber, maskEmail, maskName } from "../lib/mask.js";
import { afterCursor, decodeCursor, page, pageQuery } from "../lib/pagination.js";

export const walletCreateBody = z.object({
  currency,
  nickname: z.string().trim().min(1).max(60).optional(),
});
export const beneficiaryCreateBody = z.object({
  account_number: z.string().regex(/^FC\d{10}$/, "FinCore account number, e.g. FC1000000003"),
  nickname: z.string().trim().min(1).max(60),
});
export const mePatchBody = z.object({ full_name: z.string().trim().min(1).max(200) });

interface WalletRow {
  id: string;
  customer_id: string;
  account_id: string;
  account_number: string;
  currency: string;
  nickname: string | null;
  status: string;
  posted_minor: bigint;
  held_minor: bigint;
  created_at: Date;
}

const WALLET_SELECT = `SELECT w.id, w.customer_id, w.account_id, w.account_number, w.currency, w.nickname, w.status,
       b.posted_minor, b.held_minor, w.created_at
  FROM wallets w JOIN account_balances b ON b.account_id = w.account_id`;

/** Balances are SIMULATED and labelled as such in every response. */
export function walletView(w: WalletRow, masked: boolean) {
  return {
    id: w.id,
    account_number: masked ? maskAccountNumber(w.account_number) : w.account_number,
    currency: w.currency,
    nickname: w.nickname,
    status: w.status,
    balance: {
      posted_minor: w.posted_minor,
      held_minor: w.held_minor,
      available_minor: w.posted_minor - w.held_minor,
      simulated: true,
    },
    created_at: w.created_at,
  };
}

/** Loads a wallet the caller may see: customers only their own (scoped IN the query), staff any (masked). */
export async function loadWallet(
  deps: Deps,
  res: Response,
  walletId: string,
): Promise<{ wallet: WalletRow; masked: boolean }> {
  const a = getAuth(res);
  const staff = can(a.roles, "customers:read");
  const r = staff
    ? await deps.db.query<WalletRow>(`${WALLET_SELECT} WHERE w.id = $1`, [walletId])
    : await deps.db.query<WalletRow>(`${WALLET_SELECT} WHERE w.id = $1 AND w.customer_id = $2`, [
        walletId,
        a.customerId,
      ]);
  const wallet = r.rows[0];
  // 404 (not 403) for other customers' wallets: existence is not leaked (IDOR-safe).
  if (!wallet) throw new AppError("NOT_FOUND", "Wallet not found.");
  return { wallet, masked: staff };
}

export function accountsRouter(deps: Deps): Router {
  const r = Router();
  const reqId = (res: Response) => String(res.locals.requestId);

  // ---- Customer profile ------------------------------------------------------------------------------------------
  r.get(
    "/me",
    route(async (_req, res) => {
      const a = getAuth(res);
      const q = await deps.db.query<{
        email: string;
        full_name: string | null;
        kyc_status: string | null;
        created_at: Date;
      }>(
        `SELECT u.email, c.full_name, c.kyc_status, u.created_at FROM users u LEFT JOIN customers c ON c.user_id = u.id WHERE u.id = $1`,
        [a.userId],
      );
      const u = q.rows[0];
      ok(res, {
        user_id: a.userId,
        email: u?.email,
        full_name: u?.full_name,
        kyc_status: u?.kyc_status,
        roles: a.roles,
        customer_id: a.customerId,
      });
    }),
  );

  r.patch(
    "/me",
    requirePermission(deps, "self:manage"),
    route(async (req, res) => {
      const body = parse(mePatchBody, req.body);
      const customerId = customerIdOf(res);
      await withTx(deps.db, { actorId: getAuth(res).userId, requestId: reqId(res) }, async (c) => {
        await c.query(`UPDATE customers SET full_name = $2 WHERE id = $1`, [
          customerId,
          body.full_name,
        ]);
        await audit(c, {
          actorId: getAuth(res).userId,
          action: "customer.update",
          resourceType: "customer",
          resourceId: customerId,
          outcome: "ALLOWED",
          requestId: reqId(res),
        });
      });
      ok(res, { updated: true });
    }),
  );

  r.get(
    "/customers",
    requirePermission(deps, "customers:read"),
    route(async (req, res) => {
      const q = parse(pageQuery.extend({ q: z.string().max(100).optional() }), req.query);
      const params: unknown[] = [];
      let where = "WHERE true";
      if (q.q) {
        params.push(`%${q.q.toLowerCase()}%`);
        where += ` AND (lower(u.email::text) LIKE $${params.length} OR lower(c.full_name) LIKE $${params.length})`;
      }
      where += afterCursor(decodeCursor(q.cursor), params, "c");
      params.push(q.limit + 1);
      const rows = await deps.db.query<{
        id: string;
        email: string;
        full_name: string;
        kyc_status: string;
        created_at: Date;
        wallets: number;
      }>(
        `SELECT c.id, u.email, c.full_name, c.kyc_status, c.created_at,
                (SELECT count(*)::int FROM wallets w WHERE w.customer_id = c.id) AS wallets
           FROM customers c JOIN users u ON u.id = c.user_id ${where} ORDER BY c.created_at, c.id LIMIT $${params.length}`,
        params,
      );
      const p = page(rows.rows, q.limit);
      // Staff see masked PII only (brief §2: "read (masked)").
      ok(
        res,
        p.items.map((c) => ({
          id: c.id,
          email: maskEmail(c.email),
          full_name: maskName(c.full_name),
          kyc_status: c.kyc_status,
          wallets: c.wallets,
          created_at: c.created_at,
        })),
        200,
        { next_cursor: p.nextCursor },
      );
    }),
  );

  // ---- Wallets ---------------------------------------------------------------------------------------------------
  r.post(
    "/wallets",
    requirePermission(deps, "self:manage"),
    route(async (req, res) => {
      const body = parse(walletCreateBody, req.body);
      const customerId = customerIdOf(res);
      const a = getAuth(res);
      for (let attempt = 0; attempt < 5; attempt++) {
        const accountNumber = `FC${randomInt(1_000_000_000, 9_999_999_999)}`; // synthetic
        try {
          const id = await withTx(
            deps.db,
            { actorId: a.userId, requestId: reqId(res) },
            async (c) => {
              const acct = await c.query<{ id: string }>(
                `INSERT INTO accounts (code, name, type, normal_side, currency) VALUES ('WAL:' || $1, 'Customer wallet ' || $1, 'LIABILITY', 'CREDIT', $2) RETURNING id`,
                [accountNumber, body.currency],
              );
              const w = await c.query<{ id: string }>(
                `INSERT INTO wallets (customer_id, account_id, currency, account_number, nickname) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                [customerId, acct.rows[0]?.id, body.currency, accountNumber, body.nickname ?? null],
              );
              const walletId = w.rows[0]?.id as string;
              await audit(c, {
                actorId: a.userId,
                action: "wallet.create",
                resourceType: "wallet",
                resourceId: walletId,
                outcome: "ALLOWED",
                requestId: reqId(res),
                metadata: { currency: body.currency },
              });
              return walletId;
            },
          );
          const { wallet } = await loadWallet(deps, res, id);
          return ok(res, walletView(wallet, false), 201);
        } catch (err) {
          if (isPgError(err) && err.code === DB_ERROR.UNIQUE_VIOLATION) continue; // account-number collision: retry
          throw err;
        }
      }
      throw new AppError("CONFLICT", "Could not allocate an account number. Please retry.");
    }),
  );

  r.get(
    "/wallets",
    route(async (req, res) => {
      const a = getAuth(res);
      const staff = can(a.roles, "customers:read");
      const q = parse(pageQuery.extend({ customer_id: z.uuid().optional() }), req.query);
      const params: unknown[] = [];
      let where: string;
      if (staff) {
        if (!q.customer_id)
          throw new AppError("VALIDATION_ERROR", "customer_id is required for staff.", [
            { path: "customer_id", message: "required" },
          ]);
        params.push(q.customer_id);
        where = `WHERE w.customer_id = $1`;
      } else {
        params.push(customerIdOf(res));
        where = `WHERE w.customer_id = $1`;
      }
      where += afterCursor(decodeCursor(q.cursor), params, "w");
      params.push(q.limit + 1);
      const rows = await deps.db.query<WalletRow>(
        `${WALLET_SELECT} ${where} ORDER BY w.created_at, w.id LIMIT $${params.length}`,
        params,
      );
      const p = page(rows.rows, q.limit);
      ok(
        res,
        p.items.map((w) => walletView(w, staff)),
        200,
        { next_cursor: p.nextCursor },
      );
    }),
  );

  r.get(
    "/wallets/:id",
    route(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const { wallet, masked } = await loadWallet(deps, res, id);
      ok(res, walletView(wallet, masked));
    }),
  );

  r.get(
    "/wallets/:id/balance",
    route(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const { wallet } = await loadWallet(deps, res, id);
      ok(res, {
        wallet_id: wallet.id,
        currency: wallet.currency,
        ...walletView(wallet, true).balance,
      });
    }),
  );

  /** Ledger lines for the wallet, newest first, with transaction state. Cursor = last entry id. */
  r.get(
    "/wallets/:id/transactions",
    route(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const q = parse(
        z.object({
          limit: z.coerce.number().int().min(1).max(100).default(20),
          cursor: z
            .string()
            .regex(/^\d{1,18}$/)
            .optional(),
          kind: z.string().max(30).optional(),
        }),
        req.query,
      );
      const { wallet } = await loadWallet(deps, res, id);
      const params: unknown[] = [wallet.account_id];
      let where = "e.account_id = $1";
      if (q.cursor) {
        params.push(q.cursor);
        where += ` AND e.id < $${params.length}`;
      }
      if (q.kind) {
        params.push(q.kind);
        where += ` AND t.kind = $${params.length}`;
      }
      params.push(q.limit + 1);
      const rows = await deps.db.query<{
        entry_id: bigint;
        transaction_id: string;
        kind: string;
        description: string;
        direction: string;
        amount_minor: bigint;
        posted_at: Date;
        transfer_status: string | null;
        reversed: boolean;
      }>(
        `SELECT e.id AS entry_id, t.id AS transaction_id, t.kind, t.description, e.direction, e.amount_minor, t.posted_at,
                tr.status AS transfer_status,
                EXISTS (SELECT 1 FROM transactions r WHERE r.reverses_transaction_id = t.id) AS reversed
           FROM ledger_entries e JOIN transactions t ON t.id = e.transaction_id
           LEFT JOIN transfers tr ON tr.transaction_id = t.id
          WHERE ${where} ORDER BY e.id DESC LIMIT $${params.length}`,
        params,
      );
      const items = rows.rows.slice(0, q.limit);
      const last = items[items.length - 1];
      ok(
        res,
        items.map((e) => ({
          entry_id: e.entry_id,
          transaction_id: e.transaction_id,
          kind: e.kind,
          description: e.description,
          direction: e.direction,
          amount_minor: e.amount_minor,
          posted_at: e.posted_at,
          state: e.reversed ? "REVERSED" : (e.transfer_status ?? "POSTED"),
        })),
        200,
        { next_cursor: rows.rows.length > q.limit && last ? String(last.entry_id) : null },
      );
    }),
  );

  // ---- Beneficiaries (adding one is a sensitive action: step-up required) -----------------------------------------
  r.post(
    "/beneficiaries",
    requirePermission(deps, "self:manage"),
    route(async (req, res) => {
      const body = parse(beneficiaryCreateBody, req.body);
      const customerId = customerIdOf(res);
      await assertRecentReauth(deps, res, "beneficiary.create");
      const a = getAuth(res);
      const target = await deps.db.query<{ id: string; status: string; currency: string }>(
        `SELECT id, status, currency FROM wallets WHERE account_number = $1`,
        [body.account_number],
      );
      const w = target.rows[0];
      if (!w || w.status !== "ACTIVE")
        throw new AppError("NOT_FOUND", "No active FinCore account with that number.");
      try {
        const row = await withTx(
          deps.db,
          { actorId: a.userId, requestId: reqId(res) },
          async (c) => {
            const b = await c.query<{ id: string; created_at: Date }>(
              `INSERT INTO beneficiaries (customer_id, target_wallet_id, nickname) VALUES ($1, $2, $3) RETURNING id, created_at`,
              [customerId, w.id, body.nickname],
            );
            await audit(c, {
              actorId: a.userId,
              action: "beneficiary.create",
              resourceType: "beneficiary",
              resourceId: b.rows[0]?.id,
              outcome: "ALLOWED",
              requestId: reqId(res),
            });
            return b.rows[0];
          },
        );
        ok(
          res,
          {
            id: row?.id,
            nickname: body.nickname,
            account_number: maskAccountNumber(body.account_number),
            currency: w.currency,
            created_at: row?.created_at,
          },
          201,
        );
      } catch (err) {
        if (isPgError(err) && err.code === DB_ERROR.UNIQUE_VIOLATION)
          throw new AppError("CONFLICT", "This beneficiary already exists.");
        throw err;
      }
    }),
  );

  r.get(
    "/beneficiaries",
    requirePermission(deps, "self:manage"),
    route(async (req, res) => {
      const q = parse(pageQuery, req.query);
      const params: unknown[] = [customerIdOf(res)];
      const where = `b.customer_id = $1 AND b.deleted_at IS NULL${afterCursor(decodeCursor(q.cursor), params, "b")}`;
      params.push(q.limit + 1);
      const rows = await deps.db.query<{
        id: string;
        nickname: string;
        account_number: string;
        currency: string;
        created_at: Date;
      }>(
        `SELECT b.id, b.nickname, w.account_number, w.currency, b.created_at FROM beneficiaries b
           JOIN wallets w ON w.id = b.target_wallet_id WHERE ${where} ORDER BY b.created_at, b.id LIMIT $${params.length}`,
        params,
      );
      const p = page(rows.rows, q.limit);
      ok(
        res,
        p.items.map((b) => ({ ...b, account_number: maskAccountNumber(b.account_number) })),
        200,
        { next_cursor: p.nextCursor },
      );
    }),
  );

  r.delete(
    "/beneficiaries/:id",
    requirePermission(deps, "self:manage"),
    route(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const a = getAuth(res);
      await withTx(deps.db, { actorId: a.userId, requestId: reqId(res) }, async (c) => {
        const u = await c.query(
          `UPDATE beneficiaries SET deleted_at = now() WHERE id = $1 AND customer_id = $2 AND deleted_at IS NULL`,
          [id, customerIdOf(res)],
        );
        if (u.rowCount !== 1) throw new AppError("NOT_FOUND", "Beneficiary not found.");
        await audit(c, {
          actorId: a.userId,
          action: "beneficiary.delete",
          resourceType: "beneficiary",
          resourceId: id,
          outcome: "ALLOWED",
          requestId: reqId(res),
        });
      });
      ok(res, { deleted: true });
    }),
  );

  return r;
}
