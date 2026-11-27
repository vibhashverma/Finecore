import { DEMO_TOTP_SECRET } from "@fincore/db";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { can, PERMISSIONS } from "../src/auth/permissions.js";
import { base32Encode, hotp, totp, verifyTotp } from "../src/auth/totp.js";
import { api, buildHarness, createUser, login, PASSWORD, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await buildHarness();
});

const auditCount = async (action: string, outcome: string) =>
  Number(
    (
      await h.deps.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND outcome = $2`,
        [action, outcome],
      )
    ).rows[0]?.n,
  );

describe("TOTP (RFC 6238)", () => {
  it("matches the RFC 6238 SHA-1 test vectors", () => {
    const secret = Buffer.from("12345678901234567890");
    expect(hotp(secret, Math.floor(59 / 30), 8)).toBe("94287082");
    expect(hotp(secret, Math.floor(1111111109 / 30), 8)).toBe("07081804");
    expect(hotp(secret, Math.floor(2000000000 / 30), 8)).toBe("69279037");
  });

  it("accepts ±1 step and rejects other codes", () => {
    const s = base32Encode(Buffer.from("12345678901234567890"));
    const t = 1_700_000_000_000;
    expect(verifyTotp(s, totp(s, t - 30_000), t)).toBe(true);
    expect(verifyTotp(s, totp(s, t - 90_000), t)).toBe(false);
    expect(verifyTotp(s, "12345", t)).toBe(false);
  });
});

describe("registration and login", () => {
  it("register → login → MFA → session, and the password is stored only as Argon2id", async () => {
    const email = `reg-${Date.now()}@fincore.test`;
    const reg = await request(h.app)
      .post("/api/v1/auth/register")
      .send({ email, password: "a-long-password-123", full_name: "Reg Test (synthetic)" });
    expect(reg.status).toBe(201);
    expect(reg.body.data.mfa.simulated).toBe(true);
    const stored = await h.deps.db.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE email = $1`,
      [email],
    );
    expect(stored.rows[0]?.password_hash).toMatch(/^\$argon2id\$/);

    const l = await request(h.app)
      .post("/api/v1/auth/login")
      .send({ email, password: "a-long-password-123" });
    const v = await request(h.app)
      .post("/api/v1/auth/mfa/verify")
      .set("x-token-delivery", "body")
      .send({ challenge_id: l.body.data.challenge_id, code: totp(reg.body.data.mfa.secret) });
    expect(v.status).toBe(200);
    const s = await api(h, v.body.data.access_token).get("/auth/session");
    expect(s.body.data.roles).toEqual(["CUSTOMER"]);
  });

  it("rejects weak passwords and duplicate emails", async () => {
    const weak = await request(h.app)
      .post("/api/v1/auth/register")
      .send({ email: `w-${Date.now()}@fincore.test`, password: "short", full_name: "x" });
    expect(weak.body.error.code).toBe("VALIDATION_ERROR");
    const dup = await request(h.app)
      .post("/api/v1/auth/register")
      .send({ email: "alice@fincore.test", password: "a-long-password-123", full_name: "x" });
    expect(dup.status).toBe(409);
  });

  it("gives the same generic error for unknown email and wrong password (no enumeration)", async () => {
    const a = await request(h.app)
      .post("/api/v1/auth/login")
      .send({ email: "nobody@fincore.test", password: "whatever-123" });
    const b = await request(h.app)
      .post("/api/v1/auth/login")
      .send({ email: "bob@fincore.test", password: "wrong-password-1" });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it("locks the account after 5 failed passwords (even the right password is refused while locked)", async () => {
    const u = await createUser(h, { fund: null });
    for (let i = 0; i < 5; i++)
      await request(h.app)
        .post("/api/v1/auth/login")
        .send({ email: u.email, password: "wrong-password-x" });
    const r = await request(h.app)
      .post("/api/v1/auth/login")
      .send({ email: u.email, password: PASSWORD });
    expect(r.status).toBe(401);
    expect(await auditCount("auth.login", "DENIED")).toBeGreaterThan(5);
  });

  it("rejects a wrong MFA code and burns the challenge after 5 attempts", async () => {
    const u = await createUser(h, { fund: null });
    const l = await request(h.app)
      .post("/api/v1/auth/login")
      .send({ email: u.email, password: PASSWORD });
    for (let i = 0; i < 5; i++) {
      const v = await request(h.app)
        .post("/api/v1/auth/mfa/verify")
        .send({ challenge_id: l.body.data.challenge_id, code: "000000" });
      expect(v.status).toBe(401);
    }
    const right = await request(h.app)
      .post("/api/v1/auth/mfa/verify")
      .send({ challenge_id: l.body.data.challenge_id, code: totp(DEMO_TOTP_SECRET) });
    expect(right.status).toBe(401);
  });

  it("rate-limits login attempts per email (429 RATE_LIMITED with Retry-After)", async () => {
    const email = `rl-${Date.now()}@fincore.test`;
    let last;
    for (let i = 0; i < 11; i++)
      last = await request(h.app).post("/api/v1/auth/login").send({ email, password: "x" });
    expect(last?.status).toBe(429);
    expect(last?.body.error.code).toBe("RATE_LIMITED");
    expect(last?.headers["retry-after"]).toBeDefined();
  });
});

