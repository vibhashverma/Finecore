import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/bootstrap.js";
import { MIGRATIONS_DIR } from "../src/paths.js";
import { startFincoreDatabase } from "../src/testing.js";
import { newWallet, superuser } from "./helpers.js";

describe("migrations", () => {
  it("every migration rolls back cleanly and re-applies (down sections are real)", async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    const db = await startFincoreDatabase();
    try {
      for (let i = 0; i < files.length; i++) await migrate(db.ownerUrl, "rollback");
      const client = new pg.Client({ connectionString: db.ownerUrl });
      await client.connect();
      const left = await client.query(
        `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
      );
      await client.end();
      expect(left.rows[0].n).toBe(0);

      const out = await migrate(db.ownerUrl, "up");
      expect(out.match(/Applied:/g)).toHaveLength(files.length);
    } finally {
      await db.stop();
    }
  }, 180_000);

  it("migration file names are timestamped and unique", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    for (const f of files) expect(f).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
    expect(new Set(files.map((f) => f.slice(0, 14))).size).toBe(files.length);
  });
});

describe("the invariant check is an independent detector", () => {
  // Simulates a defect (a missing trigger, a corrupted cache) as superuser, inside a transaction
  // that is always rolled back, and proves ledger_invariant_violations() would catch it.
  async function inRolledBackSuperuserTx(fn: (c: pg.PoolClient) => Promise<void>) {
    const c = await superuser.connect();
    try {
      await c.query("BEGIN");
      await fn(c);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  }

  it("reports an unbalanced journal if the commit-time check were bypassed", async () => {
    const a = await newWallet({ fund: 1_000n });
    const b = await newWallet();
    await inRolledBackSuperuserTx(async (c) => {
      await c.query(`ALTER TABLE transactions DISABLE TRIGGER transactions_integrity`);
      const id = randomUUID();
      await c.query(
        `INSERT INTO transactions (id, kind, currency, description) VALUES ($1, 'TRANSFER', 'INR', 'defect')`,
        [id],
      );
      await c.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, currency, direction, amount_minor)
         VALUES ($1, $2, 'INR', 'DEBIT', 100), ($1, $3, 'INR', 'CREDIT', 90)`,
        [id, a.accountId, b.accountId],
      );
      const v = await c.query<{ check_name: string }>(
        `SELECT check_name FROM ledger_invariant_violations()`,
      );
      expect(v.rows.map((r) => r.check_name)).toEqual(
        expect.arrayContaining(["unbalanced_transaction", "global_imbalance"]),
      );
    });
  });

  it("reports drift if a cached balance were corrupted", async () => {
    const a = await newWallet({ fund: 1_000n });
    await inRolledBackSuperuserTx(async (c) => {
      await c.query(
        `UPDATE account_balances SET posted_minor = posted_minor + 1 WHERE account_id = $1`,
        [a.accountId],
      );
      const v = await c.query<{ check_name: string; detail: string }>(
        `SELECT * FROM ledger_invariant_violations()`,
      );
      expect(v.rows).toEqual([
        { check_name: "posted_balance_drift", detail: `${a.accountId}: cached=1001 ledger=1000` },
      ]);
    });
  });
});
