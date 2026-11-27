import { defineConfig, devices } from "@playwright/test";

/** E2E against the real stack (e2e/stack.ts) + `next start`. Run `pnpm build` first. */
export default defineConfig({
  testDir: "e2e",
  testIgnore: /demo.spec.ts/, // the recorded walkthrough runs via playwright.demo.config.ts
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3300",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
  webServer: [
    {
      command: "npx tsx e2e/stack.ts",
      url: "http://127.0.0.1:4400/readyz",
      timeout: 240_000,
      reuseExistingServer: false,
      stdout: "pipe",
    },
    {
      command: "npx next start -p 3300 -H 127.0.0.1",
      url: "http://127.0.0.1:3300/healthz",
      timeout: 120_000,
      reuseExistingServer: false,
      env: { API_INTERNAL_URL: "http://127.0.0.1:4400" },
    },
  ],
});
