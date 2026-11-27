import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DB_ERROR } from "../src/errors.js";
import { withClientTransaction } from "../src/pool.js";
import { app, expectPgError, newWallet, owner, superuser } from "./helpers.js";

async function newSettlement(expected = 10_000n): Promise<string> {
  const r = await app.query<{ id: string }>(
    `INSERT INTO settlements (provider, provider_payout_id, currency, expected_minor, value_date)
     VALUES ('SIMULATOR', $1, 'INR', $2, current_date) RETURNING id`,
    [`po_${randomUUID()}`, expected.toString()],
  );
  return r.rows[0]!.id;
}

describe("database-enforced state machines with automatic history", () => {
  it("records each transition with actor, reason and request id from SET LOCAL", async () => {
    const id = await newSettlement();
    const actor = randomUUID();
    await withClientTransaction(app, async (c) => {
      await c.query(
        `SELECT set_config('fincore.actor_id', $1, true), set_config('fincore.reason', 'amount differs', true),
                            set_config('fincore.request_id', 'req_test123', true)`,
        [actor],
      );
      await c.query(
        `UPDATE settlements SET status = 'MISMATCHED', actual_minor = 9000 WHERE id = $1`,
        [id],
      );
    });
    const h = await app.query(
      `SELECT from_state, to_state, actor_id, reason, request_id FROM state_transitions
        WHERE entity_type = 'SETTLEMENT' AND entity_id = $1 ORDER BY id`,
      [id],
    );
    expect(h.rows).toEqual([
      { from_state: null, to_state: "EXPECTED", actor_id: null, reason: null, request_id: null },
      {
        from_state: "EXPECTED",
        to_state: "MISMATCHED",
        actor_id: actor,
        reason: "amount differs",
        request_id: "req_test123",
      },
    ]);
  });

  it("rejects illegal transitions and illegal initial states", async () => {
    const id = await newSettlement();
    await app.query(
      `UPDATE settlements SET status = 'MATCHED', actual_minor = 10000 WHERE id = $1`,
      [id],
    );
    await expectPgError(
      app.query(`UPDATE settlements SET status = 'FAILED' WHERE id = $1`, [id]),
      DB_ERROR.INVALID_STATE_TRANSITION,
    );
    await expectPgError(
      app.query(
        `INSERT INTO settlements (provider, provider_payout_id, currency, expected_minor, value_date, status)
         VALUES ('SIMULATOR', $1, 'INR', 1, current_date, 'RESOLVED')`,
        [`po_${randomUUID()}`],
      ),
      DB_ERROR.INVALID_STATE_TRANSITION,
    );
  });

  it("enforces business checks tied to states (MATCHED requires equal amounts)", async () => {
    const id = await newSettlement(10_000n);
    await expectPgError(
      app.query(`UPDATE settlements SET status = 'MATCHED', actual_minor = 9999 WHERE id = $1`, [
        id,
      ]),
      DB_ERROR.CHECK_VIOLATION,
      "settlements_matched_amounts",
    );
  });

  it("deduplicates provider payouts (UNIQUE provider + payout id)", async () => {
    const payout = `po_${randomUUID()}`;
    const insert = () =>
      app.query(
        `INSERT INTO settlements (provider, provider_payout_id, currency, expected_minor, value_date)
         VALUES ('SIMULATOR', $1, 'INR', 1, current_date)`,
        [payout],
      );
    await insert();
    await expectPgError(insert(), DB_ERROR.UNIQUE_VIOLATION, "settlements_provider_payout_key");
  });

  it("wallet lifecycle: FROZEN can be reactivated, CLOSED is final", async () => {
    const w = await newWallet();
    await app.query(`UPDATE wallets SET status = 'FROZEN' WHERE id = $1`, [w.walletId]);
    await app.query(`UPDATE wallets SET status = 'ACTIVE' WHERE id = $1`, [w.walletId]);
    await app.query(`UPDATE wallets SET status = 'CLOSED' WHERE id = $1`, [w.walletId]);
    await expectPgError(
      app.query(`UPDATE wallets SET status = 'ACTIVE' WHERE id = $1`, [w.walletId]),
      DB_ERROR.INVALID_STATE_TRANSITION,
    );
  });

  it("history can't be forged or edited", async () => {
    await expectPgError(
      app.query(
        `INSERT INTO state_transitions (entity_type, entity_id, to_state) VALUES ('TRANSFER', $1, 'POSTED')`,
        [randomUUID()],
      ),
      DB_ERROR.INSUFFICIENT_PRIVILEGE,
    );
    await expectPgError(
      app.query(`UPDATE state_transitions SET reason = 'x'`),
      DB_ERROR.INSUFFICIENT_PRIVILEGE,
    );
    await expectPgError(owner.query(`DELETE FROM state_transitions`), DB_ERROR.APPEND_ONLY);
  });
});

