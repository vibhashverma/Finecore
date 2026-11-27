import { createPool, parseEncryptionKey } from "@fincore/db";
import { Redis } from "ioredis";
import type { Logger } from "pino";
import { loadKeys } from "./auth/tokens.js";
import { loadConfig, type Config } from "./config.js";
import type { Deps } from "./deps.js";
import { HttpAnalyticsClient } from "./integrations/analytics.js";
import { SandboxNotifier } from "./integrations/notifier.js";
import {
  httpDeliver,
  SimulatedProvider,
  StripeTestProvider,
  type PaymentProvider,
} from "./integrations/provider.js";
import { createLogger } from "./lib/logger.js";
import { MemoryRateLimiter, RedisRateLimiter, type RateLimiter } from "./lib/rate-limit.js";

/** Wires real dependencies for the API and the workers (shared, so both run identical domain code). */
export async function buildDeps(service: "api" | "workers", env: NodeJS.ProcessEnv = process.env) {
  const config: Config = loadConfig(env);
  const logger: Logger = createLogger(config.LOG_LEVEL, service);
  const db = createPool(config.DATABASE_URL, {
    applicationName: `fincore-${service}`,
    max: service === "api" ? 20 : 10,
  });
  db.on("error", (err) => logger.error({ err }, "idle pg client error"));

  let redis: Redis | undefined;
  let limiter: RateLimiter;
  if (config.REDIS_URL) {
    redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
    redis.on("error", (err) => logger.warn({ err: err.message }, "redis error"));
    await redis
      .connect()
      .catch((err: unknown) => logger.warn({ err }, "redis not reachable at boot"));
    limiter = new RedisRateLimiter(redis);
  } else {
    logger.warn("REDIS_URL not set: using the in-memory rate limiter (single instance only)");
    limiter = new MemoryRateLimiter();
  }

  let provider: PaymentProvider;
  if (config.PAYMENT_PROVIDER === "STRIPE_TEST") {
    if (!config.STRIPE_SECRET_KEY)
      throw new Error("STRIPE_SECRET_KEY (sk_test_...) is required for STRIPE_TEST");
    provider = new StripeTestProvider(config.STRIPE_SECRET_KEY);
  } else {
    provider = new SimulatedProvider(
      config.WEBHOOK_SECRET,
      httpDeliver(config.WEBHOOK_TARGET_URL),
      50,
      logger,
    );
  }

  const deps: Deps = {
    config,
    logger,
    db,
    keys: await loadKeys(config),
    mfaKey: parseEncryptionKey(config.MFA_ENC_KEY),
    limiter,
    analytics: new HttpAnalyticsClient(config.ANALYTICS_URL, config.ANALYTICS_TOKEN),
    provider,
    notifier: new SandboxNotifier(config.SMTP_URL, config.MAIL_FROM, logger),
    readinessChecks: {
      postgres: async () => {
        await db.query("SELECT 1");
      },
      ...(redis
        ? {
            redis: async () => {
              if ((await redis.ping()) !== "PONG") throw new Error("unexpected ping reply");
            },
          }
        : {}),
    },
    isShuttingDown: () => false,
  };
  if (deps.keys.ephemeral)
    logger.warn("JWT keys are ephemeral (development only): sessions end on restart");
  const close = async () => {
    await Promise.allSettled([db.end(), redis?.quit()]);
  };
  return { deps, close };
}
