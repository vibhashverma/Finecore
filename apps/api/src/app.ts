import cookieParser from "cookie-parser";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { Gauge } from "prom-client";
import swaggerUi from "swagger-ui-express";
import { authenticate } from "./auth/middleware.js";
import { authRouter } from "./auth/routes.js";
import type { Deps } from "./deps.js";
import { createMetrics } from "./lib/metrics.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { requestId } from "./middleware/request-id.js";
import { accountsRouter } from "./modules/accounts.js";
import { disputesRouter } from "./modules/disputes.js";
import { healthRouter } from "./modules/health/health.routes.js";
import { opsRouter } from "./modules/ops.js";
import { paymentsRouter, webhooksRouter } from "./modules/payments.js";
import { statementsRouter } from "./modules/statements.js";
import { transfersRouter } from "./modules/transfers.js";
import { buildOpenApi } from "./openapi.js";

/**
 * Builds the Express app with no listeners and no global state, so tests can build isolated instances with fake
 * dependencies.
 */
export function createApp(deps: Deps): Express {
  const app = express();
  const metrics = createMetrics();

  // Business metrics computed at scrape time (brief §11: queue depth, failed jobs, ledger invariant check).
  if (typeof deps.db.query === "function") {
    new Gauge({
      name: "fincore_outbox_pending_jobs",
      help: "Jobs waiting in the outbox",
      registers: [metrics.registry],
      async collect() {
        this.set(
          Number(
            (
              await deps.db.query<{ n: number }>(
                `SELECT count(*)::int AS n FROM outbox WHERE status = 'PENDING'`,
              )
            ).rows[0]?.n ?? 0,
          ),
        );
      },
    });
    new Gauge({
      name: "fincore_failed_jobs",
      help: "Dead-lettered jobs not yet replayed",
      registers: [metrics.registry],
      async collect() {
        this.set(
          Number(
            (
              await deps.db.query<{ n: number }>(
                `SELECT count(*)::int AS n FROM failed_jobs WHERE replayed_at IS NULL`,
              )
            ).rows[0]?.n ?? 0,
          ),
        );
      },
    });
    new Gauge({
      name: "fincore_ledger_invariant_violations",
      help: "Rows returned by ledger_invariant_violations(); must be 0",
      registers: [metrics.registry],
      async collect() {
        this.set(
          Number(
            (
              await deps.db.query<{ n: number }>(
                `SELECT count(*)::int AS n FROM ledger_invariant_violations()`,
              )
            ).rows[0]?.n ?? 0,
          ),
        );
      },
    });
  }

  app.disable("x-powered-by");
  app.set("trust proxy", 1); // exactly one hop: Caddy
  // bigint → string in every JSON response (ADR-001: money is never a JS number on the wire).
  app.set("json replacer", (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
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
  app.use(cookieParser());
  // Webhooks need the exact raw bytes for HMAC verification, so they bypass the JSON parser.
  app.use("/api/v1/webhooks", express.raw({ type: "application/json", limit: "256kb" }));
  app.use(express.json({ limit: "100kb" }));

  app.use(
    healthRouter({
      checks: deps.readinessChecks,
      isShuttingDown: deps.isShuttingDown,
      registry: metrics.registry,
    }),
  );

  const spec = buildOpenApi();
  app.get("/api/v1/openapi.json", (_req, res) => {
    res.json(spec);
  });
  app.use(
    "/api/docs",
    helmet({
      contentSecurityPolicy: {
        directives: { "script-src": ["'self'", "'unsafe-inline'"], "img-src": ["'self'", "data:"] },
      },
    }),
    swaggerUi.serve,
    swaggerUi.setup(spec),
  );

  const v1 = express.Router();
  v1.use(webhooksRouter(deps)); // signature-authenticated, no session
  v1.use(authRouter(deps)); // login/refresh are public; logout/reauth authenticate internally
  v1.use(authenticate(deps)); // everything below requires a valid session
  v1.use(accountsRouter(deps));
  v1.use(transfersRouter(deps));
  v1.use(paymentsRouter(deps));
  v1.use(disputesRouter(deps));
  v1.use(statementsRouter(deps));
  v1.use(opsRouter(deps));
  app.use("/api/v1", v1);

  app.use(notFoundHandler);
  app.use(errorHandler(deps.logger));
  return app;
}
