import { randomInt, randomUUID } from "node:crypto";
import type pg from "pg";
import { expect, inject } from "vitest";
import { isPgError, type PgError } from "../src/errors.js";
import { createPool, withClientTransaction } from "../src/pool.js";
import { openWallet } from "../src/seed.js";

const urls = inject("db");

/** The runtime role used by the API: every rule must hold for this connection. */
export const app = createPool(urls.appUrl, { max: 60, applicationName: "test-app" });
/** The schema owner: proves triggers still hold when grants would allow more. */
export const owner = createPool(urls.ownerUrl, { max: 4, applicationName: "test-owner" });
/** Superuser: only used to simulate an attacker who bypasses triggers (tamper detection). */
export const superuser = createPool(urls.superUrl, { max: 2, applicationName: "test-super" });
export const analytics = createPool(urls.analyticsUrl, {
  max: 2,
  applicationName: "test-analytics",
});

export async function closePools(): Promise<void> {
  await Promise.all([app.end(), owner.end(), superuser.end(), analytics.end()]);
}

/** A syntactically valid Argon2id PHC string (tests don't need a real hash). */
export const FAKE_ARGON2_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaGhhc2hoYXNo";

export async function expectPgError(
  promise: Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<PgError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected SQLSTATE ${code}, but the statement succeeded`).not.toBeNull();
  if (!isPgError(err)) throw err;
  expect(err.code, err.message).toBe(code);
  if (constraint) expect(err.constraint).toBe(constraint);
  return err;
}

export interface TestWallet {
  walletId: string;
  accountId: string;
  customerId: string;
}

export async function newWallet(
  opts: { currency?: string; fund?: bigint } = {},
): Promise<TestWallet> {
  const currency = opts.currency ?? "INR";
  return withClientTransaction(app, async (c) => {
    const user = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
      [`t-${randomUUID()}@fincore.test`, FAKE_ARGON2_HASH],
    );
    const cust = await c.query<{ id: string }>(
      `INSERT INTO customers (user_id, full_name) VALUES ($1, 'Test Customer (synthetic)') RETURNING id`,
      [user.rows[0]!.id],
    );
    const customerId = cust.rows[0]!.id;
    const accountNumber = `FC${randomInt(1_000_000_000, 9_999_999_999)}`;
    const w = await openWallet(c, customerId, currency, accountNumber, opts.fund ?? 0n);
    return { walletId: w.walletId, accountId: w.accountId, customerId };
  });
}

export async function systemAccount(role: string, currency = "INR"): Promise<string> {
  const r = await app.query<{ id: string }>(
    `SELECT id FROM accounts WHERE system_role = $1 AND currency = $2`,
    [role, currency],
  );
  return r.rows[0]!.id;
}

export interface Line {
  accountId: string;
  direction: "DEBIT" | "CREDIT";
  amount: bigint;
  currency?: string;
}

export interface PostOptions {
  id?: string;
  kind?: string;
  currency?: string;
  reverses?: string;
  description?: string;
}

/** Inserts a journal header and its lines inside an existing transaction (no commit). */
export async function insertJournal(
  c: pg.PoolClient,
  lines: Line[],
  opts: PostOptions = {},
): Promise<string> {
  const id = opts.id ?? randomUUID();
  const currency = opts.currency ?? "INR";
  await c.query(
    `INSERT INTO transactions (id, kind, currency, description, reverses_transaction_id) VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      opts.kind ?? "TRANSFER",
      currency,
      opts.description ?? "test journal",
      opts.reverses ?? null,
    ],
  );
  for (const l of lines) {
    await c.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, currency, direction, amount_minor) VALUES ($1, $2, $3, $4, $5)`,
      [id, l.accountId, l.currency ?? currency, l.direction, l.amount.toString()],
    );
  }
  return id;
}

/** Posts a journal in its own transaction. The deferred integrity check runs at COMMIT. */
export async function postJournal(
  lines: Line[],
  opts: PostOptions = {},
  pool: pg.Pool = app,
): Promise<string> {
  return withClientTransaction(pool, (c) => insertJournal(c, lines, opts));
}

export const transfer = (from: string, to: string, amount: bigint, opts: PostOptions = {}) =>
  postJournal(
    [
      { accountId: from, direction: "DEBIT", amount },
      { accountId: to, direction: "CREDIT", amount },
    ],
    opts,
  );

export async function balanceOf(accountId: string): Promise<{ posted: bigint; held: bigint }> {
  const r = await app.query<{ posted_minor: bigint; held_minor: bigint }>(
    `SELECT posted_minor, held_minor FROM account_balances WHERE account_id = $1`,
    [accountId],
  );
  const row = r.rows[0]!;
  return { posted: row.posted_minor, held: row.held_minor };
}

export async function transactionExists(id: string): Promise<boolean> {
  const r = await app.query(`SELECT 1 FROM transactions WHERE id = $1`, [id]);
  return r.rowCount === 1;
}

export async function invariantViolations(): Promise<
  Array<{ check_name: string; detail: string }>
> {
  const r = await app.query<{ check_name: string; detail: string }>(
    `SELECT * FROM ledger_invariant_violations()`,
  );
  return r.rows;
}
