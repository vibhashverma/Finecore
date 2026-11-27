import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import { z } from "zod";
import { startHealthServer } from "./health.js";
import { processPing, QUEUES, type PingJob } from "./queues.js";

const env = z
  .object({
    REDIS_URL: z.url(),
    WORKER_HEALTH_PORT: z.coerce.number().int().default(4100),
    LOG_LEVEL: z.string().default("info"),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  })
  .parse(process.env);

const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "workers" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// BullMQ requires maxRetriesPerRequest: null for blocking connections.
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
connection.on("error", (err) => logger.warn({ err: err.message }, "redis error"));

let shuttingDown = false;

const systemWorker = new Worker<PingJob>(
  QUEUES.system,
  async (job) => {
    const result = processPing(job.data);
    logger.info({ job_id: job.id, ...result }, "system ping processed");
    return result;
  },
  { connection, concurrency: 1 },
);
systemWorker.on("failed", (job, err) =>
  logger.error({ job_id: job?.id, err: err.message }, "job failed"),
);

const health = startHealthServer(env.WORKER_HEALTH_PORT, {
  isShuttingDown: () => shuttingDown,
  isReady: async () => (await connection.ping()) === "PONG" && systemWorker.isRunning(),
});
logger.info({ port: env.WORKER_HEALTH_PORT }, "workers started");

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutdown started: waiting for active jobs");
  const force = setTimeout(() => process.exit(1), env.SHUTDOWN_TIMEOUT_MS);
  force.unref();
  // worker.close() stops taking new jobs and waits for active ones to finish.
  await systemWorker.close();
  await connection.quit();
  health.close();
  logger.info("shutdown complete");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
