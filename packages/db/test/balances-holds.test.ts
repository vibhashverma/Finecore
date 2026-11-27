import { describe, expect, it } from "vitest";
import { DB_ERROR, isOverdraft, OVERDRAFT_CONSTRAINT } from "../src/errors.js";
import { withClientTransaction } from "../src/pool.js";
import {
  app,
  balanceOf,
  expectPgError,
  newWallet,
  owner,
  systemAccount,
  transfer,
} from "./helpers.js";

async function placeHold(accountId: string, amount: bigint): Promise<string> {
  const r = await app.query<{ id: string }>(
    `INSERT INTO holds (account_id, amount_minor, reason) VALUES ($1, $2, 'TRANSFER_PENDING') RETURNING id`,
    [accountId, amount.toString()],
  );
  return r.rows[0]!.id;
}

describe("overdraft protection (database backstop)", () => {
  it("refuses a debit that would take a wallet below zero, with no app-level check at all", async () => {
    const a = await newWallet({ fund: 1_000n });
    const b = await newWallet();
    await expectPgError(
      transfer(a.accountId, b.accountId, 1_001n),
      DB_ERROR.CHECK_VIOLATION,
      OVERDRAFT_CONSTRAINT,
    );
    expect(await balanceOf(a.accountId)).toEqual({ posted: 1_000n, held: 0n });
    expect(await balanceOf(b.accountId)).toEqual({ posted: 0n, held: 0n });
  });

  it("allows spending exactly to zero (boundary)", async () => {
    const a = await newWallet({ fund: 1_000n });
    const b = await newWallet();
    await transfer(a.accountId, b.accountId, 1_000n);
    expect((await balanceOf(a.accountId)).posted).toBe(0n);
  });

  it("50 concurrent naive debits never overdraw: exactly floor(balance/amount) succeed", async () => {
    const source = await newWallet({ fund: 10_000n });
    const sink = await newWallet();
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => transfer(source.accountId, sink.accountId, 1_000n)),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toBe(10);
    expect(failed).toHaveLength(40);
    for (const f of failed) {
      const reason = (f as PromiseRejectedResult).reason as { code?: string; message?: string };
      expect(isOverdraft(reason), `${reason.code}: ${reason.message}`).toBe(true);
    }
    expect(await balanceOf(source.accountId)).toEqual({ posted: 0n, held: 0n });
    expect(await balanceOf(sink.accountId)).toEqual({ posted: 10_000n, held: 0n });
  });

  it("the app role can lock a balance row but cannot write balances", async () => {
    const a = await newWallet({ fund: 1_000n });
    await withClientTransaction(app, async (c) => {
      const r = await c.query(
        `SELECT posted_minor FROM account_balances WHERE account_id = $1 FOR UPDATE`,
        [a.accountId],
      );
      expect(r.rowCount).toBe(1);
    });
    await expectPgError(
      app.query(`UPDATE account_balances SET posted_minor = 999999999 WHERE account_id = $1`, [
        a.accountId,
      ]),
      DB_ERROR.INSUFFICIENT_PRIVILEGE,
    );
    await expectPgError(
      app.query(`UPDATE account_balances SET floor_minor = -1000000 WHERE account_id = $1`, [
        a.accountId,
      ]),
      DB_ERROR.INSUFFICIENT_PRIVILEGE,
    );
    await expectPgError(
      app.query(`DELETE FROM account_balances WHERE account_id = $1`, [a.accountId]),
      DB_ERROR.INSUFFICIENT_PRIVILEGE,
    );
  });

  it("system accounts have no balance row and may run negative (e.g. SIMULATED_FUNDING)", async () => {
    const funding = await systemAccount("SIMULATED_FUNDING");
    const r = await app.query(`SELECT 1 FROM account_balances WHERE account_id = $1`, [funding]);
    expect(r.rowCount).toBe(0);
  });
});

describe("holds", () => {
  it("reduce available funds; releasing restores them", async () => {
    const a = await newWallet({ fund: 1_000n });
    const b = await newWallet();
    const hold = await placeHold(a.accountId, 600n);
    expect(await balanceOf(a.accountId)).toEqual({ posted: 1_000n, held: 600n });

    // posted 1000 − held 600 = 400 available, so 500 must fail
    await expectPgError(
      transfer(a.accountId, b.accountId, 500n),
      DB_ERROR.CHECK_VIOLATION,
      OVERDRAFT_CONSTRAINT,
    );

    await app.query(`UPDATE holds SET status = 'RELEASED' WHERE id = $1`, [hold]);
    expect(await balanceOf(a.accountId)).toEqual({ posted: 1_000n, held: 0n });
    await transfer(a.accountId, b.accountId, 500n);
    expect((await balanceOf(a.accountId)).posted).toBe(500n);
  });

  it("refuses a hold larger than the available balance", async () => {
    const a = await newWallet({ fund: 1_000n });
    await placeHold(a.accountId, 700n);
    await expectPgError(
      placeHold(a.accountId, 301n),
      DB_ERROR.CHECK_VIOLATION,
      OVERDRAFT_CONSTRAINT,
    );
  });

  it("captures set released_at and stop counting toward held", async () => {
    const a = await newWallet({ fund: 1_000n });
    const hold = await placeHold(a.accountId, 250n);
    await app.query(`UPDATE holds SET status = 'CAPTURED' WHERE id = $1`, [hold]);
    const r = await app.query<{ released_at: Date | null }>(
      `SELECT released_at FROM holds WHERE id = $1`,
      [hold],
    );
    expect(r.rows[0]!.released_at).toBeInstanceOf(Date);
    expect((await balanceOf(a.accountId)).held).toBe(0n);
  });

  it("enforces the hold state machine (RELEASED cannot become ACTIVE again)", async () => {
    const a = await newWallet({ fund: 1_000n });
    const hold = await placeHold(a.accountId, 100n);
    await app.query(`UPDATE holds SET status = 'RELEASED' WHERE id = $1`, [hold]);
    await expectPgError(
      app.query(`UPDATE holds SET status = 'ACTIVE' WHERE id = $1`, [hold]),
      DB_ERROR.INVALID_STATE_TRANSITION,
    );
    await expectPgError(
      app.query(
        `INSERT INTO holds (account_id, amount_minor, reason, status) VALUES ($1, 1, 'DISPUTE', 'RELEASED')`,
        [a.accountId],
      ),
      DB_ERROR.INVALID_STATE_TRANSITION,
    );
  });

  it("hold amounts are immutable: no privilege for the app, a trigger for the owner", async () => {
    const a = await newWallet({ fund: 1_000n });
    const hold = await placeHold(a.accountId, 100n);
    await expectPgError(
      app.query(`UPDATE holds SET amount_minor = 1 WHERE id = $1`, [hold]),
      DB_ERROR.INSUFFICIENT_PRIVILEGE,
    );
    await expectPgError(
      owner.query(`UPDATE holds SET amount_minor = 1 WHERE id = $1`, [hold]),
      DB_ERROR.IMMUTABLE_FIELD,
    );
    await expectPgError(
      owner.query(`DELETE FROM holds WHERE id = $1`, [hold]),
      DB_ERROR.APPEND_ONLY,
    );
  });

  it("cannot be placed on a system account (no cached balance to protect)", async () => {
    const clearing = await systemAccount("PROVIDER_CLEARING");
    await expectPgError(
      placeHold(clearing, 1n),
      DB_ERROR.FOREIGN_KEY_VIOLATION,
      "holds_account_id_fkey",
    );
  });
});
