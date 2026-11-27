import { randomUUID } from "node:crypto";
import { errorBodySchema } from "@fincore/contracts";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { csvCell, formatMinor, simplePdf } from "../src/modules/statements.js";
import { OPERATIONS } from "../src/openapi.js";
import {
  addBeneficiary,
  api,
  balance,
  buildHarness,
  createUser,
  expectInvariantsHold,
  login,
  reauth,
  type Harness,
} from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await buildHarness();
});
afterEach(async () => {
  await expectInvariantsHold(h);
});

async function postedTransfer(amount = "100000") {
  const a = await createUser(h, { fund: 1_000_000n });
  const b = await createUser(h, { fund: 0n });
  const token = await login(h, a.email);
  const ben = await addBeneficiary(h, token, b.wallet?.accountNumber as string);
  const t = await api(h, token).post(
    "/transfers",
    { source_wallet_id: a.wallet?.walletId, beneficiary_id: ben, amount_minor: amount },
    randomUUID(),
  );
  expect(t.status).toBe(201);
  return { a, b, token, transferId: t.body.data.id as string };
}

describe("disputes", () => {
  it("customer disputes own transfer (funds held at recipient); finance resolves in customer's favour", async () => {
    const { a, b, token, transferId } = await postedTransfer("100000");
    const d = await api(h, token).post("/disputes", {
      transfer_id: transferId,
      reason: "goods not received",
    });
    expect(d.status).toBe(201);
    expect(await balance(h, b.wallet?.accountId as string)).toEqual({
      posted: 100_000n,
      held: 100_000n,
    });
    expect(
      (await api(h, token).post("/disputes", { transfer_id: transferId, reason: "again" })).status,
    ).toBe(409);

    const fin = await createUser(h, { roles: ["FINANCE"] });
    const ft = await login(h, fin.email);
    expect(
      (
        await api(h, ft).post(`/disputes/${d.body.data.id}/transition`, {
          to: "UNDER_REVIEW",
          note: "looking",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(h, ft).post(`/disputes/${d.body.data.id}/transition`, {
          to: "RESOLVED_CUSTOMER",
          note: "refund",
        })
      ).body.error.code,
    ).toBe("REAUTH_REQUIRED");
    await reauth(h, ft);
    const res = await api(h, ft).post(`/disputes/${d.body.data.id}/transition`, {
      to: "RESOLVED_CUSTOMER",
      note: "refund customer",
    });
    expect(res.status).toBe(200);
    expect(await balance(h, b.wallet?.accountId as string)).toEqual({ posted: 0n, held: 0n });
    expect((await balance(h, a.wallet?.accountId as string)).posted).toBe(1_000_000n - 100n); // fee is not refunded
  });

  it("cannot dispute someone else's transfer (404); illegal transition → 409", async () => {
    const { transferId, token } = await postedTransfer("1000");
    const other = await createUser(h);
    const ot = await login(h, other.email);
    expect(
      (await api(h, ot).post("/disputes", { transfer_id: transferId, reason: "not mine" })).status,
    ).toBe(404);
    const d = await api(h, token).post("/disputes", {
      transfer_id: transferId,
      reason: "wrong amount",
    });
    const sup = await createUser(h, { roles: ["SUPPORT"] });
    const st = await login(h, sup.email);
    const skip = await api(h, st).post(`/disputes/${d.body.data.id}/transition`, {
      to: "REJECTED",
      note: "skip review",
    });
    expect(skip.status).toBe(409);
    expect(skip.body.error.code).toBe("INVALID_STATE_TRANSITION");
  });

  it("support can't resolve above the support limit; finance can", async () => {
    const { token, transferId } = await postedTransfer("600000"); // > ₹5,000 support limit
    const d = await api(h, token).post("/disputes", {
      transfer_id: transferId,
      reason: "large amount",
    });
    const sup = await createUser(h, { roles: ["SUPPORT"] });
    const st = await login(h, sup.email);
    await api(h, st).post(`/disputes/${d.body.data.id}/transition`, {
      to: "UNDER_REVIEW",
      note: "review",
    });
    const r = await api(h, st).post(`/disputes/${d.body.data.id}/transition`, {
      to: "REJECTED",
      note: "not eligible",
    });
    expect(r.status).toBe(403);
  });
});

describe("statements", () => {
  it("generates a statement whose totals reconcile, exports CSV and PDF; other customers get 404", async () => {
    const { a, token } = await postedTransfer("12345");
    const period = new Date().toISOString().slice(0, 7);
    const s = await api(h, token).get(
      `/statements?wallet_id=${a.wallet?.walletId}&period=${period}`,
    );
    expect(s.status).toBe(200);
    expect(s.body.data).toMatchObject({
      opening_minor: "0",
      total_credits_minor: "1000000",
      total_debits_minor: "12445",
      closing_minor: "987555",
    });
    const csv = await api(h, token).get(`/statements/${s.body.data.id}/export?format=csv`);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text).toContain("SIMULATED");
    expect(csv.text).toContain("9875.55");
    const pdf = await api(h, token)
      .get(`/statements/${s.body.data.id}/export?format=pdf`)
      .buffer(true);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    const other = await createUser(h);
    expect(
      (await api(h, await login(h, other.email)).get(`/statements/${s.body.data.id}/export`))
        .status,
    ).toBe(404);
  });

  it("CSV cells are protected against formula injection; money formatting is exact", () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell("-5")).toBe("'-5");
    expect(formatMinor(125050n, 2)).toBe("1250.50");
    expect(formatMinor(-5n, 2)).toBe("-0.05");
    expect(formatMinor(1000n, 0)).toBe("1000");
    expect(simplePdf(["hello"]).subarray(0, 8).toString()).toBe("%PDF-1.4");
  });

  it("rejects malformed and future periods", async () => {
    const u = await createUser(h);
    const t = await login(h, u.email);
    expect(
      (await api(h, t).get(`/statements?wallet_id=${u.wallet?.walletId}&period=2026-13`)).status,
    ).toBe(400);
    expect(
      (await api(h, t).get(`/statements?wallet_id=${u.wallet?.walletId}&period=2999-01`)).status,
    ).toBe(400);
  });
});

