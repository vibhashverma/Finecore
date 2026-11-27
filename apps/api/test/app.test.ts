import { errorBodySchema } from "@fincore/contracts";
import { pino } from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/app.js";
import { AppError } from "../src/lib/errors.js";
import { resolveRequestId } from "../src/middleware/request-id.js";

const silent = pino({ level: "silent" });

function build(overrides: Partial<AppDeps> = {}) {
  return createApp({
    logger: silent,
    isShuttingDown: () => false,
    readinessChecks: { postgres: async () => {}, redis: async () => {} },
    ...overrides,
  });
}

describe("health endpoints", () => {
  it("GET /healthz returns ok without touching dependencies", async () => {
    const app = build({
      readinessChecks: {
        postgres: () => Promise.reject(new Error("down")),
      },
    });
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /readyz returns 200 when all dependencies are healthy", async () => {
    const res = await request(build()).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", checks: { postgres: "ok", redis: "ok" } });
  });

  it("GET /readyz returns 503 and names the failing dependency (failure path)", async () => {
    const app = build({
      readinessChecks: {
        postgres: async () => {},
        redis: () => Promise.reject(new Error("ECONNREFUSED 10.0.0.5:6379")),
      },
    });
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ postgres: "ok", redis: "fail" });
    // Internal hostnames/IPs must not leak.
    expect(JSON.stringify(res.body)).not.toContain("10.0.0.5");
  });

  it("GET /readyz fails a check that hangs past the timeout", async () => {
    const app = createApp({
      logger: silent,
      isShuttingDown: () => false,
      readinessChecks: { postgres: () => new Promise(() => {}) },
    });
    // The default timeout is 2 s; this test proves we don't hang forever.
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(503);
  }, 5000);

  it("GET /readyz returns 503 while draining for shutdown", async () => {
    const res = await request(build({ isShuttingDown: () => true })).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("shutting_down");
  });

  it("GET /metrics exposes Prometheus metrics", async () => {
    const app = build();
    await request(app).get("/healthz");
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.text).toContain("http_request_duration_seconds");
  });
});

describe("request ids", () => {
  it("echoes a well-formed upstream x-request-id", async () => {
    const res = await request(build()).get("/healthz").set("x-request-id", "req_abc12345");
    expect(res.headers["x-request-id"]).toBe("req_abc12345");
  });

  it("replaces a malformed or hostile x-request-id", () => {
    expect(resolveRequestId("bad id\nwith newline")).toMatch(/^req_[0-9a-f]{32}$/);
    expect(resolveRequestId(undefined)).toMatch(/^req_[0-9a-f]{32}$/);
    expect(resolveRequestId("x".repeat(200))).toMatch(/^req_/);
  });
});

describe("error envelope", () => {
  it("returns NOT_FOUND in the standard envelope for unknown routes", async () => {
    const res = await request(build()).get("/api/v1/does-not-exist");
    expect(res.status).toBe(404);
    expect(errorBodySchema.parse(res.body).error.code).toBe("NOT_FOUND");
    expect(res.body.error.request_id).toBe(res.headers["x-request-id"]);
  });

  it("returns VALIDATION_ERROR for malformed JSON (invalid input)", async () => {
    const res = await request(build())
      .post("/api/v1/anything")
      .set("content-type", "application/json")
      .send('{"amount_minor": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects oversized bodies with a safe VALIDATION_ERROR", async () => {
    const res = await request(build())
      .post("/api/v1/anything")
      .set("content-type", "application/json")
      .send(JSON.stringify({ pad: "x".repeat(200_000) }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("hides internals of unexpected errors behind INTERNAL_ERROR", async () => {
    const app = build();
    // Mount a throwing route before the 404 handler by building a wrapper app.
    const express = (await import("express")).default;
    const outer = express();
    outer.get("/boom", () => {
      throw new Error("SELECT * FROM users WHERE password_hash = 'secret'");
    });
    outer.use(app);
    const { errorHandler } = await import("../src/middleware/error-handler.js");
    outer.use(errorHandler(silent));

    const res = await request(outer).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|password|stack/i);
  });

  it("AppError carries the catalog status", () => {
    expect(new AppError("INSUFFICIENT_FUNDS", "x").status).toBe(422);
    expect(new AppError("REAUTH_REQUIRED", "x").status).toBe(401);
  });

  it("sets security headers and hides the framework", async () => {
    const res = await request(build()).get("/healthz");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
