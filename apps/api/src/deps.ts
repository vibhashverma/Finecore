import type { Logger } from "pino";
import type { JwtKeys } from "./auth/tokens.js";
import type { Config } from "./config.js";
import type { AnalyticsClient } from "./integrations/analytics.js";
import type { Notifier } from "./integrations/notifier.js";
import type { PaymentProvider } from "./integrations/provider.js";
import type { Db } from "./lib/db.js";
import type { RateLimiter } from "./lib/rate-limit.js";
import type { ReadinessCheck } from "./modules/health/health.routes.js";

/** Everything a request handler or job needs. Built once in server.ts; replaced by fakes in tests. */
export interface Deps {
  config: Config;
  logger: Logger;
  db: Db;
  keys: JwtKeys;
  mfaKey: Buffer;
  limiter: RateLimiter;
  analytics: AnalyticsClient;
  provider: PaymentProvider;
  notifier: Notifier;
  readinessChecks: Record<string, ReadinessCheck>;
  isShuttingDown: () => boolean;
}

/** The authenticated principal, resolved from the DB on every request (not trusted from the JWT). */
export interface AuthContext {
  userId: string;
  sessionId: string;
  roles: string[];
  customerId: string | null;
  reauthAt: Date | null;
  viaCookie: boolean;
}
