import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { signPayload } from "../src/integrations/provider.js";
import { runDueJobs } from "../src/jobs/runner.js";
import {
  api,
  balance,
  buildHarness,
  createUser,
  drainJobs,
  expectInvariantsHold,
  login,
  reauth,
  WEBHOOK_SECRET,
  type Harness,
} from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await buildHarness();
});
afterEach(async () => {
  Object.assign(h.provider.faults, { outage: false, duplicateDeliveries: 0, reverseOrder: false });
  h.analytics.down = false;
  h.notifier.failNext = 0;
  await expectInvariantsHold(h);
});

async function topUp(amount = "250000", method = "pm_simulated_success") {
  const u = await createUser(h, { fund: 0n });
  const token = await login(h, u.email);
  const pi = await api(h, token).post(
    "/payment-intents",
    { wallet_id: u.wallet?.walletId, amount_minor: amount },
    randomUUID(),
  );
  expect(pi.status, JSON.stringify(pi.body)).toBe(201);
  const conf = await api(h, token).post(
    `/payment-intents/${pi.body.data.id}/confirm`,
    { payment_method: method },
    randomUUID(),
  );
  expect(conf.status, JSON.stringify(conf.body)).toBe(202);
  return {
    u,
    token,
    intentId: pi.body.data.id as string,
    providerRef: pi.body.data.provider_ref as string,
  };
}

const intentStatus = async (id: string) =>
  (
    await h.deps.db.query<{ status: string }>(`SELECT status FROM payment_intents WHERE id = $1`, [
      id,
    ])
  ).rows[0]?.status;
