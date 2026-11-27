import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

/** Records the product walkthrough (e2e/demo.spec.ts) as a 1280×720 video against the real stack. */
export default defineConfig({
  ...base,
  testMatch: /demo\.spec\.ts/,
  testIgnore: [],
  grep: /@demo/,
  reporter: [["list"]],
  projects: [
    {
      name: "demo",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
        video: { mode: "on", size: { width: 1280, height: 720 } },
        launchOptions: { slowMo: 120 },
      },
    },
  ],
});
