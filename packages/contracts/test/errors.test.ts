import { describe, expect, it } from "vitest";
import { ERROR_CATALOG, errorBodySchema, httpStatusFor } from "../src/index.js";

describe("error catalog", () => {
  it("maps every code required by the brief to its HTTP status", () => {
    expect(ERROR_CATALOG).toEqual({
      VALIDATION_ERROR: 400,
      UNAUTHENTICATED: 401,
      REAUTH_REQUIRED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      INVALID_STATE_TRANSITION: 409,
      IDEMPOTENCY_KEY_REUSED: 422,
      INSUFFICIENT_FUNDS: 422,
      LIMIT_EXCEEDED: 422,
      RATE_LIMITED: 429,
      INTERNAL_ERROR: 500,
      UPSTREAM_UNAVAILABLE: 503,
    });
    expect(httpStatusFor("INSUFFICIENT_FUNDS")).toBe(422);
  });

  it("rejects an error body with an unknown code", () => {
    const result = errorBodySchema.safeParse({
      error: { code: "TEAPOT", message: "x", request_id: "req_1" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a well-formed error body", () => {
    const result = errorBodySchema.safeParse({
      error: { code: "NOT_FOUND", message: "Not found", request_id: "req_1" },
    });
    expect(result.success).toBe(true);
  });
});
