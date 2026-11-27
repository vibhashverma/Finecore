import express, { type Express } from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import { createMetrics } from "./lib/metrics.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { requestId } from "./middleware/request-id.js";
import { healthRouter, type ReadinessCheck } from "./modules/health/health.routes.js";

export interface AppDeps {
  logger: Logger;
  readinessChecks: Record<string, ReadinessCheck>;
  isShuttingDown: () => boolean;
}

/**
 * Builds the Express app with no network listeners and no global state, so tests can build
 * isolated instances with fake dependencies.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();
  const metrics = createMetrics();

  app.disable("x-powered-by");
  app.set("trust proxy", 1); // exactly one hop: Caddy
  app.use(helmet());
  app.use(requestId);
  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (_req, res) => String(res.locals.requestId),
      customProps: (_req, res) => ({ request_id: res.locals.requestId }),
      autoLogging: { ignore: (req) => req.url === "/healthz" || req.url === "/metrics" },
    }),
  );
  app.use(metrics.middleware);
  app.use(express.json({ limit: "100kb" }));

  app.use(
    healthRouter({
      checks: deps.readinessChecks,
      isShuttingDown: deps.isShuttingDown,
      registry: metrics.registry,
    }),
  );

  // Domain modules are mounted under /api/v1 from Phase 3 onward.
  const v1 = express.Router();
  app.use("/api/v1", v1);

  app.use(notFoundHandler);
  app.use(errorHandler(deps.logger));
  return app;
}
