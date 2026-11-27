import { describe, expect, it } from "vitest";
import { DB_ERROR, OVERDRAFT_CONSTRAINT } from "../src/errors.js";
import { app, balanceOf, expectPgError, newWallet, postJournal, transfer } from "./helpers.js";

async function postedTransfer(amount = 400n) {
  const a = await newWallet({ fund: 1_000n });
  const b = await newWallet();
  const original = await transfer(a.accountId, b.accountId, amount);
  return { a, b, original };
}

const mirror = (from: string, to: string, amount: bigint, original: string) =>
  postJournal(
    [
      { accountId: to, direction: "DEBIT", amount },
      { accountId: from, direction: "CREDIT", amount },
    ],
    { kind: "REVERSAL", reverses: original },
  );

describe("reversals", () => {
  it("an exact mirror reverses the movement and leaves the original untouched", async () => {
    const { a, b, original } = await postedTransfer();
    const before = await app.query(
      `SELECT * FROM ledger_entries WHERE transaction_id = $1 ORDER BY id`,
      [original],
    );

    await mirror(a.accountId, b.accountId, 400n, original);

    expect(await balanceOf(a.accountId)).toEqual({ posted: 1_000n, held: 0n });
    expect(await balanceOf(b.accountId)).toEqual({ posted: 0n, held: 0n });
    const after = await app.query(
      `SELECT * FROM ledger_entries WHERE transaction_id = $1 ORDER BY id`,
      [original],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("a transaction can be reversed only once (UNIQUE)", async () => {
    const { a, b, original } = await postedTransfer();
    await mirror(a.accountId, b.accountId, 400n, original);
    await expectPgError(
      mirror(a.accountId, b.accountId, 400n, original),
      DB_ERROR.UNIQUE_VIOLATION,
      "transactions_reverses_transaction_id_key",
    );
  });

  it("a reversal with a different amount is rejected at COMMIT", async () => {
    const { a, b, original } = await postedTransfer();
    await expectPgError(
      mirror(a.accountId, b.accountId, 399n, original),
      DB_ERROR.INVALID_REVERSAL,
    );
  });

  it("a reversal hitting the wrong accounts is rejected", async () => {
    const { a, original } = await postedTransfer();
    const other = await newWallet({ fund: 1_000n });
    await expectPgError(
      mirror(a.accountId, other.accountId, 400n, original),
      DB_ERROR.INVALID_REVERSAL,
    );
  });

  it("a reversal cannot itself be reversed", async () => {
    const { a, b, original } = await postedTransfer();
    const reversal = await mirror(a.accountId, b.accountId, 400n, original);
    await expectPgError(
      postJournal(
        [
          { accountId: b.accountId, direction: "CREDIT", amount: 400n },
          { accountId: a.accountId, direction: "DEBIT", amount: 400n },
        ],
        { kind: "REVERSAL", reverses: reversal },
      ),
      DB_ERROR.INVALID_REVERSAL,
    );
  });

  it("kind and reverses_transaction_id must agree", async () => {
    const { a, b, original } = await postedTransfer();
    await expectPgError(
      postJournal(
        [
          { accountId: b.accountId, direction: "DEBIT", amount: 400n },
          { accountId: a.accountId, direction: "CREDIT", amount: 400n },
        ],
        { kind: "TRANSFER", reverses: original },
      ),
      DB_ERROR.CHECK_VIOLATION,
      "transactions_reversal_kind",
    );
    await expectPgError(
      postJournal(
        [
          { accountId: b.accountId, direction: "DEBIT", amount: 1n },
          { accountId: a.accountId, direction: "CREDIT", amount: 1n },
        ],
        { kind: "REVERSAL" },
      ),
      DB_ERROR.CHECK_VIOLATION,
      "transactions_reversal_kind",
    );
  });

  it("cannot reverse if the recipient has already spent the funds (no overdraft via reversal)", async () => {
    const { a, b, original } = await postedTransfer();
    const elsewhere = await newWallet();
    await transfer(b.accountId, elsewhere.accountId, 300n);
    await expectPgError(
      mirror(a.accountId, b.accountId, 400n, original),
      DB_ERROR.CHECK_VIOLATION,
      OVERDRAFT_CONSTRAINT,
    );
  });
});
