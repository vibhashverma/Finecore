import { randomInt, randomUUID } from "node:crypto";
import {
  createPool,
  DEMO_TOTP_SECRET,
  encryptSecret,
  LOCAL_DEV_MFA_KEY,
  parseEncryptionKey,
  withClientTransaction,
} from "@fincore/db";
import { openWallet } from "@fincore/db/seed";
import { hash } from "@node-rs/argon2";
import type { Express } from "express";
import { pino } from "pino";
import request from "supertest";
import { expect, inject } from "vitest";
import { createApp } from "../src/app.js";
import { totp } from "../src/auth/totp.js";
import { loadKeys } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config.js";
import type { Deps } from "../src/deps.js";
import type {
  AnalyticsClient,
  FeeSchedule,
  ReconLine,
  ReconResult,
  RiskScore,
  TransferFeatures,
} from "../src/integrations/analytics.js";
import { RecordingNotifier } from "../src/integrations/notifier.js";
import { SimulatedProvider } from "../src/integrations/provider.js";
import { runDueJobs } from "../src/jobs/runner.js";
import { MemoryRateLimiter } from "../src/lib/rate-limit.js";

export const PASSWORD = "FinCore-Demo-2026!";
export const WEBHOOK_SECRET = "test-webhook-secret-0123456789";

/**
 * TEST DOUBLE for the analytics service (the real FastAPI service is covered by pytest and the E2E/contract runs).
 * Same fee rule: clamp(flat + amount·bps/10000 rounded half-even, min, max).
 */
export class FakeAnalytics implements AnalyticsClient {
  down = false;
  score = 10;
  calls = 0;

  private guard() {
    this.calls++;
    if (this.down) throw new Error("analytics unavailable (simulated)");
  }

  async calculateFee(amount: bigint, _c: string, s: FeeSchedule) {
    this.guard();
    const num = amount * BigInt(s.rate_bps);
    let q = num / 10000n;
    const r = num % 10000n;
    if (r * 2n > 10000n || (r * 2n === 10000n && q % 2n === 1n)) q += 1n;
    let fee = s.flat_minor + q;
    if (fee < s.min_minor) fee = s.min_minor;
    if (s.max_minor !== null && fee > s.max_minor) fee = s.max_minor;
    return fee;
  }

  async scoreTransfer(_f: TransferFeatures): Promise<RiskScore> {
    this.guard();
    return {
      score: this.score,
      reasons: [{ code: "TEST", detail: "fake score", weight: this.score }],
      disclaimer: "test",
    };
  }

  async compareReconciliation(internal: ReconLine[], provider: ReconLine[]): Promise<ReconResult> {
    this.guard();
    const inMap = new Map(internal.map((l) => [l.provider_ref, BigInt(l.amount_minor)]));
    const prMap = new Map(provider.map((l) => [l.provider_ref, BigInt(l.amount_minor)]));
    const refs = [...new Set([...inMap.keys(), ...prMap.keys()])].sort();
    const items = refs.map((ref) => {
      const e = inMap.get(ref) ?? 0n;
      const a = prMap.get(ref) ?? 0n;
      const outcome = !inMap.has(ref)
        ? "MISSING_INTERNAL"
        : !prMap.has(ref)
          ? "MISSING_PROVIDER"
          : e === a
            ? "MATCHED"
            : "AMOUNT_MISMATCH";
      return {
        provider_ref: ref,
        outcome: outcome as ReconResult["items"][number]["outcome"],
        expected_minor: e,
        actual_minor: a,
        diff_minor: e - a,
      };
    });
    const et = items.reduce((s, i) => s + i.expected_minor, 0n);
    const at = items.reduce((s, i) => s + i.actual_minor, 0n);
    return { items, expected_total_minor: et, actual_total_minor: at, diff_minor: et - at };
  }

  async summarizeStatement(
    opening: bigint,
    lines: Array<{ direction: "DEBIT" | "CREDIT"; amount_minor: bigint }>,
  ) {
    this.guard();
    const cr = lines
      .filter((l) => l.direction === "CREDIT")
      .reduce((s, l) => s + BigInt(l.amount_minor), 0n);
    const dr = lines
      .filter((l) => l.direction === "DEBIT")
      .reduce((s, l) => s + BigInt(l.amount_minor), 0n);
    return { total_credits_minor: cr, total_debits_minor: dr, closing_minor: opening + cr - dr };
  }
}

export interface Harness {
  app: Express;
  deps: Deps;
  analytics: FakeAnalytics;
  provider: SimulatedProvider;
  notifier: RecordingNotifier;
}

