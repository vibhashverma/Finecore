import { hash } from "@node-rs/argon2";
import type pg from "pg";
import { createPool, firstRow, withClientTransaction } from "./pool.js";

/**
 * Synthetic seed data. Every person, email and balance here is SIMULATED.
 * Emails use the reserved `.test` TLD, so they can never belong to a real person.
 * Idempotent: running it again skips anything that already exists.
 */

interface SeedWallet {
  currency: "INR" | "USD" | "JPY";
  /** Opening SIMULATED funding in minor units. */
  fundMinor: bigint;
}
interface SeedCustomer {
  email: string;
  fullName: string;
  wallets: SeedWallet[];
}

export const SEED_STAFF = [
  { email: "support@fincore.test", role: "SUPPORT" },
  { email: "ops@fincore.test", role: "OPS" },
  { email: "finance@fincore.test", role: "FINANCE" },
  { email: "admin@fincore.test", role: "ADMIN" },
] as const;

export const SEED_CUSTOMERS: SeedCustomer[] = [
  {
    email: "alice@fincore.test",
    fullName: "Alice Demo (synthetic)",
    wallets: [
      { currency: "INR", fundMinor: 5_000_000n }, // ₹50,000.00
      { currency: "USD", fundMinor: 100_000n }, //   $1,000.00
    ],
  },
  {
    email: "bob@fincore.test",
    fullName: "Bob Demo (synthetic)",
    wallets: [{ currency: "INR", fundMinor: 2_500_000n }],
  },
  {
    email: "chandra@fincore.test",
    fullName: "Chandra Demo (synthetic)",
    wallets: [{ currency: "INR", fundMinor: 1_000_000n }],
  },
  {
    email: "dev@fincore.test",
    fullName: "Dev Demo (synthetic, empty)",
    wallets: [{ currency: "INR", fundMinor: 0n }],
  },
];

/** OWASP baseline Argon2id parameters (ADR-004). Argon2id is the library default algorithm. */
export const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export interface SeedResult {
  usersCreated: number;
  walletsCreated: number;
  fundingTransactions: number;
}

async function createUser(
  c: pg.PoolClient,
  email: string,
  passwordHash: string,
  role: string,
): Promise<string | null> {
  const res = await c.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id`,
    [email, passwordHash],
  );
  const id = res.rows[0]?.id;
  if (!id) return null;
  await c.query(`INSERT INTO user_roles (user_id, role_code) VALUES ($1, $2)`, [id, role]);
  return id;
}

/** Opens a wallet (liability account + wallet row) and optionally funds it from SIMULATED_FUNDING. */
export async function openWallet(
  c: pg.PoolClient,
  customerId: string,
  currency: string,
  accountNumber: string,
  fundMinor: bigint,
): Promise<{ walletId: string; accountId: string; funded: boolean }> {
  const acct = await c.query<{ id: string }>(
    `INSERT INTO accounts (code, name, type, normal_side, currency)
     VALUES ('WAL:' || $1, 'Customer wallet ' || $1, 'LIABILITY', 'CREDIT', $2) RETURNING id`,
    [accountNumber, currency],
  );
  const accountId = firstRow(acct, "account").id;
  const wallet = await c.query<{ id: string }>(
    `INSERT INTO wallets (customer_id, account_id, currency, account_number) VALUES ($1, $2, $3, $4) RETURNING id`,
    [customerId, accountId, currency, accountNumber],
  );
  const walletId = firstRow(wallet, "wallet").id;
  if (fundMinor <= 0n) return { walletId, accountId, funded: false };

  const txn = await c.query<{ id: string }>(
    `INSERT INTO transactions (kind, currency, description, reference_type, reference_id)
     VALUES ('SIMULATED_FUNDING', $1, 'SIMULATED demo funding', 'wallet', $2) RETURNING id`,
    [currency, walletId],
  );
  // Debit the system funding account first (no balance row), then credit the wallet.
  await c.query(
    `INSERT INTO ledger_entries (transaction_id, account_id, currency, direction, amount_minor) VALUES
       ($1, (SELECT a.id FROM accounts a WHERE a.system_role = 'SIMULATED_FUNDING' AND a.currency = $2), $2, 'DEBIT', $3),
       ($1, $4, $2, 'CREDIT', $3)`,
    [firstRow(txn, "transaction").id, currency, fundMinor.toString(), accountId],
  );
  return { walletId, accountId, funded: true };
}

export async function seed(appUrl: string, demoPassword: string): Promise<SeedResult> {
  const pool = createPool(appUrl, { applicationName: "fincore-seed", max: 2 });
  const passwordHash = await hash(demoPassword, ARGON2_OPTIONS);
  const result: SeedResult = { usersCreated: 0, walletsCreated: 0, fundingTransactions: 0 };
  let walletIndex = 0;

  try {
    for (const staff of SEED_STAFF) {
      await withClientTransaction(pool, async (c) => {
        if (await createUser(c, staff.email, passwordHash, staff.role)) result.usersCreated++;
      });
    }

    for (const customer of SEED_CUSTOMERS) {
      // Deterministic synthetic account numbers, independent of what a previous run created.
      const accountNumbers = customer.wallets.map(
        () => `FC${(1_000_000_000 + ++walletIndex).toString()}`,
      );
      await withClientTransaction(pool, async (c) => {
        const userId = await createUser(c, customer.email, passwordHash, "CUSTOMER");
        if (!userId) return; // already seeded
        result.usersCreated++;
        const cust = await c.query<{ id: string }>(
          `INSERT INTO customers (user_id, full_name) VALUES ($1, $2) RETURNING id`,
          [userId, customer.fullName],
        );
        const customerId = firstRow(cust, "customer").id;
        for (const [i, w] of customer.wallets.entries()) {
          const accountNumber = accountNumbers[i] ?? "";
          const opened = await openWallet(c, customerId, w.currency, accountNumber, w.fundMinor);
          result.walletsCreated++;
          if (opened.funded) result.fundingTransactions++;
        }
        // Audit last, per the lock-ordering rule in ADR-006.
        await c.query(
          `INSERT INTO audit_log (action, resource_type, resource_id, outcome, metadata)
           VALUES ('seed.customer_create', 'customer', $1, 'ALLOWED', '{"source":"seed","simulated":true}')`,
          [customerId],
        );
      });
    }
  } finally {
    await pool.end();
  }
  return result;
}
