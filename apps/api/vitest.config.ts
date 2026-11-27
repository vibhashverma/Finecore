import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false, // one shared Postgres cluster; keeps concurrency assertions free of cross-file load
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts", "src/bootstrap.ts"],
      reporter: ["text-summary", "lcov"],
    },
  },
});
