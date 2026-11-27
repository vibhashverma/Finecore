import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const valid = {
  DATABASE_URL: "postgres://app:placeholder@localhost:5432/fincore",
  REDIS_URL: "redis://localhost:6379",
};

describe("loadConfig", () => {
  it("parses a valid environment and applies defaults", () => {
    const cfg = loadConfig(valid);
    expect(cfg.API_PORT).toBe(4000);
    expect(cfg.APP_ENV).toBe("development");
  });

  it("fails fast on missing values without echoing secret values", () => {
    const env = { DATABASE_URL: "not a url with s3cr3t", REDIS_URL: valid.REDIS_URL };
    expect(() => loadConfig(env)).toThrowError(/DATABASE_URL/);
    try {
      loadConfig(env);
    } catch (e) {
      expect((e as Error).message).not.toContain("s3cr3t");
    }
  });

  it("rejects an out-of-range port", () => {
    expect(() => loadConfig({ ...valid, API_PORT: "70000" })).toThrowError(/API_PORT/);
  });
});
