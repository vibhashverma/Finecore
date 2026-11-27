import { createServer } from "node:http";
import { createApp } from "./app.js";
import { buildDeps } from "./bootstrap.js";

/** API process entrypoint: wires real dependencies, listens, and shuts down gracefully on SIGTERM. */
async function main(): Promise<void> {
  const { deps, close } = await buildDeps("api");
  let shuttingDown = false;
  deps.isShuttingDown = () => shuttingDown;

  const server = createServer(createApp(deps));
  server.listen(deps.config.API_PORT, () =>
    deps.logger.info({ port: deps.config.API_PORT }, "api listening"),
  );

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true; // /readyz now returns 503 so the proxy stops routing here
    deps.logger.info({ signal }, "shutdown started: draining");
    const force = setTimeout(() => {
      deps.logger.error("shutdown timed out: forcing exit");
      process.exit(1);
    }, deps.config.SHUTDOWN_TIMEOUT_MS);
    force.unref();
    server.close(async () => {
      await close();
      deps.logger.info("shutdown complete");
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
    `${JSON.stringify({ level: "fatal", msg: err instanceof Error ? err.message : "startup failed" })}\n`,
  );
  process.exit(1);
});