async function audit(action: string, extra: Record<string, unknown> = {}): Promise<void> {
  await app.query(
    `INSERT INTO audit_log (actor_id, actor_roles, action, resource_type, resource_id, outcome, request_id, metadata)
     VALUES ($1, '{FINANCE}', $2, 'transfer', $3, 'ALLOWED', 'req_audit_test', $4)`,
    [randomUUID(), action, randomUUID(), JSON.stringify(extra)],
  );
}

describe("hash-chained audit log", () => {
  it("chains every row and verifies clean; client-supplied hashes are ignored", async () => {
    await audit("transfer.reverse");
    await app.query(
      `INSERT INTO audit_log (action, outcome, chain_seq, prev_hash, hash)
       VALUES ('auth.login', 'DENIED', 999999, '\\x00', '\\x00')`,
    );
    const { rows } = await app.query<{ chain_seq: bigint }>(
      `SELECT chain_seq FROM audit_log ORDER BY chain_seq DESC LIMIT 1`,
    );
    expect(rows[0]!.chain_seq).not.toBe(999999n);
    expect((await app.query(`SELECT * FROM audit_log_verify_chain()`)).rows).toEqual([]);
  });

  it("stays gap-free and valid under 30 concurrent writers", async () => {
    await Promise.all(Array.from({ length: 30 }, (_, i) => audit("risk.score", { i })));
    const v = await app.query(`SELECT * FROM audit_log_verify_chain()`);
    expect(v.rows).toEqual([]);
    const gaps = await app.query<{ n: bigint; max: bigint }>(
      `SELECT count(*) AS n, max(chain_seq) AS max FROM audit_log`,
    );
    expect(gaps.rows[0]!.n).toBe(gaps.rows[0]!.max);
  });

  it("the app role cannot edit or delete audit rows", async () => {
    await expectPgError(
      app.query(`UPDATE audit_log SET outcome = 'ALLOWED'`),
      DB_ERROR.INSUFFICIENT_PRIVILEGE,
    );
    await expectPgError(app.query(`DELETE FROM audit_log`), DB_ERROR.INSUFFICIENT_PRIVILEGE);
    await expectPgError(
      owner.query(`UPDATE audit_log SET outcome = 'ALLOWED'`),
      DB_ERROR.APPEND_ONLY,
    );
  });

  it("detects tampering by a superuser who bypasses the triggers", async () => {
    await audit("refund.create", { amount_minor: "500" });
    const client = await superuser.connect();
    try {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only`);
      await client.query(
        `UPDATE audit_log SET metadata = '{"amount_minor":"5"}' WHERE chain_seq = (SELECT max(chain_seq) FROM audit_log)`,
      );
      const edited = await client.query<{ problem: string }>(
        `SELECT problem FROM audit_log_verify_chain()`,
      );
      expect(edited.rows.map((r) => r.problem)).toContain("hash mismatch: row content was altered");

      await client.query(
        `DELETE FROM audit_log WHERE chain_seq = (SELECT max(chain_seq) - 1 FROM audit_log)`,
      );
      const deleted = await client.query<{ problem: string }>(
        `SELECT problem FROM audit_log_verify_chain()`,
      );
      expect(deleted.rows.some((r) => r.problem.startsWith("gap"))).toBe(true);
    } finally {
      await client.query("ROLLBACK"); // leave the shared test database intact
      client.release();
    }
  });
});
