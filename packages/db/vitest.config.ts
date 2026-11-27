import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // One real Postgres 16 cluster for the whole run (ADR-005).
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
