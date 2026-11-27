import type { NextFunction, Request, Response } from "express";
import { collectDefaultMetrics, Counter, Histogram, Registry } from "prom-client";

/** One registry per app instance, so tests don't share global state. */
export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const httpDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request latency",
    labelNames: ["method", "route", "status"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  const httpErrors = new Counter({
    name: "http_errors_total",
    help: "HTTP responses with status >= 500",
    labelNames: ["route"] as const,
    registers: [registry],
  });

  /** Uses the matched route pattern (not the raw URL), to keep label cardinality bounded. */
  function middleware(req: Request, res: Response, next: NextFunction): void {
    const end = httpDuration.startTimer();
    res.on("finish", () => {
      const route = (req.route?.path as string | undefined) ?? "unmatched";
      end({ method: req.method, route, status: String(res.statusCode) });
      if (res.statusCode >= 500) httpErrors.inc({ route });
    });
    next();
  }

  return { registry, middleware };
}

export type Metrics = ReturnType<typeof createMetrics>;
