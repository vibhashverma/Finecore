import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DB_ERROR } from "../src/errors.js";
import { withClientTransaction } from "../src/pool.js";
import {
  app,
  balanceOf,
  expectPgError,
  insertJournal,
  newWallet,
  owner,
  postJournal,
  transactionExists,
  transfer,
} from "./helpers.js";

describe("double-entry journal", () => {
  it("commits a balanced transfer and updates both cached balances", async () => {
    const a = await newWallet({ fund: 10_000n });
    const b = await newWallet();
    await transfer(a.accountId, b.accountId, 2_500n);
    expect(await balanceOf(a.accountId)).toEqual({ posted: 7_500n, held: 0n });
    expect(await balanceOf(b.accountId)).toEqual({ posted: 2_500n, held: 0n });
  });

  it("supports multi-line journals (transfer plus fee) as long as they balance", async () => {
    const a = await newWallet({ fund: 10_000n });
    const b = await newWallet();
    const fees = (
      await app.query<{ id: string }>(
        `SELECT id FROM accounts WHERE system_role = 'FEES_REVENUE' AND currency = 'INR'`,
      )
    ).rows[0]!.id;
    await postJournal([
      { accountId: a.accountId, direction: "DEBIT", amount: 1_010n },
      { accountId: b.accountId, direction: "CREDIT", amount: 1_000n },
      { accountId: fees, direction: "CREDIT", amount: 10n },
    ]);
    expect((await balanceOf(a.accountId)).posted).toBe(8_990n);
  });

  it("rejects an unbalanced journal at COMMIT and persists nothing", async () => {
    const a = await newWallet({ fund: 1_000n });
    const b = await newWallet();
    const id = randomUUID();
    await expectPgError(
      postJournal(
        [
          { accountId: a.accountId, direction: "DEBIT", amount: 100n },
          { accountId: b.accountId, direction: "CREDIT", amount: 99n },
        ],
        { id },
      ),
      DB_ERROR.UNBALANCED,
    );
    expect(await transactionExists(id)).toBe(false);
    expect((await balanceOf(a.accountId)).posted).toBe(1_000n);
  });

  it("rejects a journal with a single line", async () => {
    const a = await newWallet({ fund: 1_000n });
    await expectPgError(
      postJournal([{ accountId: a.accountId, direction: "DEBIT", amount: 1n }]),
      DB_ERROR.UNBALANCED,
    );
  });

  it("rejects a journal header with no lines", async () => {
    await expectPgError(postJournal([]), DB_ERROR.UNBALANCED);
  });

  it.each([0n, -5n])("rejects a line amount of %s", async (amount) => {
    const a = await newWallet({ fund: 1_000n });
    const b = await newWallet();
    await expectPgError(
      transfer(a.accountId, b.accountId, amount),
      DB_ERROR.CHECK_VIOLATION,
      "ledger_entries_amount_minor_check",
    );
  });

  it("rejects a line whose currency differs from its account (composite FK)", async () => {
    const inr = await newWallet({ fund: 1_000n });
    const usd = await newWallet({ currency: "USD" });
    await expectPgError(
      postJournal(
        [
          { accountId: inr.accountId, direction: "DEBIT", amount: 100n, currency: "USD" },
          { accountId: usd.accountId, direction: "CREDIT", amount: 100n, currency: "USD" },
        ],
        { currency: "USD" },
      ),
      DB_ERROR.FOREIGN_KEY_VIOLATION,
      "ledger_entries_account_fk",
    );
  });

  it("rejects mixing currencies inside one journal", async () => {
    const inr = await newWallet({ fund: 1_000n });
    const usd = await newWallet({ currency: "USD" });
    await expectPgError(
      postJournal(
        [
          { accountId: inr.accountId, direction: "DEBIT", amount: 100n },
          { accountId: usd.accountId, direction: "CREDIT", amount: 100n, currency: "USD" },
        ],
        { currency: "INR" },
      ),
      DB_ERROR.FOREIGN_KEY_VIOLATION,
      "ledger_entries_transaction_fk",
    );
  });

  it("rejects appending even a balanced pair to an already-committed journal", async () => {
    const a = await newWallet({ fund: 1_000n });
    const b = await newWallet();
    const id = await transfer(a.accountId, b.accountId, 100n);
    await expectPgError(
      withClientTransaction(app, async (c) => {
        for (const [acct, dir] of [
          [a.accountId, "DEBIT"],
          [b.accountId, "CREDIT"],
        ] as const) {
          await c.query(
            `INSERT INTO ledger_entries (transaction_id, account_id, currency, direction, amount_minor)
             VALUES ($1, $2, 'INR', $3, 50)`,
            [id, acct, dir],
          );
        }
      }),
      DB_ERROR.LATE_ENTRY,
    );
  });

  it("overwrites client-supplied server fields (posted_at)", async () => {
    const a = await newWallet({ fund: 1_000n });
    const b = await newWallet();
    const id = randomUUID();
    await withClientTransaction(app, async (c) => {
      await c.query(
        `INSERT INTO transactions (id, kind, currency, description, posted_at)
         VALUES ($1, 'TRANSFER', 'INR', 'backdating attempt', '2000-01-01')`,
        [id],
      );
      await c.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, currency, direction, amount_minor)
         VALUES ($1, $2, 'INR', 'DEBIT', 10), ($1, $3, 'INR', 'CREDIT', 10)`,
        [id, a.accountId, b.accountId],
      );
    });
    const r = await app.query<{ posted_at: Date }>(
      `SELECT posted_at FROM transactions WHERE id = $1`,
      [id],
    );
    expect(r.rows[0]!.posted_at.getUTCFullYear()).toBeGreaterThanOrEqual(2026);
  });
});

describe("append-only ledger", () => {
  async function aPostedJournal() {
    const a = await newWallet({ fund: 1_000n });
    const b = await newWallet();
    return transfer(a.accountId, b.accountId, 100n);
  }

  it("the app role has no privilege to UPDATE or DELETE ledger entries or journals", async () => {
    const id = await aPostedJournal();
    await expectPgError(
      app.query(`UPDATE ledger_entries SET amount_minor = 1 WHERE transaction_id = $1`, [id]),
      DB_ERROR.INSUFFICIENT_PRIVILEGE,
    );
    await expectPgError(
      app.query(`DELETE FROM ledger_entries WHERE transaction_id = $1`, [id]),
      DB_ERROR.INSUFFICIENT_PRIVILEGE,
    );
    await expectPgError(
      app.query(`UPDATE transactions SET description = 'x' WHERE id = $1`, [id]),
      DB_ERROR.INSUFFICIENT_PRIVILEGE,
    );
    await expectPgError(
      app.query(`DELETE FROM transactions WHERE id = $1`, [id]),
      DB_ERROR.INSUFFICIENT_PRIVILEGE,
    );
  });

  it("even the schema owner cannot UPDATE, DELETE or TRUNCATE ledger tables (trigger)", async () => {
    const id = await aPostedJournal();
    await expectPgError(
      owner.query(
        `UPDATE ledger_entries SET amount_minor = amount_minor + 1 WHERE transaction_id = $1`,
        [id],
      ),
      DB_ERROR.APPEND_ONLY,
    );
    await expectPgError(
      owner.query(`DELETE FROM ledger_entries WHERE transaction_id = $1`, [id]),
      DB_ERROR.APPEND_ONLY,
    );
    await expectPgError(owner.query(`TRUNCATE ledger_entries CASCADE`), DB_ERROR.APPEND_ONLY);
    await expectPgError(
      owner.query(`UPDATE transactions SET description = 'edited' WHERE id = $1`, [id]),
      DB_ERROR.APPEND_ONLY,
    );
    await expectPgError(owner.query(`TRUNCATE transactions CASCADE`), DB_ERROR.APPEND_ONLY);
  });

  it("rolls back the whole journal if any statement fails mid-way", async () => {
    const a = await newWallet({ fund: 1_000n });
    const b = await newWallet();
    const id = randomUUID();
    await expect(
      withClientTransaction(app, async (c) => {
        await insertJournal(
          c,
          [
            { accountId: a.accountId, direction: "DEBIT", amount: 100n },
            { accountId: b.accountId, direction: "CREDIT", amount: 100n },
          ],
          { id },
        );
        throw new Error("simulated crash before commit");
      }),
    ).rejects.toThrow("simulated crash");
    expect(await transactionExists(id)).toBe(false);
    expect((await balanceOf(a.accountId)).posted).toBe(1_000n);
  });
});
