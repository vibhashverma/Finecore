/**
 * Boots the real FinCore stack for E2E tests WITHOUT Docker (ADR-005):
 * embedded PostgreSQL 16 (migrated + seeded) → FastAPI analytics → compiled API → compiled workers.
 * Next.js is started separately by Playwright's second webServer. Ctrl+C / SIGTERM stops everything.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { seed } from "@fincore/db/seed";
import { startFincoreDatabase } from "@fincore/db/testing";

const root = resolve(import.meta.dirname, "../../..");
const children: ChildProcess[] = [];
// Dedicated ports so the E2E stack never collides with other local services.
export const PORTS = { api: 4400, workers: 4500, analytics: 8800 };

function run(name: string, cmd: string, args: string[], env: Record<string, string>, cwd = root) {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[${name}] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[${name}] ${d}`));
  child.on("exit", (code) => process.stdout.write(`[${name}] exited ${code}\n`));
  children.push(child);
}

async function main() {
  const db = await startFincoreDatabase();
  await seed(db.appUrl, "FinCore-Demo-2026!");
  const common = {
    APP_ENV: "development",
    LOG_LEVEL: "warn",
    ANALYTICS_URL: `http://127.0.0.1:${PORTS.analytics}`,
    SMTP_URL: "smtp://127.0.0.1:1025", // no Mailpit locally without Docker: notification jobs retry, then dead-letter
    WEBHOOK_TARGET_URL: `http://127.0.0.1:${PORTS.api}/api/v1/webhooks/payments`,
  };

  const venv = join(root, "services/analytics/.venv");
  const python = existsSync(join(venv, "Scripts/python.exe"))
    ? join(venv, "Scripts/python.exe")
    : join(venv, "bin/python");
  run(
    "analytics",
    python,
    [
      "-m",
      "uvicorn",
      "fincore_analytics.main:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(PORTS.analytics),
    ],
    { ANALYTICS_DATABASE_URL: db.analyticsUrl.replace("?sslmode=disable", "") },
  );
  run("api", process.execPath, ["apps/api/dist/server.js"], {
    ...common,
    DATABASE_URL: db.appUrl,
    API_PORT: String(PORTS.api),
  });
  run("workers", process.execPath, ["apps/workers/dist/main.js"], {
    ...common,
    DATABASE_URL: db.workersUrl,
    WORKER_HEALTH_PORT: String(PORTS.workers),
  });

  const stop = async () => {
    for (const c of children) c.kill();
    await db.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