const topupJournals = async (id: string) =>
  Number(
    (
      await h.deps.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM transactions WHERE reference_type = 'payment_intent' AND reference_id = $1`,
        [id],
      )
    ).rows[0]?.n,
  );

const deliverRaw = (body: unknown, sig?: string) => {
  const raw = JSON.stringify(body);
  return request(h.app)
    .post("/api/v1/webhooks/payments")
    .set("content-type", "application/json")
    .set("fincore-signature", sig ?? signPayload(WEBHOOK_SECRET, raw))
    .send(raw);
};

describe("payment intents and webhooks", () => {
  it("top-up: confirm → signed webhooks → wallet credited exactly once", async () => {
    const { u, intentId } = await topUp();
    await drainJobs(h);
    expect(await intentStatus(intentId)).toBe("SUCCEEDED");
    expect((await balance(h, u.wallet?.accountId as string)).posted).toBe(250_000n);
    expect(await topupJournals(intentId)).toBe(1);
  });

  it("webhook replay: the same event delivered 4× is processed once", async () => {
    h.provider.faults.duplicateDeliveries = 3;
    const { u, intentId } = await topUp("1000");
    await drainJobs(h);
    expect((await balance(h, u.wallet?.accountId as string)).posted).toBe(1000n);
    expect(await topupJournals(intentId)).toBe(1);
    const ev = await h.deps.db.query<{ deliveries: number }>(
      `SELECT deliveries FROM provider_events WHERE payload->'data'->>'provider_ref' = (SELECT provider_ref FROM payment_intents WHERE id = $1) AND type = 'payment.succeeded'`,
      [intentId],
    );
    expect(ev.rows[0]?.deliveries).toBe(4);
  });

  it("out-of-order webhooks (succeeded before processing) still end SUCCEEDED, credited once", async () => {
    h.provider.faults.reverseOrder = true;
    const { u, intentId } = await topUp("2000");
    await drainJobs(h);
    expect(await intentStatus(intentId)).toBe("SUCCEEDED");
    expect((await balance(h, u.wallet?.accountId as string)).posted).toBe(2000n);
    const late = await h.deps.db.query<{ status: string }>(
      `SELECT status FROM provider_events WHERE type = 'payment.processing' ORDER BY received_at DESC LIMIT 1`,
    );
    expect(late.rows[0]?.status).toBe("IGNORED");
  });

  it("declined payment → FAILED, no credit", async () => {
    const { u, intentId } = await topUp("3000", "pm_simulated_decline");
    await drainJobs(h);
    expect(await intentStatus(intentId)).toBe("FAILED");
    expect((await balance(h, u.wallet?.accountId as string)).posted).toBe(0n);
  });

  it("bad signature and stale timestamp → 400, nothing stored", async () => {
    const ev = {
      id: `evt_${randomUUID()}`,
      type: "payment.succeeded",
      created: 0,
      data: { provider_ref: "pi_x", amount_minor: "1" },
    };
    const bad = await deliverRaw(ev, `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}`);
    expect(bad.status).toBe(400);
    const stale = await deliverRaw(
      ev,
      signPayload(WEBHOOK_SECRET, JSON.stringify(ev), Math.floor(Date.now() / 1000) - 600),
    );
    expect(stale.status).toBe(400);
    const stored = await h.deps.db.query(
      `SELECT 1 FROM provider_events WHERE provider_event_id = $1`,
      [ev.id],
    );
    expect(stored.rowCount).toBe(0);
  });

  it("unknown payment reference → event FAILED and an anomaly alert (no money moves)", async () => {
    const r = await deliverRaw({
      id: `evt_${randomUUID()}`,
      type: "payment.succeeded",
      created: 0,
      data: { provider_ref: `pi_unknown_${randomUUID()}`, amount_minor: "5" },
    });
    expect(r.status).toBe(200);
    await drainJobs(h);
    const a = await h.deps.db.query(`SELECT 1 FROM risk_alerts WHERE kind = 'WEBHOOK_ANOMALY'`);
    expect(a.rowCount).toBeGreaterThan(0);
  });

  it("provider outage → 503 on create, nothing left half-done; key can be retried", async () => {
    const u = await createUser(h, { fund: 0n });
    const token = await login(h, u.email);
    h.provider.faults.outage = true;
    const key = randomUUID();
    const r = await api(h, token).post(
      "/payment-intents",
      { wallet_id: u.wallet?.walletId, amount_minor: "1000" },
      key,
    );
    expect(r.status).toBe(503);
    h.provider.faults.outage = false;
    expect(
      (
        await api(h, token).post(
          "/payment-intents",
          { wallet_id: u.wallet?.walletId, amount_minor: "1000" },
          key,
        )
      ).status,
    ).toBe(201);
  });
});

describe("refunds", () => {
  it("finance refunds part of a top-up: hold now, money moves when the provider confirms", async () => {
    const { u, intentId } = await topUp("10000");
    await drainJobs(h);
    const fin = await createUser(h, { roles: ["FINANCE"] });
    const ft = await login(h, fin.email);
    await reauth(h, ft);
    const r = await api(h, ft).post(
      "/refunds",
      { payment_intent_id: intentId, amount_minor: "4000", reason: "partial refund" },
      randomUUID(),
    );
    expect(r.status).toBe(202);
    expect(await balance(h, u.wallet?.accountId as string)).toEqual({
      posted: 10_000n,
      held: 4_000n,
    });
    await drainJobs(h);
    expect(await balance(h, u.wallet?.accountId as string)).toEqual({ posted: 6_000n, held: 0n });
    const over = await api(h, ft).post(
      "/refunds",
      { payment_intent_id: intentId, amount_minor: "6001", reason: "too much" },
      randomUUID(),
    );
    expect(over.body.error.code).toBe("LIMIT_EXCEEDED");
  });

  it("refund without step-up → 401; by a customer → 403", async () => {
    const { token, intentId } = await topUp("1000");
    expect(
      (
        await api(h, token).post(
          "/refunds",
          { payment_intent_id: intentId, amount_minor: "1", reason: "mine" },
          randomUUID(),
        )
      ).status,
    ).toBe(403);
    const fin = await createUser(h, { roles: ["FINANCE"] });
    const ft = await login(h, fin.email);
    expect(
      (
        await api(h, ft).post(
          "/refunds",
          { payment_intent_id: intentId, amount_minor: "1", reason: "x-reason" },
          randomUUID(),
        )
      ).body.error.code,
    ).toBe("REAUTH_REQUIRED");
  });
});

async function settledTopUps(n: number, amount: bigint) {
  const refs: Array<{ provider_ref: string; amount_minor: bigint }> = [];
  for (let i = 0; i < n; i++) {
    const t = await topUp(amount.toString());
    refs.push({ provider_ref: t.providerRef, amount_minor: amount });
  }
  await drainJobs(h);
  return refs;
}
const settlementOf = async (payout: string) =>
  (
    await h.deps.db.query<{ id: string; status: string }>(
      `SELECT id, status FROM settlements WHERE provider_payout_id = $1`,
      [payout],
    )
  ).rows[0];

describe("settlements and reconciliation", () => {
  it("matched payout: clearing moves to the bank, settlement MATCHED", async () => {
    const lines = await settledTopUps(2, 5000n);
    const payout = `po_${randomUUID()}`;
    h.provider.payout(payout, "INR", lines);
    await drainJobs(h);
    expect((await settlementOf(payout))?.status).toBe("MATCHED");
  });

  it("short payout: MISMATCHED, difference to suspense, alert raised", async () => {
    const lines = await settledTopUps(2, 5000n);
    const payout = `po_${randomUUID()}`;
    h.provider.payout(
      payout,
      "INR",
      [lines[0] as never, { ...(lines[1] as { provider_ref: string }), amount_minor: 4000n }],
      { paidMinor: 9000n },
    );
    await drainJobs(h);
    const s = await settlementOf(payout);
    expect(s?.status).toBe("MISMATCHED");
    const alert = await h.deps.db.query(
      `SELECT 1 FROM risk_alerts WHERE kind = 'SETTLEMENT_MISMATCH' AND settlement_id = $1`,
      [s?.id],
    );
    expect(alert.rowCount).toBe(1);
  });

  it("failed settlement: suspense + alert, then finance recovers it (RESOLVED)", async () => {
    const lines = await settledTopUps(1, 7000n);
    const payout = `po_${randomUUID()}`;
    h.provider.payout(payout, "INR", lines, { failed: true });
    await drainJobs(h);
    const s = await settlementOf(payout);
    expect(s?.status).toBe("FAILED");
    const fin = await createUser(h, { roles: ["FINANCE"] });
    const ft = await login(h, fin.email);
    await reauth(h, ft);
    const r = await api(h, ft).post(`/settlements/${s?.id}/resolve`, {
      recovered_minor: "7000",
      note: "provider re-sent the payout",
    });
    expect(r.status).toBe(200);
    expect((await settlementOf(payout))?.status).toBe("RESOLVED");
  });

  it("duplicate payout event (new event id, same payout) is ignored", async () => {
    const lines = await settledTopUps(1, 1000n);
    const payout = `po_${randomUUID()}`;
    h.provider.payout(payout, "INR", lines);
    h.provider.payout(payout, "INR", lines);
    await drainJobs(h);
    const n = await h.deps.db.query(
      `SELECT count(*)::int AS n FROM settlements WHERE provider_payout_id = $1`,
      [payout],
    );
    expect(n.rows[0].n).toBe(1);
  });
});

describe("jobs: retries, crash recovery and dead letters", () => {
  it("a failing notification is retried and then succeeds", async () => {
    await topUp("500");
    await h.provider.flush();
    h.notifier.failNext = 1;
    await drainJobs(h);
    await h.deps.db.query(`UPDATE outbox SET next_attempt_at = now() WHERE status = 'PENDING'`);
    await drainJobs(h);
    const pending = await h.deps.db.query(
      `SELECT count(*)::int AS n FROM outbox WHERE status = 'PENDING'`,
    );
    expect(pending.rows[0].n).toBe(0);
  });

  it("worker crash mid-job: lease expires, job re-runs, effect applied once", async () => {
    const { u, intentId } = await topUp("800");
    await h.provider.flush();
    // Simulate a crash: claim the jobs (lease set) but never finish them.
    await h.deps.db.query(
      `UPDATE outbox SET attempts = attempts + 1, next_attempt_at = now() + interval '60 seconds' WHERE status = 'PENDING'`,
    );
    expect((await runDueJobs(h.deps)).done).toBe(0); // leased: not visible to another worker
    await h.deps.db.query(`UPDATE outbox SET next_attempt_at = now() WHERE status = 'PENDING'`); // lease expires
    await drainJobs(h);
    expect(await topupJournals(intentId)).toBe(1);
    expect((await balance(h, u.wallet?.accountId as string)).posted).toBe(800n);
  });

  it("after 5 failures a job is dead-lettered; admin replays it once", async () => {
    const lines = await settledTopUps(1, 1500n);
    h.analytics.down = true; // reconciliation keeps failing
    const payout = `po_${randomUUID()}`;
    h.provider.payout(payout, "INR", lines);
    for (let i = 0; i < 6; i++) {
      await drainJobs(h, 3);
      await h.deps.db.query(`UPDATE outbox SET next_attempt_at = now() WHERE status = 'PENDING'`);
    }
    const dead = await h.deps.db.query<{ id: string }>(
      `SELECT f.id FROM failed_jobs f JOIN outbox o ON o.id = f.outbox_id WHERE o.topic = 'settlement.reconcile' AND f.replayed_at IS NULL`,
    );
    expect(dead.rowCount).toBeGreaterThan(0);
    h.analytics.down = false;
    const admin = await createUser(h, { roles: ["ADMIN"] });
    const at = await login(h, admin.email);
    await reauth(h, at);
    expect((await api(h, at).post(`/admin/failed-jobs/${dead.rows[0]?.id}/replay`)).status).toBe(
      200,
    );
    expect((await api(h, at).post(`/admin/failed-jobs/${dead.rows[0]?.id}/replay`)).status).toBe(
      409,
    );
    await drainJobs(h);
    expect((await settlementOf(payout))?.status).toBe("MATCHED");
  });
});
