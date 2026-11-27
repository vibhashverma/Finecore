import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  addBeneficiary,
  api,
  balance,
  buildHarness,
  createUser,
  drainJobs,
  expectInvariantsHold,
  login,
  reauth,
  type Harness,
  type TestUser,
} from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await buildHarness();
});
afterEach(async () => {
  h.analytics.down = false;
  h.analytics.score = 10;
  await expectInvariantsHold(h); // brief §9: global invariant check after every integration test
});

async function pair(fund = 1_000_000n) {
  const a = await createUser(h, { fund });
  const b = await createUser(h, { fund: 0n });
  const token = await login(h, a.email);
  const beneficiaryId = await addBeneficiary(h, token, b.wallet?.accountNumber as string);
  return { a, b, token, beneficiaryId };
}

const send = (
  token: string,
  a: TestUser,
  beneficiaryId: string,
  amount: string,
  key = randomUUID(),
) =>
  api(h, token).post(
    "/transfers",
    { source_wallet_id: a.wallet?.walletId, beneficiary_id: beneficiaryId, amount_minor: amount },
    key,
  );

describe("transfers: success and validation", () => {
  it("posts a transfer with a Decimal fee, balanced entries and correct balances", async () => {
    const { a, b, token, beneficiaryId } = await pair();
    const r = await send(token, a, beneficiaryId, "100000"); // ₹1,000.00 → fee 0.10% = ₹1.00
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      status: "POSTED",
      amount_minor: "100000",
      fee_minor: "100",
      simulated: true,
    });
    expect(await balance(h, a.wallet?.accountId as string)).toEqual({ posted: 899_900n, held: 0n });
    expect(await balance(h, b.wallet?.accountId as string)).toEqual({ posted: 100_000n, held: 0n });
    const lines = await h.deps.db.query(
      `SELECT direction, amount_minor FROM ledger_entries WHERE transaction_id = $1 ORDER BY id`,
      [r.body.data.transaction_id],
    );
    expect(lines.rows).toHaveLength(3);
    await drainJobs(h);
    expect(h.notifier.emails.some((e) => e.to === a.email)).toBe(true);
  });

  it("insufficient funds → 422 and no ledger entries", async () => {
    const { a, token, beneficiaryId } = await pair(50_000n);
    const before = await h.deps.db.query(
      `SELECT count(*)::int AS n FROM transfers WHERE customer_id = $1`,
      [a.customerId],
    );
    const r = await send(token, a, beneficiaryId, "50000"); // + ₹1 minimum fee → exceeds
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("INSUFFICIENT_FUNDS");
    const after = await h.deps.db.query(
      `SELECT count(*)::int AS n FROM transfers WHERE customer_id = $1`,
      [a.customerId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect((await balance(h, a.wallet?.accountId as string)).posted).toBe(50_000n);
  });

  it("validates input strictly (number amounts, zero, missing key)", async () => {
    const { a, token, beneficiaryId } = await pair();
    const asNumber = await api(h, token).post(
      "/transfers",
      { source_wallet_id: a.wallet?.walletId, beneficiary_id: beneficiaryId, amount_minor: 100 },
      randomUUID(),
    );
    expect(asNumber.body.error.code).toBe("VALIDATION_ERROR"); // floats/numbers are never accepted for money
    const zero = await send(token, a, beneficiaryId, "0");
    expect(zero.status).toBe(400);
    const noKey = await api(h, token).post("/transfers", {
      source_wallet_id: a.wallet?.walletId,
      beneficiary_id: beneficiaryId,
      amount_minor: "100",
    });
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.details[0].path).toBe("Idempotency-Key");
  });

  it("over the per-transfer limit → 422 LIMIT_EXCEEDED", async () => {
    const { a, token, beneficiaryId } = await pair();
    expect((await send(token, a, beneficiaryId, "10000001")).body.error.code).toBe(
      "LIMIT_EXCEEDED",
    );
  });

  it("large transfers need step-up reauthentication (transaction confirmation)", async () => {
    const { a, token, beneficiaryId } = await pair(5_000_000n);
    // pair() reauthenticated to add the beneficiary; age that step-up beyond the 5-minute window.
    await h.deps.db.query(
      `UPDATE sessions SET reauth_at = now() - interval '10 minutes' WHERE user_id = $1`,
      [a.userId],
    );
    const key = randomUUID();
    const r = await send(token, a, beneficiaryId, "2000000", key);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("REAUTH_REQUIRED");
    await reauth(h, token);
    expect((await send(token, a, beneficiaryId, "2000000", key)).status).toBe(201); // key was released, retry works
  });

  it("IDOR: cannot send from someone else's wallet or to someone else's beneficiary", async () => {
    const { a, beneficiaryId } = await pair();
    const mallory = await createUser(h);
    const mt = await login(h, mallory.email);
    expect((await send(mt, a, beneficiaryId, "100")).status).toBe(404);
    const mine = await api(h, mt).post(
      "/transfers",
      {
        source_wallet_id: mallory.wallet?.walletId,
        beneficiary_id: beneficiaryId,
        amount_minor: "100",
      },
      randomUUID(),
    );
    expect(mine.status).toBe(404);
  });
});

