import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface WorkerHealthDeps {
  isReady: () => Promise<boolean>;
  isShuttingDown: () => boolean;
}

/** Request handler for the worker's internal health endpoints (separate from the http server, for testing). */
export function healthHandler(deps: WorkerHealthDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/healthz") return send(200, { status: "ok" });
    if (req.url === "/readyz") {
      if (deps.isShuttingDown()) return send(503, { status: "shutting_down" });
      const ready = await deps.isReady().catch(() => false);
      return send(ready ? 200 : 503, { status: ready ? "ready" : "not_ready" });
    }
    return send(404, { status: "not_found" });
  };
}

export function startHealthServer(port: number, deps: WorkerHealthDeps): Server {
  const handler = healthHandler(deps);
  return createServer((req, res) => void handler(req, res)).listen(port);
}
