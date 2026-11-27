import { describe, expect, it } from "vitest";
import { inject } from "vitest";
import { redactUrls, renderPsqlVariables } from "../src/bootstrap.js";
import { seed } from "../src/seed.js";
import { app } from "./helpers.js";

describe("seed", () => {
  it("creates synthetic users and funded wallets once, and is idempotent", async () => {
    const urls = inject("db");
    const first = await seed(urls.appUrl, "test-demo-password");
    expect(first).toEqual({ usersCreated: 8, walletsCreated: 5, fundingTransactions: 4 });
    const second = await seed(urls.appUrl, "test-demo-password");
    expect(second).toEqual({ usersCreated: 0, walletsCreated: 0, fundingTransactions: 0 });

    const alice = await app.query<{ currency: string; posted_minor: bigint }>(
      `SELECT w.currency, b.posted_minor FROM users u
         JOIN customers c ON c.user_id = u.id
         JOIN wallets w ON w.customer_id = c.id
         JOIN account_balances b ON b.account_id = w.account_id
        WHERE u.email = 'alice@fincore.test' ORDER BY w.currency`,
    );
    expect(alice.rows).toEqual([
      { currency: "INR", posted_minor: 5_000_000n },
      { currency: "USD", posted_minor: 100_000n },
    ]);

    const hashes = await app.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE email LIKE '%@fincore.test' AND email NOT LIKE 't-%'`,
    );
    for (const h of hashes.rows)
      expect(h.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });
});

describe("bootstrap helpers", () => {
  it("renders psql variables as safely quoted literals and identifiers", () => {
    const sql = `CREATE ROLE r PASSWORD :'pw'; ALTER DATABASE :"db" OWNER TO r;`;
    expect(renderPsqlVariables(sql, { pw: "it's; DROP TABLE x", db: 'we"ird' })).toBe(
      `CREATE ROLE r PASSWORD 'it''s; DROP TABLE x'; ALTER DATABASE "we""ird" OWNER TO r;`,
    );
  });

  it("refuses to render with a missing variable", () => {
    expect(() => renderPsqlVariables(`:'missing'`, {})).toThrow("missing psql variable: missing");
  });

  it("redacts passwords from connection URLs in error output", () => {
    expect(
      redactUrls("failed: postgres://fincore_owner:s3cr3t@127.0.0.1:5432/fincore?sslmode=disable"),
    ).toBe("failed: postgres://fincore_owner:***@127.0.0.1:5432/fincore?sslmode=disable");
  });
});