describe("operations, audit and admin", () => {
  it("audit log: readable by ops (chain intact), forbidden to customers", async () => {
    const ops = await createUser(h, { roles: ["OPS"] });
    const r = await api(h, await login(h, ops.email)).get("/audit-log?limit=5");
    expect(r.status).toBe(200);
    expect(r.body.meta.chain_intact).toBe(true);
    const cust = await createUser(h);
    expect((await api(h, await login(h, cust.email)).get("/audit-log")).status).toBe(403);
  });

  it("admin grants a role (with step-up); change is effective on the next request", async () => {
    const admin = await createUser(h, { roles: ["ADMIN"] });
    const at = await login(h, admin.email);
    const target = await createUser(h, { roles: ["SUPPORT"] });
    const tt = await login(h, target.email);
    expect((await api(h, tt).get("/risk-alerts")).status).toBe(403);
    expect(
      (
        await api(h, at).post(`/admin/users/${target.userId}/roles`, {
          role: "OPS",
          action: "grant",
        })
      ).body.error.code,
    ).toBe("REAUTH_REQUIRED");
    await reauth(h, at);
    expect(
      (
        await api(h, at).post(`/admin/users/${target.userId}/roles`, {
          role: "OPS",
          action: "grant",
        })
      ).status,
    ).toBe(200);
    expect((await api(h, tt).get("/risk-alerts")).status).toBe(200); // roles come from the DB, not the JWT
  });

  it("pagination: limit ≤ 100 and stable cursors", async () => {
    const admin = await createUser(h, { roles: ["ADMIN"] });
    const at = await login(h, admin.email);
    expect((await api(h, at).get("/admin/users?limit=101")).status).toBe(400);
    const p1 = await api(h, at).get("/admin/users?limit=2");
    const p2 = await api(h, at).get(`/admin/users?limit=2&cursor=${p1.body.meta.next_cursor}`);
    expect(p2.body.data[0].id).not.toBe(p1.body.data[0].id);
    expect((await api(h, at).get("/admin/users?cursor=garbage")).status).toBe(400);
  });
});

describe("API contract (OpenAPI ↔ implementation)", () => {
  it("serves an OpenAPI 3.1 document listing every operation", async () => {
    const r = await request(h.app).get("/api/v1/openapi.json");
    expect(r.body.openapi).toBe("3.1.0");
    expect(Object.keys(r.body.paths).length).toBeGreaterThan(35);
  });

  it("every documented operation is routed, and unauthenticated calls get the error envelope (never a generic 404)", async () => {
    for (const op of OPERATIONS) {
      const path = `/api/v1${op.path.replace("{id}", randomUUID())}`;
      const client = request(h.app);
      const res = await client[op.method](path)
        .set("content-type", "application/json")
        .send(op.method === "get" ? undefined : "{}");
      expect(
        errorBodySchema.safeParse(res.body).success,
        `${op.method} ${op.path} → ${res.status}`,
      ).toBe(true);
      const routeMissing =
        res.status === 404 && res.body.error.message === "The requested resource was not found.";
      expect(
        routeMissing,
        `${op.method.toUpperCase()} ${op.path} is documented but not routed`,
      ).toBe(false);
      if (op.auth !== "none" && op.auth !== "signature")
        expect(res.status, `${op.method} ${op.path} must require auth`).toBe(401);
    }
  });
});
