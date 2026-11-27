import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { healthHandler, type WorkerHealthDeps } from "../src/health.js";

describe("worker health server", () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function serve(deps: WorkerHealthDeps) {
    const server = createServer((req, res) => void healthHandler(deps)(req, res)).listen(0);
    close = () => server.close();
    await new Promise((r) => server.once("listening", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("is ready when redis answers", async () => {
    const base = await serve({ isReady: async () => true, isShuttingDown: () => false });
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it("is not ready when the readiness check throws (failure path)", async () => {
    const base = await serve({
      isReady: () => Promise.reject(new Error("ECONNREFUSED")),
      isShuttingDown: () => false,
    });
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
  });

  it("reports shutting_down while draining", async () => {
    const base = await serve({ isReady: async () => true, isShuttingDown: () => true });
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "shutting_down" });
  });

  it("returns 404 for unknown paths", async () => {
    const base = await serve({ isReady: async () => true, isShuttingDown: () => false });
    expect((await fetch(`${base}/metrics-secret`)).status).toBe(404);
  });
});
