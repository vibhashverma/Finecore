import { createServer } from "node:http";
import { Redis } from "ioredis";
import pg from "pg";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./lib/logger.js";

/** Process entrypoint: wires real dependencies, starts listening, and handles graceful shutdown. */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL, "api");

  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30_000,
  });
  pool.on("error", (err) => logger.error({ err }, "idle pg client error"));

  const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
  redis.on("error", (err) => logger.warn({ err: err.message }, "redis error"));
  await redis
    .connect()
    .catch((err: unknown) => logger.warn({ err }, "redis not reachable at boot"));

  let shuttingDown = false;
  const app = createApp({
    logger,
    isShuttingDown: () => shuttingDown,
    readinessChecks: {
      postgres: async () => {
        await pool.query("SELECT 1");
      },
      redis: async () => {
        if ((await redis.ping()) !== "PONG") throw new Error("unexpected ping reply");
      },
    },
  });

  const server = createServer(app);
  server.listen(config.API_PORT, () => logger.info({ port: config.API_PORT }, "api listening"));

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown started: draining");
    const force = setTimeout(() => {
      logger.error("shutdown timed out: forcing exit");
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);
    force.unref();

    server.close(async () => {
      await Promise.allSettled([pool.end(), redis.quit()]);
      logger.info("shutdown complete");
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  // The logger may not exist yet (e.g. config failure), so write a minimal JSON line to stderr.
  process.stderr.write(
    JSON.stringify({ level: "fatal", msg: err instanceof Error ? err.message : "startup failed" }) +
      "\n",
  );
  process.exit(1);
});