describe("tokens, refresh rotation and revocation", () => {
  async function loginWithRefresh(email: string) {
    const l = await request(h.app).post("/api/v1/auth/login").send({ email, password: PASSWORD });
    const v = await request(h.app)
      .post("/api/v1/auth/mfa/verify")
      .set("x-token-delivery", "body")
      .send({ challenge_id: l.body.data.challenge_id, code: totp(DEMO_TOTP_SECRET) });
    return v.body.data as { access_token: string; refresh_token: string };
  }
  const refresh = (rt: string) =>
    request(h.app)
      .post("/api/v1/auth/refresh")
      .set("x-token-delivery", "body")
      .send({ refresh_token: rt });

  it("rotates refresh tokens; reusing an old one revokes the whole session (theft detection)", async () => {
    const u = await createUser(h, { fund: null });
    const t1 = await loginWithRefresh(u.email);
    const r1 = await refresh(t1.refresh_token);
    expect(r1.status).toBe(200);
    expect(r1.body.data.refresh_token).not.toBe(t1.refresh_token);

    const reuse = await refresh(t1.refresh_token);
    expect(reuse.status).toBe(401);
    // the legitimate new token and the access token are now dead too
    expect((await refresh(r1.body.data.refresh_token)).status).toBe(401);
    expect((await api(h, r1.body.data.access_token).get("/auth/session")).status).toBe(401);
    expect(await auditCount("auth.refresh_reuse", "DENIED")).toBeGreaterThan(0);
  });

  it("logout revokes immediately (the still-unexpired JWT stops working)", async () => {
    const u = await createUser(h, { fund: null });
    const token = await login(h, u.email);
    expect((await api(h, token).post("/auth/logout")).status).toBe(200);
    expect((await api(h, token).get("/auth/session")).status).toBe(401);
  });

  it("rejects missing, malformed and tampered tokens", async () => {
    const u = await createUser(h, { fund: null });
    const token = await login(h, u.email);
    expect((await request(h.app).get("/api/v1/me")).status).toBe(401);
    expect((await api(h, "not.a.jwt").get("/me")).status).toBe(401);
    const [hd, pl, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(pl as string, "base64url").toString()),
        sub: "00000000-0000-0000-0000-000000000000",
      }),
    ).toString("base64url");
    expect((await api(h, `${hd}.${forged}.${sig}`).get("/me")).status).toBe(401);
  });

  it("cookie sessions require the double-submit CSRF token on unsafe requests", async () => {
    const u = await createUser(h, { fund: null });
    const agent = request.agent(h.app);
    const l = await agent.post("/api/v1/auth/login").send({ email: u.email, password: PASSWORD });
    const v = await agent
      .post("/api/v1/auth/mfa/verify")
      .send({ challenge_id: l.body.data.challenge_id, code: totp(DEMO_TOTP_SECRET) });
    const cookies = (v.headers["set-cookie"] as unknown as string[]).join(";");
    expect(cookies).toMatch(/fc_at=.*HttpOnly/i);
    expect(cookies).toMatch(/SameSite=Strict/i);
    expect(v.body.data.access_token).toBeUndefined(); // browsers never see tokens
    expect((await agent.get("/api/v1/me")).status).toBe(200); // safe method: no CSRF needed
    const noCsrf = await agent.patch("/api/v1/me").send({ full_name: "x" });
    expect(noCsrf.status).toBe(403);
    const csrf = /fc_csrf=([^;]+)/.exec(cookies)?.[1] ?? "";
    expect(
      (
        await agent
          .patch("/api/v1/me")
          .set("x-csrf-token", csrf)
          .send({ full_name: "Renamed (synthetic)" })
      ).status,
    ).toBe(200);
  });
});

describe("authorization", () => {
  it("the permission matrix matches the brief", () => {
    expect(can(["CUSTOMER"], "transfers:create")).toBe(true);
    expect(can(["SUPPORT"], "transfers:create")).toBe(false);
    expect(can(["FINANCE"], "reversals:create")).toBe(true);
    expect(can(["OPS"], "reversals:create")).toBe(false);
    expect(can(["OPS"], "risk:action")).toBe(true);
    expect(can(["FINANCE"], "risk:action")).toBe(false);
    expect(can(["ADMIN"], "admin:manage")).toBe(true);
    expect(PERMISSIONS["audit:read"]).toEqual(["OPS", "FINANCE", "ADMIN"]);
  });

  it("denies and audits a customer calling a finance endpoint", async () => {
    const u = await createUser(h);
    const token = await login(h, u.email);
    const before = await auditCount("permission.reversals_create", "DENIED");
    const r = await api(h, token).post(
      `/transfers/${crypto.randomUUID()}/reverse`,
      { reason: "nope" },
      crypto.randomUUID(),
    );
    expect(r.status).toBe(403);
    expect(await auditCount("permission.reversals_create", "DENIED")).toBe(before + 1);
  });

  it("IDOR: customer B cannot read customer A's wallet (404, existence not leaked)", async () => {
    const a = await createUser(h);
    const b = await createUser(h);
    const tokenB = await login(h, b.email);
    expect((await api(h, tokenB).get(`/wallets/${a.wallet?.walletId}`)).status).toBe(404);
    expect((await api(h, tokenB).get(`/wallets/${a.wallet?.walletId}/transactions`)).status).toBe(
      404,
    );
  });

  it("staff read customers with masked PII", async () => {
    const s = await createUser(h, { roles: ["SUPPORT"] });
    const token = await login(h, s.email);
    const r = await api(h, token).get("/customers?q=alice");
    expect(r.status).toBe(200);
    expect(r.body.data[0].email).toBe("a•••@fincore.test");
  });

  it("adding a beneficiary requires step-up reauthentication", async () => {
    const u = await createUser(h);
    const token = await login(h, u.email);
    const r = await api(h, token).post("/beneficiaries", {
      account_number: "FC1000000003",
      nickname: "Bob",
    });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("REAUTH_REQUIRED");
  });
});
