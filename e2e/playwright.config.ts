import { defineConfig } from "@playwright/test";

// The suite drives the Docker container defined in docker-compose.test.yml.
// Each spec resets that environment in its beforeAll (see helpers.resetEnv),
// so specs must run one at a time.
//
// Set CHROMIUM_BIN to use a system Chromium instead of Playwright's download
// (useful on NixOS or minimal CI runners).
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  fullyParallel: false,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8199",
    viewport: { width: 1280, height: 950 },
    launchOptions: {
      args: ["--no-sandbox"],
      ...(process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}),
    },
  },
});
