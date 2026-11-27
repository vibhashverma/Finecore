/**
 * Local PostgreSQL 16 without Docker: `pnpm db:local`.
 * Data persists in .local/pg. The first run bootstraps roles, migrates and seeds; later runs only apply new migrations.
 * Credentials are LOCAL-DEV-ONLY placeholders (override with env), never used outside this machine.
 */
import { join } from "node:path";
import { LOCAL_DEV_MFA_KEY } from "../crypto.js";
import { REPO_ROOT } from "../paths.js";
import { seed } from "../seed.js";
import { startFincoreDatabase } from "../testing.js";

const env = (k: string, d: string) => process.env[k] ?? d;

async function main(): Promise<void> {
  const db = await startFincoreDatabase({
    dataDir: join(REPO_ROOT, ".local", "pg"),
    port: Number.parseInt(env("FINCORE_LOCAL_PG_PORT", "54320"), 10),
    passwords: {
      super: env("FINCORE_LOCAL_SUPER_PASSWORD", "local-dev-only"),
      owner: env("FINCORE_OWNER_PASSWORD", "local-dev-only"),
      api: env("FINCORE_API_PASSWORD", "local-dev-only"),
      workers: env("FINCORE_WORKERS_PASSWORD", "local-dev-only"),
      analytics: env("FINCORE_ANALYTICS_PASSWORD", "local-dev-only"),
    },
  });
  process.stdout.write(db.migrateOutput);

  if (process.argv.includes("--seed")) {
    const r = await seed(
      db.appUrl,
      env("SEED_DEMO_PASSWORD", "FinCore-Demo-2026!"),
      env("MFA_ENC_KEY", LOCAL_DEV_MFA_KEY),
    );
    process.stdout.write(`seed: ${JSON.stringify(r)}\n`);
  }

  process.stdout.write(
    [
      "",
      "FinCore local Postgres 16 is running (Ctrl+C to stop):",
      `  DATABASE_URL (api)      ${db.appUrl}`,
      `  owner (migrations)      ${db.ownerUrl}`,
      `  analytics (read-only)   ${db.analyticsUrl}`,
      "",
    ].join("\n"),
  );

  const stop = async () => {
    await db.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
