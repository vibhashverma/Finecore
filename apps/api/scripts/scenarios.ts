/**
 * Capstone and incident scenarios against a REAL stack: embedded PostgreSQL 16 (migrated + seeded), the real
 * FastAPI analytics service, and the real API app with the SIMULATED payment provider.
 *
 *   pnpm --filter @fincore/api scenario capstone     # brief §10
 *   pnpm --filter @fincore/api scenario incidents    # Assessment 15 reproductions
 *
 * Exit code is non-zero if any proof fails.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createPool, DEMO_TOTP_SECRET, LOCAL_DEV_MFA_KEY, parseEncryptionKey } from "@fincore/db";
import { seed } from "@fincore/db/seed";
import { startFincoreDatabase } from "@fincore/db/testing";
import type { Express } from "express";
import { pino } from "pino";
import request from "supertest";
import { createApp } from "../src/app.js";
import { totp } from "../src/auth/totp.js";
import { loadKeys } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config.js";
import type { Deps } from "../src/deps.js";
import { HttpAnalyticsClient } from "../src/integrations/analytics.js";
import { RecordingNotifier } from "../src/integrations/notifier.js";
import { SimulatedProvider } from "../src/integrations/provider.js";
import { runDueJobs } from "../src/jobs/runner.js";
import { MemoryRateLimiter } from "../src/lib/rate-limit.js";

const PASSWORD = "FinCore-Demo-2026!";
const SECRET = "scenario-webhook-secret-0123456789";
const ANALYTICS_PORT = 8890;
const root = resolve(import.meta.dirname, "../../..");
let failures = 0;
const j = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));
const log = (s = "") => process.stdout.write(`${s}\n`);
const check = (ok: boolean, label: string) => {
  log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

async function boot() {
  const db = await startFincoreDatabase();
  await seed(db.appUrl, PASSWORD);
  const venv = join(root, "services/analytics/.venv");
  const py = existsSync(join(venv, "Scripts/python.exe"))
    ? join(venv, "Scripts/python.exe")
    : join(venv, "bin/python");
  const analyticsProc = spawn(
    py,
    [
      "-m",
      "uvicorn",
      "fincore_analytics.main:app",
      "--port",
      String(ANALYTICS_PORT),
      "--log-level",
      "warning",
    ],
    {
      cwd: root,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  for (let i = 0; i < 60; i++) {
    const ok = await fetch(`http://127.0.0.1:${ANALYTICS_PORT}/readyz`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const config = loadConfig({
    DATABASE_URL: db.appUrl,
    APP_ENV: "test",
    LOG_LEVEL: "silent",
    WEBHOOK_SECRET: SECRET,
    ANALYTICS_URL: `http://127.0.0.1:${ANALYTICS_PORT}`,
  });
  // eslint-disable-next-line prefer-const
  let app: Express;
  const provider = new SimulatedProvider(
    SECRET,
    async (raw, sig) => {
      const r = await request(app)
        .post("/api/v1/webhooks/payments")
        .set("content-type", "application/json")
        .set("fincore-signature", sig)
        .send(raw);
      if (r.status >= 300) throw new Error(`webhook ${r.status}`);
    },
    null,
  );
  const pool = createPool(db.appUrl, { max: 60 });
  const deps: Deps = {
    config,
    logger: pino({ level: "silent" }),
    db: pool,
    keys: await loadKeys(config),
    mfaKey: parseEncryptionKey(LOCAL_DEV_MFA_KEY),
    limiter: new MemoryRateLimiter(),
    analytics: new HttpAnalyticsClient(config.ANALYTICS_URL, config.ANALYTICS_TOKEN),
    provider,
    notifier: new RecordingNotifier(),
    readinessChecks: {},
    isShuttingDown: () => false,
  };
  app = createApp(deps);
  const drain = async () => {
    for (let i = 0; i < 30; i++) {
      await provider.flush();
      const r = await runDueJobs(deps, 100);
      if (r.done + r.retried + r.dead === 0 && provider.pending.length === 0) return;
    }
  };
  const stop = async () => {
    analyticsProc.kill();
    await pool.end();
    await db.stop();
  };
  return { app, deps, provider, drain, stop, analyticsProc };
}

type Ctx = Awaited<ReturnType<typeof boot>>;

async function login(c: Ctx, email: string) {
  const l = await request(c.app).post("/api/v1/auth/login").send({ email, password: PASSWORD });
  const v = await request(c.app)
    .post("/api/v1/auth/mfa/verify")
    .set("x-token-delivery", "body")
    .send({ challenge_id: l.body.data.challenge_id, code: totp(DEMO_TOTP_SECRET) });
  const token = v.body.data.access_token as string;
  return {
    token,
    get: (p: string) => request(c.app).get(`/api/v1${p}`).set("authorization", `Bearer ${token}`),
    post: (p: string, body: object = {}, key?: string) => {
      const r = request(c.app).post(`/api/v1${p}`).set("authorization", `Bearer ${token}`);
      return (key ? r.set("idempotency-key", key) : r).send(body);
    },
    reauth: () =>
      request(c.app)
        .post("/api/v1/auth/reauth")
        .set("authorization", `Bearer ${token}`)
        .send({ password: PASSWORD, code: totp(DEMO_TOTP_SECRET) }),
  };
}

const q = async <T = Record<string, unknown>>(c: Ctx, sql: string, params: unknown[] = []) =>
  (await c.deps.db.query(sql, params)).rows as T[];

async function walletOf(c: Ctx, email: string) {
  return (
    await q<{ id: string; account_id: string; account_number: string }>(
      c,
      `SELECT w.id, w.account_id, w.account_number FROM wallets w JOIN customers cu ON cu.id = w.customer_id JOIN users u ON u.id = cu.user_id WHERE u.email = $1 AND w.currency = 'INR'`,
      [email],
    )
  )[0]!;
}
const balance = async (c: Ctx, accountId: string) =>
  (
    await q<{ posted_minor: bigint; held_minor: bigint }>(
      c,
      `SELECT posted_minor, held_minor FROM account_balances WHERE account_id = $1`,
      [accountId],
    )
  )[0]!;

async function proofs(c: Ctx) {
  log("\n== PROOF: ledger invariants ==");
  const totals = await q(
    c,
    `SELECT currency, sum(amount_minor) FILTER (WHERE direction='DEBIT') AS debits, sum(amount_minor) FILTER (WHERE direction='CREDIT') AS credits, count(DISTINCT transaction_id) AS journals FROM ledger_entries GROUP BY currency ORDER BY 1`,
  );
  for (const t of totals)
    log(`  ${t.currency}: debits=${t.debits} credits=${t.credits} journals=${t.journals}`);
  const v = await q(c, `SELECT * FROM ledger_invariant_violations()`);
  check(
    v.length === 0,
    `ledger_invariant_violations() returned ${v.length} rows (balanced journals, global balance, cached balances, holds, reversals, audit chain)`,
  );
  check(
    totals.every((t) => t.debits === t.credits),
    "Σ debits = Σ credits in every currency",
  );

  log("\n== PROOF: no account debited or credited twice for the same business event ==");
  const dupTransfers = await q(
    c,
    `SELECT reference_id, count(*) n FROM transactions WHERE kind = 'TRANSFER' GROUP BY reference_id HAVING count(*) > 1`,
  );
  check(
    dupTransfers.length === 0,
    `each transfer has at most one TRANSFER journal (duplicates: ${dupTransfers.length})`,
  );
  const dupTopups = await q(
    c,
    `SELECT reference_id, count(*) n FROM transactions WHERE kind = 'TOPUP' GROUP BY reference_id HAVING count(*) > 1`,
  );
  check(
    dupTopups.length === 0,
    `each payment intent credited at most once (duplicates: ${dupTopups.length})`,
  );
  const dupRev = await q(
    c,
    `SELECT reverses_transaction_id, count(*) n FROM transactions WHERE reverses_transaction_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1`,
  );
  check(dupRev.length === 0, "each journal reversed at most once");
  const negative = await q(
    c,
    `SELECT account_id FROM account_balances WHERE posted_minor - held_minor < floor_minor`,
  );
  check(negative.length === 0, "no wallet below zero available balance");
}

async function capstone(c: Ctx) {
  const alice = await login(c, "alice@fincore.test");
  const finance = await login(c, "finance@fincore.test");
  const aliceW = await walletOf(c, "alice@fincore.test");
  const bobW = await walletOf(c, "bob@fincore.test");
  await alice.reauth();
  const ben = (
    await alice.post("/beneficiaries", { account_number: bobW.account_number, nickname: "Bob" })
  ).body.data.id as string;

  log("== 1. Concurrent transfers on the same wallet ==");
  const start = await balance(c, aliceW.account_id);
  const retriedKey = randomUUID();
  const sends = [
    ...Array.from({ length: 40 }, () =>
      alice.post(
        "/transfers",
        { source_wallet_id: aliceW.id, beneficiary_id: ben, amount_minor: "150000" },
        randomUUID(),
      ),
    ),
    ...Array.from({ length: 10 }, () =>
      alice.post(
        "/transfers",
        { source_wallet_id: aliceW.id, beneficiary_id: ben, amount_minor: "150000" },
        retriedKey,
      ),
    ), // client retries
  ];
  const results = await Promise.all(sends);
  const byStatus = results.reduce<Record<number, number>>(
    (m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }),
    {},
  );
  log(`  start balance ${start.posted_minor} minor; responses by HTTP status: ${j(byStatus)}`);
  const end = await balance(c, aliceW.account_id);
  const posted = (
    await q<{ n: number }>(
      c,
      `SELECT count(*)::int n FROM transfers WHERE source_wallet_id = $1 AND status = 'POSTED'`,
      [aliceW.id],
    )
  )[0]!.n;
  log(
    `  end balance ${end.posted_minor} minor; POSTED transfers ${posted} (each 150000 + fee 150)`,
  );
  check(end.posted_minor >= 0n, "no overdraft");
  check(
    start.posted_minor - end.posted_minor === BigInt(posted) * 150_150n,
    "debited exactly posted × (amount + fee)",
  );
  const retriedCount = new Set(
    results
      .slice(40)
      .filter((r) => r.status === 201)
      .map((r) => r.body.data.id),
  ).size;
  check(retriedCount <= 1, `10 retries with one Idempotency-Key produced ${retriedCount} transfer`);

  log("\n== 2. Duplicate payment webhooks ==");
  const chandra = await login(c, "chandra@fincore.test");
  const chW = await walletOf(c, "chandra@fincore.test");
  const before = await balance(c, chW.account_id);
  c.provider.faults.duplicateDeliveries = 4;
  const pi = await chandra.post(
    "/payment-intents",
    { wallet_id: chW.id, amount_minor: "100000" },
    randomUUID(),
  );
  await chandra.post(
    `/payment-intents/${pi.body.data.id}/confirm`,
    { payment_method: "pm_simulated_success" },
    randomUUID(),
  );
  await c.drain();
  c.provider.faults.duplicateDeliveries = 0;
  const deliveries = await q(
    c,
    `SELECT type, deliveries, status FROM provider_events WHERE payload->'data'->>'provider_ref' = $1 ORDER BY received_at`,
    [pi.body.data.provider_ref],
  );
  for (const d of deliveries) log(`  event ${d.type}: delivered ${d.deliveries}× → ${d.status}`);
  const after = await balance(c, chW.account_id);
  check(
    after.posted_minor - before.posted_minor === 100_000n,
    "wallet credited exactly once (₹1,000.00) despite 5 deliveries per event",
  );

  log("\n== 3. Failed settlement ==");
  c.provider.payout(
    `po_capstone_${Date.now()}`,
    "INR",
    [{ provider_ref: pi.body.data.provider_ref as string, amount_minor: 100_000n }],
    { failed: true },
  );
  await c.drain();
  const st = (
    await q(
      c,
      `SELECT id, status, expected_minor FROM settlements ORDER BY created_at DESC LIMIT 1`,
    )
  )[0]!;
  const suspense = (
    await q(
      c,
      `SELECT coalesce(sum(CASE direction WHEN 'DEBIT' THEN amount_minor ELSE -amount_minor END),0) AS bal FROM ledger_entries e JOIN accounts a ON a.id = e.account_id WHERE a.system_role = 'SETTLEMENT_SUSPENSE' AND a.currency = 'INR'`,
    )
  )[0]!;
  const alert = await q(c, `SELECT kind, status FROM risk_alerts WHERE settlement_id = $1`, [
    st.id,
  ]);
  log(
    `  settlement ${st.status}, expected ${st.expected_minor}; suspense balance ${suspense.bal}; alerts ${j(alert)}`,
  );
  check(
    st.status === "FAILED" && String(suspense.bal) === "100000" && alert.length === 1,
    "failed payout moved to suspense and raised an alert",
  );
  await finance.reauth();
  const res = await finance.post(`/settlements/${st.id}/resolve`, {
    recovered_minor: "100000",
    note: "provider re-sent the payout",
  });
  check(
    res.status === 200,
    "finance recovered the settlement (FAILED → RESOLVED, suspense cleared)",
  );

  log("\n== 4. Reversal ==");
  const t = (
    await q<{ id: string }>(
      c,
      `SELECT id FROM transfers WHERE source_wallet_id = $1 AND status = 'POSTED' LIMIT 1`,
      [aliceW.id],
    )
  )[0]!;
  const a0 = await balance(c, aliceW.account_id);
  const rev = await finance.post(
    `/transfers/${t.id}/reverse`,
    { reason: "capstone reversal" },
    randomUUID(),
  );
  const again = await finance.post(
    `/transfers/${t.id}/reverse`,
    { reason: "second attempt" },
    randomUUID(),
  );
  const a1 = await balance(c, aliceW.account_id);
  log(
    `  first reversal ${rev.status} ${rev.body.data?.status}; second ${again.status} ${again.body.error?.code}`,
  );
  check(
    rev.status === 200 && a1.posted_minor - a0.posted_minor === 150_150n,
    "reversal restored amount + fee to the sender",
  );
  check(again.status === 409, "double reversal refused (409 INVALID_STATE_TRANSITION)");
}

async function incidents(c: Ctx) {
  const alice = await login(c, "alice@fincore.test");
  const aliceW = await walletOf(c, "alice@fincore.test");
  const bobW = await walletOf(c, "bob@fincore.test");
  await alice.reauth();
  const ben = (
    await alice.post("/beneficiaries", { account_number: bobW.account_number, nickname: "Bob" })
  ).body.data.id as string;
  const ts = () => new Date().toISOString();

  log(`\n== INC-1 duplicate payment events ==  ${ts()}`);
  const chandra = await login(c, "chandra@fincore.test");
  const chW = await walletOf(c, "chandra@fincore.test");
  c.provider.faults.duplicateDeliveries = 9;
  c.provider.faults.reverseOrder = true;
  const pi = await chandra.post(
    "/payment-intents",
    { wallet_id: chW.id, amount_minor: "25000" },
    randomUUID(),
  );
  await chandra.post(
    `/payment-intents/${pi.body.data.id}/confirm`,
    { payment_method: "pm_simulated_success" },
    randomUUID(),
  );
  await c.drain();
  Object.assign(c.provider.faults, { duplicateDeliveries: 0, reverseOrder: false });
  const ev = await q(
    c,
    `SELECT type, deliveries, status FROM provider_events WHERE payload->'data'->>'provider_ref' = $1`,
    [pi.body.data.provider_ref],
  );
  log(`  ${j(ev)}`);
  check(
    (
      await q(c, `SELECT 1 FROM transactions WHERE kind='TOPUP' AND reference_id = $1`, [
        pi.body.data.id,
      ])
    ).length === 1,
    "10 deliveries per event, out of order → exactly one credit",
  );

  log(`\n== INC-2 mismatched provider settlement ==  ${ts()}`);
  c.provider.payout(
    `po_inc2_${Date.now()}`,
    "INR",
    [{ provider_ref: pi.body.data.provider_ref as string, amount_minor: 24_000n }],
    { paidMinor: 24_000n },
  );
  await c.drain();
  const s2 = (
    await q(
      c,
      `SELECT id, status, expected_minor, actual_minor FROM settlements ORDER BY created_at DESC LIMIT 1`,
    )
  )[0]!;
  const items = await q(
    c,
    `SELECT i.outcome, i.diff_minor FROM reconciliation_items i JOIN reconciliation_runs r ON r.id = i.run_id WHERE r.settlement_id = $1`,
    [s2.id],
  );
  log(
    `  settlement ${s2.status} expected ${s2.expected_minor} actual ${s2.actual_minor}; items ${j(items)}`,
  );
  check(
    s2.status === "MISMATCHED",
    "short payout detected by reconciliation, difference parked in suspense, alert raised",
  );

  log(`\n== INC-3 unbalanced ledger attempt ==  ${ts()}`);
  const cl = await c.deps.db.connect();
  try {
    await cl.query("BEGIN");
    const tx = (
      await cl.query<{ id: string }>(
        `INSERT INTO transactions (kind, currency, description) VALUES ('ADJUSTMENT','INR','INC-3 buggy adjustment') RETURNING id`,
      )
    ).rows[0]!;
    await cl.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, currency, direction, amount_minor) VALUES ($1, $2, 'INR', 'CREDIT', 5000)`,
      [tx.id, aliceW.account_id],
    );
    await cl.query("COMMIT");
    check(false, "unbalanced commit should have failed");
  } catch (err) {
    await cl.query("ROLLBACK").catch(() => undefined);
    log(`  database refused: ${(err as { code?: string }).code} ${(err as Error).message}`);
    check(
      (err as { code?: string }).code === "FC002",
      "deferred balance check rejected the unbalanced journal at COMMIT (nothing persisted)",
    );
  } finally {
    cl.release();
  }

  log(`\n== INC-5 suspicious activity alert ==  ${ts()}`);
  for (let i = 0; i < 6; i++)
    await alice.post(
      "/transfers",
      { source_wallet_id: aliceW.id, beneficiary_id: ben, amount_minor: "1000" },
      randomUUID(),
    );
  const sus = await alice.post(
    "/transfers",
    { source_wallet_id: aliceW.id, beneficiary_id: ben, amount_minor: "60000" },
    randomUUID(),
  );
  log(
    `  burst of 6 transfers then a 60x spike → ${sus.status} ${sus.body.data?.status} score ${sus.body.data?.risk?.score} reasons ${j(sus.body.data?.risk?.reasons?.map((r: { code: string }) => r.code))}`,
  );
  check(
    sus.status === 202 && sus.body.data?.status === "PENDING",
    "high-risk transfer held for review (funds on hold, not posted)",
  );
  const ops = await login(c, "ops@fincore.test");
  const alertId = (
    await q<{ id: string }>(c, `SELECT id FROM risk_alerts WHERE transfer_id = $1`, [
      sus.body.data.id,
    ])
  )[0]?.id;
  await ops.post(`/risk-alerts/${alertId}/transition`, {
    to: "INVESTIGATING",
    note: "velocity + new beneficiary + spike",
  });
  const esc = await ops.post(`/risk-alerts/${alertId}/transition`, {
    to: "ESCALATED",
    note: "customer did not confirm",
  });
  log(`  analyst escalated → transfer ${esc.body.data?.transfer_status}`);
  check(
    esc.body.data?.transfer_status === "FAILED",
    "escalation failed the transfer and released the hold (a human decides; the score is support only)",
  );

  log(`\n== INC-4 latency spike / analytics outage ==  ${ts()}`);
  const timeIt = async (n: number) => {
    const ms: number[] = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      await alice.post(
        "/transfers",
        { source_wallet_id: aliceW.id, beneficiary_id: ben, amount_minor: "1000" },
        randomUUID(),
      );
      ms.push(performance.now() - t0);
    }
    ms.sort((a, b) => a - b);
    return { p50: ms[Math.floor(n * 0.5)]!.toFixed(0), p95: ms[Math.floor(n * 0.95)]!.toFixed(0) };
  };
  log(`  baseline latency ms ${j(await timeIt(20))}`);
  c.analyticsProc.kill(); // dependency outage
  const down = await alice.post(
    "/transfers",
    { source_wallet_id: aliceW.id, beneficiary_id: ben, amount_minor: "1000" },
    randomUUID(),
  );
  log(
    `  analytics down → ${down.status} ${down.body.error?.code ?? down.body.data?.status} (fee cannot be quoted: fail closed, key released)`,
  );
  check(
    down.status === 503,
    "transfers fail safely (503 UPSTREAM_UNAVAILABLE) instead of guessing fees; circuit breaker opens",
  );
}

async function main() {
  const mode = process.argv[2] ?? "capstone";
  log(`FinCore ${mode} - ${new Date().toISOString()} - SIMULATED funds only`);
  const c = await boot();
  try {
    if (mode === "incidents") await incidents(c);
    else await capstone(c);
    await proofs(c);
  } finally {
    await c.stop();
  }
  log(`\nRESULT: ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
