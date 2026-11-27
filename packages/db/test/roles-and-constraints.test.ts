import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DB_ERROR } from "../src/errors.js";
import { withClientTransaction } from "../src/pool.js";
import {
  analytics,
  app,
  expectPgError,
  FAKE_ARGON2_HASH,
  owner,
  systemAccount,
} from "./helpers.js";

describe("credentials", () => {
  it("rejects anything that is not an Argon2id hash (no plaintext passwords)", async () => {
    await expectPgError(
      app.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'hunter2')`, [
        `p-${randomUUID()}@fincore.test`,
      ]),
      DB_ERROR.CHECK_VIOLATION,
      "users_password_hash_check",
    );
    await expectPgError(
      app.query(`INSERT INTO users (email, password_hash) VALUES ($1, '$2b$10$bcrypt...')`, [
        `p-${randomUUID()}@fincore.test`,
      ]),
      DB_ERROR.CHECK_VIOLATION,
      "users_password_hash_check",
    );
  });

  it("treats emails case-insensitively (citext UNIQUE)", async () => {
    const email = `Case-${randomUUID()}@FinCore.test`;
    await app.query(`INSERT INTO users (email, password_hash) VALUES ($1, $2)`, [
      email,
      FAKE_ARGON2_HASH,
    ]);
    await expectPgError(
      app.query(`INSERT INTO users (email, password_hash) VALUES ($1, $2)`, [
        email.toLowerCase(),
        FAKE_ARGON2_HASH,
      ]),
      DB_ERROR.UNIQUE_VIOLATION,
    );
  });
});

describe("chart of accounts", () => {
  it("has exactly one of each system account per currency", async () => {
    const r = await app.query<{ currency: string; n: bigint }>(
      `SELECT currency, count(*) AS n FROM accounts WHERE is_system GROUP BY currency ORDER BY currency`,
    );
    expect(r.rows).toEqual([
      { currency: "INR", n: 7n },
      { currency: "JPY", n: 7n },
      { currency: "USD", n: 7n },
    ]);
  });

  it("accounts are immutable (no privilege for the app, a trigger for the owner)", async () => {
    const acct = await systemAccount("FEES_REVENUE");
    await expectPgError(
      app.query(`UPDATE accounts SET currency = 'USD' WHERE id = $1`, [acct]),
      DB_ERROR.INSUFFICIENT_PRIVILEGE,
    );
    await expectPgError(
      owner.query(`UPDATE accounts SET name = 'renamed' WHERE id = $1`, [acct]),
      DB_ERROR.APPEND_ONLY,
    );
    await expectPgError(
      owner.query(`DELETE FROM accounts WHERE id = $1`, [acct]),
      DB_ERROR.APPEND_ONLY,
    );
  });

  it("rejects an account whose normal side contradicts its type", async () => {
    await expectPgError(
      app.query(
        `INSERT INTO accounts (code, name, type, normal_side, currency) VALUES ($1, 'bad', 'LIABILITY', 'DEBIT', 'INR')`,
        [`WAL:${randomUUID()}`],
      ),
      DB_ERROR.CHECK_VIOLATION,
      "accounts_normal_side_matches_type",
    );
  });

  it("a wallet can only be backed by a non-system LIABILITY account", async () => {
    const clearing = await systemAccount("PROVIDER_CLEARING");
    await expectPgError(
      withClientTransaction(app, async (c) => {
        const u = await c.query<{ id: string }>(
          `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
          [`w-${randomUUID()}@fincore.test`, FAKE_ARGON2_HASH],
        );
        const cust = await c.query<{ id: string }>(
          `INSERT INTO customers (user_id, full_name) VALUES ($1, 'x') RETURNING id`,
          [u.rows[0]!.id],
        );
        await c.query(
          `INSERT INTO wallets (customer_id, account_id, currency, account_number) VALUES ($1, $2, 'INR', 'FC0000000001')`,
          [cust.rows[0]!.id, clearing],
        );
      }),
      DB_ERROR.INVALID_WALLET_ACCOUNT,
    );
  });
});

describe("least-privilege roles", () => {
  it("the app role cannot create objects or read the migrations table", async () => {
    await expectPgError(app.query(`CREATE TABLE sneaky (id int)`), DB_ERROR.INSUFFICIENT_PRIVILEGE);
    await expectPgError(
      app.query(`SELECT * FROM schema_migrations`),
      DB_ERROR.INSUFFICIENT_PRIVILEGE,
    );
  });

  it("the analytics role cannot see or read core tables and is read-only by default", async () => {
    // No USAGE on schema public: unqualified names don't even resolve, and qualified access is denied.
    await expectPgError(analytics.query(`SELECT * FROM users`), "42P01");
    await expectPgError(
      analytics.query(`SELECT * FROM public.users`),
      DB_ERROR.INSUFFICIENT_PRIVILEGE,
    );
    await expectPgError(
      analytics.query(`SELECT * FROM public.ledger_entries`),
      DB_ERROR.INSUFFICIENT_PRIVILEGE,
    );
    const ro = await analytics.query<{ default_transaction_read_only: string }>(
      `SHOW default_transaction_read_only`,
    );
    expect(ro.rows[0]!.default_transaction_read_only).toBe("on");
  });

  it("runtime sessions carry a statement timeout", async () => {
    const r = await app.query<{ statement_timeout: string }>(`SHOW statement_timeout`);
    expect(r.rows[0]!.statement_timeout).toBe("10s");
  });
});
