import { errorBodySchema } from "@fincore/contracts";
import express from "express";
import { pino } from "pino";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AppError } from "../src/lib/errors.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import { resolveRequestId } from "../src/middleware/request-id.js";
import { buildHarness, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await buildHarness();
});

describe("health endpoints", () => {
  it("GET /healthz is ok without touching dependencies", async () => {
    const app = createApp({
      ...h.deps,
      readinessChecks: { postgres: () => Promise.reject(new Error("down")) },
    });
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /readyz is 200 when dependencies are healthy", async () => {
    const res = await request(h.app).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", checks: { postgres: "ok" } });
  });

  it("GET /readyz is 503 and does not leak internals when a dependency fails", async () => {
    const app = createApp({
      ...h.deps,
      readinessChecks: { redis: () => Promise.reject(new Error("ECONNREFUSED 10.0.0.5:6379")) },
    });
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ redis: "fail" });
    expect(JSON.stringify(res.body)).not.toContain("10.0.0.5");
  });

  it("GET /readyz is 503 while draining", async () => {
    const res = await request(createApp({ ...h.deps, isShuttingDown: () => true })).get("/readyz");
    expect(res.status).toBe(503);
  });

  it("GET /metrics exposes HTTP and business metrics (queue depth, failed jobs, ledger invariant)", async () => {
    const res = await request(h.app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.text).toContain("http_request_duration_seconds");
    expect(res.text).toContain("fincore_ledger_invariant_violations 0");
    expect(res.text).toContain("fincore_outbox_pending_jobs");
  });
});

describe("request ids and error envelope", () => {
  it("echoes a well-formed x-request-id and replaces hostile ones", async () => {
    const res = await request(h.app).get("/healthz").set("x-request-id", "req_abc12345");
    expect(res.headers["x-request-id"]).toBe("req_abc12345");
    expect(resolveRequestId("bad id\nwith newline")).toMatch(/^req_[0-9a-f]{32}$/);
  });

  it("unknown routes return NOT_FOUND in the envelope with the request id", async () => {
    const res = await request(h.app).get("/nope");
    expect(res.status).toBe(404);
    expect(errorBodySchema.parse(res.body).error.request_id).toBe(res.headers["x-request-id"]);
  });

  it("malformed JSON → VALIDATION_ERROR; oversized body → VALIDATION_ERROR", async () => {
    const bad = await request(h.app)
      .post("/api/v1/auth/login")
      .set("content-type", "application/json")
      .send('{"email": ');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
    const big = await request(h.app)
      .post("/api/v1/auth/login")
      .set("content-type", "application/json")
      .send(JSON.stringify({ pad: "x".repeat(200_000) }));
    expect(big.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("hides internals of unexpected errors", async () => {
    const outer = express();
    outer.get("/boom", () => {
      throw new Error("SELECT * FROM users WHERE password_hash = 'secret'");
    });
    outer.use(errorHandler(pino({ level: "silent" })));
    const res = await request(outer).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|password|stack/i);
  });

  it("AppError carries the catalog status; security headers are set", async () => {
    expect(new AppError("INSUFFICIENT_FUNDS", "x").status).toBe(422);
    const res = await request(h.app).get("/healthz");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
