import { defineConfig } from "@playwright/test";

// README screenshot pipeline — NOT part of `make e2e`.
//
//   cd e2e && npm run screenshots
//
// 01-stage.spec.ts resets the compose test environment (DESTROYS .testenv,
// like every e2e spec), seeds a realistic demo dataset through the real UI
// and API, then rewrites timestamps so charts and history span ~3 weeks.
// 02-capture.spec.ts screenshots every README view in dark + light into
// screenshots/raw/. scripts/compress-screenshots.sh turns those PNGs into
// the committed docs/screenshots/*.webp.
//
// Build the app image first so shots reflect HEAD:
//   docker compose -f docker-compose.test.yml build app
// Set CHROMIUM_BIN to use a system Chromium (NixOS or minimal CI runners).
export default defineConfig({
  testDir: ".",
  workers: 1,
  fullyParallel: false,
  timeout: 1_800_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8199",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    timezoneId: "UTC",
    locale: "en-US",
    colorScheme: "dark",
    launchOptions: {
      args: ["--no-sandbox"],
      ...(process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}),
    },
  },
});