export async function buildHarness(env: Record<string, string> = {}): Promise<Harness> {
  const config = loadConfig({
    DATABASE_URL: inject("appUrl"),
    APP_ENV: "test",
    LOG_LEVEL: "silent",
    WEBHOOK_SECRET,
    ...env,
  });
  const analytics = new FakeAnalytics();
  const notifier = new RecordingNotifier();
  // eslint-disable-next-line prefer-const
  let app: Express;
  const provider = new SimulatedProvider(
    WEBHOOK_SECRET,
    async (raw, sig) => {
      const r = await request(app)
        .post("/api/v1/webhooks/payments")
        .set("content-type", "application/json")
        .set("fincore-signature", sig)
        .send(raw);
      if (r.status >= 300) throw new Error(`webhook rejected ${r.status}`);
    },
    null, // manual flush in tests
  );
  const db = createPool(config.DATABASE_URL, { max: 60 });
  const deps: Deps = {
    config,
    logger: pino({ level: process.env.TEST_LOG ?? "silent" }),
    db,
    keys: await loadKeys(config),
    mfaKey: parseEncryptionKey(LOCAL_DEV_MFA_KEY),
    limiter: new MemoryRateLimiter(),
    analytics,
    provider,
    notifier,
    readinessChecks: { postgres: async () => void (await db.query("SELECT 1")) },
    isShuttingDown: () => false,
  };
  app = createApp(deps);
  return { app, deps, analytics, provider, notifier };
}

let passwordHash: Promise<string> | undefined;

/** A fresh synthetic user with the demo TOTP secret; optional roles and a funded INR wallet. */
export async function createUser(
  h: Harness,
  opts: { roles?: string[]; fund?: bigint | null; currency?: string } = {},
) {
  passwordHash ??= hash(PASSWORD, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  const email = `t-${randomUUID()}@fincore.test`;
  const roles = opts.roles ?? ["CUSTOMER"];
  return withClientTransaction(h.deps.db, async (c) => {
    const u = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, mfa_secret_enc) VALUES ($1, $2, $3) RETURNING id`,
      [email, await passwordHash, encryptSecret(DEMO_TOTP_SECRET, h.deps.mfaKey)],
    );
    const userId = u.rows[0]?.id as string;
    for (const r of roles)
      await c.query(`INSERT INTO user_roles (user_id, role_code) VALUES ($1, $2)`, [userId, r]);
    let customerId: string | null = null;
    let wallet: { walletId: string; accountId: string; accountNumber: string } | null = null;
    if (roles.includes("CUSTOMER")) {
      customerId = (
        await c.query<{ id: string }>(
          `INSERT INTO customers (user_id, full_name) VALUES ($1, 'Test Customer (synthetic)') RETURNING id`,
          [userId],
        )
      ).rows[0]?.id as string;
      if (opts.fund !== null) {
        const accountNumber = `FC${randomInt(1_000_000_000, 9_999_999_999)}`;
        const w = await openWallet(
          c,
          customerId,
          opts.currency ?? "INR",
          accountNumber,
          opts.fund ?? 1_000_000n,
        );
        wallet = { walletId: w.walletId, accountId: w.accountId, accountNumber };
      }
    }
    return { email, userId, customerId, wallet };
  });
}

export type TestUser = Awaited<ReturnType<typeof createUser>>;

/** Full login (password → TOTP) returning a bearer token. */
export async function login(h: Harness, email: string): Promise<string> {
  const l = await request(h.app).post("/api/v1/auth/login").send({ email, password: PASSWORD });
  expect(l.status, JSON.stringify(l.body)).toBe(200);
  const v = await request(h.app)
    .post("/api/v1/auth/mfa/verify")
    .set("x-token-delivery", "body")
    .send({ challenge_id: l.body.data.challenge_id, code: totp(DEMO_TOTP_SECRET) });
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  return v.body.data.access_token as string;
}

export async function reauth(h: Harness, token: string) {
  const r = await request(h.app)
    .post("/api/v1/auth/reauth")
    .set("authorization", `Bearer ${token}`)
    .send({ password: PASSWORD, code: totp(DEMO_TOTP_SECRET) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

export async function addBeneficiary(
  h: Harness,
  token: string,
  accountNumber: string,
): Promise<string> {
  await reauth(h, token);
  const r = await request(h.app)
    .post("/api/v1/beneficiaries")
    .set("authorization", `Bearer ${token}`)
    .send({ account_number: accountNumber, nickname: "Payee" });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id as string;
}

export const api = (h: Harness, token: string) => ({
  get: (path: string) =>
    request(h.app).get(`/api/v1${path}`).set("authorization", `Bearer ${token}`),
  post: (path: string, body: unknown = {}, key?: string) => {
    const r = request(h.app).post(`/api/v1${path}`).set("authorization", `Bearer ${token}`);
    return (key ? r.set("idempotency-key", key) : r).send(body as object);
  },
});

/** Runs the job worker until the queue is drained (or a round makes no progress). */
export async function drainJobs(h: Harness, rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    await h.provider.flush();
    const r = await runDueJobs(h.deps, 50);
    if (r.done + r.retried + r.dead === 0 && h.provider.pending.length === 0) return;
  }
}

export async function balance(h: Harness, accountId: string) {
  const r = await h.deps.db.query<{ posted_minor: bigint; held_minor: bigint }>(
    `SELECT posted_minor, held_minor FROM account_balances WHERE account_id = $1`,
    [accountId],
  );
  return { posted: r.rows[0]?.posted_minor, held: r.rows[0]?.held_minor };
}

export async function expectInvariantsHold(h: Harness) {
  const v = await h.deps.db.query(`SELECT * FROM ledger_invariant_violations()`);
  expect(v.rows).toEqual([]);
}