describe("idempotency", () => {
  it("same key retried 5× → exactly one transfer and the same response each time", async () => {
    const { a, token, beneficiaryId } = await pair();
    const key = randomUUID();
    const responses = [];
    for (let i = 0; i < 5; i++) responses.push(await send(token, a, beneficiaryId, "1000", key));
    for (const r of responses) expect(r.body).toEqual(responses[0]?.body); // jsonb may reorder keys; compare semantically
    expect(responses.slice(1).every((r) => r.headers["idempotent-replayed"] === "true")).toBe(true);
    const n = await h.deps.db.query(
      `SELECT count(*)::int AS n FROM transfers WHERE customer_id = $1`,
      [a.customerId],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("same key with a different body → 422 IDEMPOTENCY_KEY_REUSED", async () => {
    const { a, token, beneficiaryId } = await pair();
    const key = randomUUID();
    await send(token, a, beneficiaryId, "1000", key);
    const r = await send(token, a, beneficiaryId, "2000", key);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("10 concurrent requests with the same key → one transfer; the rest replay or get 409", async () => {
    const { a, token, beneficiaryId } = await pair();
    const key = randomUUID();
    const rs = await Promise.all(
      Array.from({ length: 10 }, () => send(token, a, beneficiaryId, "1000", key)),
    );
    expect(rs.every((r) => [201, 409].includes(r.status))).toBe(true);
    const n = await h.deps.db.query(
      `SELECT count(*)::int AS n FROM transfers WHERE customer_id = $1`,
      [a.customerId],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("a stored business failure replays identically (insufficient funds)", async () => {
    const { a, token, beneficiaryId } = await pair(100n);
    const key = randomUUID();
    const r1 = await send(token, a, beneficiaryId, "1000", key);
    const r2 = await send(token, a, beneficiaryId, "1000", key);
    expect(r1.status).toBe(422);
    expect(r2.body).toEqual(r1.body);
  });
});

describe("concurrency (ADR-003)", () => {
  it("50 concurrent transfers from one wallet: no overdraft, total debited ≤ starting balance", async () => {
    const { a, b, token, beneficiaryId } = await pair(1_001_000n); // exactly 10 × (₹1,000.00 + ₹1.00 fee)
    const rs = await Promise.all(
      Array.from({ length: 50 }, () => send(token, a, beneficiaryId, "100000")),
    );
    const posted = rs.filter((r) => r.status === 201).length;
    expect(posted).toBe(10);
    expect(
      rs.filter((r) => r.status === 422).every((r) => r.body.error.code === "INSUFFICIENT_FUNDS"),
    ).toBe(true);
    expect(await balance(h, a.wallet?.accountId as string)).toEqual({ posted: 0n, held: 0n });
    expect((await balance(h, b.wallet?.accountId as string)).posted).toBe(1_000_000n);
  });

  it("opposing concurrent transfers A↔B: no deadlock, both sides consistent", async () => {
    const a = await createUser(h, { fund: 1_000_000n });
    const b = await createUser(h, { fund: 1_000_000n });
    const ta = await login(h, a.email);
    const tb = await login(h, b.email);
    const benB = await addBeneficiary(h, ta, b.wallet?.accountNumber as string);
    const benA = await addBeneficiary(h, tb, a.wallet?.accountNumber as string);
    const rs = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0 ? send(ta, a, benB, "10000") : send(tb, b, benA, "10000"),
      ),
    );
    expect(rs.every((r) => r.status === 201)).toBe(true);
    const total =
      (await balance(h, a.wallet?.accountId as string)).posted! +
      (await balance(h, b.wallet?.accountId as string)).posted!;
    expect(total).toBe(2_000_000n - 20n * 100n); // only the fees left the pair
  });
});

describe("risk review and fail-safe", () => {
  it("high score → 202 PENDING with a hold; ops CLEARED → POSTED", async () => {
    h.analytics.score = 90;
    const { a, token, beneficiaryId } = await pair();
    const r = await send(token, a, beneficiaryId, "50000");
    expect(r.status).toBe(202);
    expect(r.body.data.status).toBe("PENDING");
    expect(r.body.data.risk.decision_support_only).toBe(true);
    expect((await balance(h, a.wallet?.accountId as string)).held).toBe(50_100n);

    const ops = await createUser(h, { roles: ["OPS"] });
    const ot = await login(h, ops.email);
    const alert = (
      await h.deps.db.query<{ id: string }>(`SELECT id FROM risk_alerts WHERE transfer_id = $1`, [
        r.body.data.id,
      ])
    ).rows[0]?.id;
    expect(
      (
        await api(h, ot).post(`/risk-alerts/${alert}/transition`, {
          to: "INVESTIGATING",
          note: "checking",
        })
      ).status,
    ).toBe(200);
    const cleared = await api(h, ot).post(`/risk-alerts/${alert}/transition`, {
      to: "CLEARED",
      note: "verified with customer",
    });
    expect(cleared.body.data.transfer_status).toBe("POSTED");
    expect(await balance(h, a.wallet?.accountId as string)).toEqual({
      posted: 1_000_000n - 50_100n,
      held: 0n,
    });
  });

  it("ESCALATED → transfer FAILED and the hold released", async () => {
    h.analytics.score = 95;
    const { a, token, beneficiaryId } = await pair();
    const r = await send(token, a, beneficiaryId, "50000");
    const ops = await createUser(h, { roles: ["OPS"] });
    const ot = await login(h, ops.email);
    const alert = (
      await h.deps.db.query<{ id: string }>(`SELECT id FROM risk_alerts WHERE transfer_id = $1`, [
        r.body.data.id,
      ])
    ).rows[0]?.id;
    await api(h, ot).post(`/risk-alerts/${alert}/transition`, {
      to: "INVESTIGATING",
      note: "checking",
    });
    const esc = await api(h, ot).post(`/risk-alerts/${alert}/transition`, {
      to: "ESCALATED",
      note: "suspicious pattern",
    });
    expect(esc.body.data.transfer_status).toBe("FAILED");
    expect(await balance(h, a.wallet?.accountId as string)).toEqual({
      posted: 1_000_000n,
      held: 0n,
    });
  });

  it("analytics outage: fee unavailable → 503 and the key is released (no transfer)", async () => {
    const { a, token, beneficiaryId } = await pair();
    h.analytics.down = true;
    const key = randomUUID();
    const r = await send(token, a, beneficiaryId, "1000", key);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("UPSTREAM_UNAVAILABLE");
    h.analytics.down = false;
    expect((await send(token, a, beneficiaryId, "1000", key)).status).toBe(201);
  });
});

describe("reversals", () => {
  async function postedTransfer() {
    const p = await pair();
    const r = await send(p.token, p.a, p.beneficiaryId, "100000");
    const fin = await createUser(h, { roles: ["FINANCE"] });
    const ft = await login(h, fin.email);
    return { ...p, transferId: r.body.data.id as string, ft };
  }

  it("finance reverses a posted transfer: new mirrored journal, original untouched, balances restored", async () => {
    const { a, b, transferId, ft } = await postedTransfer();
    await reauth(h, ft);
    const r = await api(h, ft).post(
      `/transfers/${transferId}/reverse`,
      { reason: "customer error" },
      randomUUID(),
    );
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe("REVERSED");
    expect(await balance(h, a.wallet?.accountId as string)).toEqual({
      posted: 1_000_000n,
      held: 0n,
    });
    expect((await balance(h, b.wallet?.accountId as string)).posted).toBe(0n);
  });

  it("double reversal → 409 INVALID_STATE_TRANSITION", async () => {
    const { transferId, ft } = await postedTransfer();
    await reauth(h, ft);
    await api(h, ft).post(`/transfers/${transferId}/reverse`, { reason: "first" }, randomUUID());
    const second = await api(h, ft).post(
      `/transfers/${transferId}/reverse`,
      { reason: "second" },
      randomUUID(),
    );
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("INVALID_STATE_TRANSITION");
  });

  it("reversal without fresh reauth → 401 REAUTH_REQUIRED", async () => {
    const { transferId, ft } = await postedTransfer();
    const r = await api(h, ft).post(
      `/transfers/${transferId}/reverse`,
      { reason: "x-reason" },
      randomUUID(),
    );
    expect(r.body.error.code).toBe("REAUTH_REQUIRED");
  });
});
