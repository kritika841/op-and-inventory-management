import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests-browser",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:8000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
