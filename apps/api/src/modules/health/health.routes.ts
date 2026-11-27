import { Router } from "express";
import type { Registry } from "prom-client";

/** A named dependency check. It resolves if healthy and rejects otherwise. */
export type ReadinessCheck = () => Promise<void>;

export interface HealthDeps {
  checks: Record<string, ReadinessCheck>;
  isShuttingDown: () => boolean;
  registry: Registry;
  checkTimeoutMs?: number;
}

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      () => {
        clearTimeout(t);
        resolve();
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * /healthz: liveness. The process is up and the event loop is responsive. No dependency checks.
 * /readyz: readiness. Every dependency check passes and we are not draining for shutdown.
 * /metrics: Prometheus. It is blocked at the reverse proxy and only scraped on the internal network.
 */
export function healthRouter(deps: HealthDeps): Router {
  const router = Router();
  const timeout = deps.checkTimeoutMs ?? 2000;

  router.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/readyz", async (_req, res) => {
    if (deps.isShuttingDown()) {
      res.status(503).json({ status: "shutting_down", checks: {} });
      return;
    }
    const entries = await Promise.all(
      Object.entries(deps.checks).map(async ([name, check]) => {
        try {
          await withTimeout(check(), timeout);
          return [name, "ok"] as const;
        } catch {
          // Details stay out of the response (they may contain hostnames); they are logged by the caller.
          return [name, "fail"] as const;
        }
      }),
    );
    const checks = Object.fromEntries(entries);
    const ready = entries.every(([, s]) => s === "ok");
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks });
  });

  router.get("/metrics", async (_req, res) => {
    res.setHeader("Content-Type", deps.registry.contentType);
    res.send(await deps.registry.metrics());
  });

  return router;
}
