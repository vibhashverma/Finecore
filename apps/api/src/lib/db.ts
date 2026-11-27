import { DB_ERROR, isOverdraft, isPgError, isRetryableTxError } from "@fincore/db";
import type pg from "pg";
import { AppError } from "./errors.js";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export interface TxContext {
  actorId?: string | undefined;
  requestId?: string | undefined;
  reason?: string | undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Maps integrity errors raised by the database to API errors (docs/assessments/03-ledger-database.md). */
export function mapDbError(err: unknown): unknown {
  if (err instanceof AppError) return err;
  if (isOverdraft(err)) return new AppError("INSUFFICIENT_FUNDS", "Insufficient available funds.");
  if (isPgError(err)) {
    if (err.code === DB_ERROR.INVALID_STATE_TRANSITION)
      return new AppError(
        "INVALID_STATE_TRANSITION",
        "This action is not allowed in the current state.",
      );
    if (err.code === DB_ERROR.LOCK_NOT_AVAILABLE || err.code === DB_ERROR.QUERY_CANCELED)
      return new AppError(
        "UPSTREAM_UNAVAILABLE",
        "The system is busy. Retry with the same Idempotency-Key.",
      );
  }
  return err;
}

/**
 * Runs `fn` in one READ COMMITTED transaction (ADR-003):
 *  - lock_timeout 3s so lock waits fail fast instead of piling up;
 *  - actor/reason/request id exposed to triggers (state history, ADR-007);
 *  - retries the WHOLE transaction on serialization failure / deadlock, with jittered backoff.
 */
export async function withTx<T>(
  db: Db,
  ctx: TxContext,
  fn: (c: Tx) => Promise<T>,
  retries = 3,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        `SELECT set_config('lock_timeout', '3s', true),
                set_config('fincore.actor_id', $1, true),
                set_config('fincore.request_id', $2, true),
                set_config('fincore.reason', $3, true)`,
        [ctx.actorId ?? "", ctx.requestId ?? "", ctx.reason ?? ""],
      );
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      if (isRetryableTxError(err) && attempt < retries) {
        await sleep(Math.random() * 25 * 2 ** attempt);
        continue;
      }
      throw mapDbError(err);
    } finally {
      c.release();
    }
  }
}

/** Locks cached balances in ascending account-id order: deadlock-free lock ordering (ADR-003). */
export async function lockBalances(c: Tx, accountIds: string[]) {
  const ids = [...new Set(accountIds)].sort();
  const r = await c.query<{
    account_id: string;
    posted_minor: bigint;
    held_minor: bigint;
    floor_minor: bigint;
  }>(
    `SELECT account_id, posted_minor, held_minor, floor_minor FROM account_balances
      WHERE account_id = ANY($1::uuid[]) ORDER BY account_id FOR UPDATE`,
    [ids],
  );
  return new Map(r.rows.map((row) => [row.account_id, row]));
}

export async function systemAccountId(c: Tx | Db, role: string, currency: string): Promise<string> {
  const r = await c.query<{ id: string }>(
    `SELECT id FROM accounts WHERE system_role = $1 AND currency = $2`,
    [role, currency],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error(`system account ${role}/${currency} missing`);
  return id;
}

export interface JournalLine {
  accountId: string;
  direction: "DEBIT" | "CREDIT";
  amount: bigint;
}

/**
 * Posts a balanced journal (the DB re-checks balance at COMMIT). Zero-amount lines are dropped.
 * Credits are written before debits so a wallet never transiently breaches its floor (ADR-006).
 */
export async function postJournal(
  c: Tx,
  j: {
    kind: string;
    currency: string;
    description: string;
    referenceType?: string;
    referenceId?: string;
    reverses?: string;
    createdBy?: string | undefined;
    lines: JournalLine[];
  },
): Promise<string> {
  const t = await c.query<{ id: string }>(
    `INSERT INTO transactions (kind, currency, description, reference_type, reference_id, reverses_transaction_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      j.kind,
      j.currency,
      j.description,
      j.referenceType ?? null,
      j.referenceId ?? null,
      j.reverses ?? null,
      j.createdBy ?? null,
    ],
  );
  const id = t.rows[0]?.id as string;
  const lines = j.lines
    .filter((l) => l.amount > 0n)
    .sort((a, b) => (a.direction === b.direction ? 0 : a.direction === "CREDIT" ? -1 : 1));
  for (const l of lines) {
    await c.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, currency, direction, amount_minor) VALUES ($1, $2, $3, $4, $5)`,
      [id, l.accountId, j.currency, l.direction, l.amount.toString()],
    );
  }
  return id;
}

export async function enqueue(
  c: Tx,
  topic: string,
  payload: Record<string, unknown>,
  dedupeKey?: string,
) {
  await c.query(
    `INSERT INTO outbox (topic, payload, dedupe_key) VALUES ($1, $2, $3) ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      topic,
      JSON.stringify(payload, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
      dedupeKey ?? null,
    ],
  );
}
