import { buildDeps, startJobLoop } from "@fincore/api/worker";
import { z } from "zod";
import { startHealthServer } from "./health.js";

/**
 * Worker process: drains the Postgres outbox/job queue (ADR-009): webhooks processing, notifications,
 * reconciliation, refunds submission, housekeeping. Graceful SIGTERM: finish the in-flight batch, then exit.
 */
async function main(): Promise<void> {
  const env = z
    .object({ WORKER_HEALTH_PORT: z.coerce.number().int().default(4100) })
    .parse(process.env);
  const { deps, close } = await buildDeps("workers");
  let shuttingDown = false;
  const loop = startJobLoop(deps);
  const health = startHealthServer(env.WORKER_HEALTH_PORT, {
    isShuttingDown: () => shuttingDown,
    isReady: async () => {
      await deps.db.query("SELECT 1");
      return true;
    },
  });
  deps.logger.info({ port: env.WORKER_HEALTH_PORT }, "workers started");

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.logger.info({ signal }, "shutdown started: draining jobs");
    const force = setTimeout(() => process.exit(1), deps.config.SHUTDOWN_TIMEOUT_MS * 3);
    force.unref();
    await loop.stop();
    await close();
    health.close();
    deps.logger.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", msg: err instanceof Error ? err.message : "startup failed" })}\n`,
  );
  process.exit(1);
});
