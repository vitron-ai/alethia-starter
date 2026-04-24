// Playwright config used only by the benchmark harness. Pointed at the
// Anvil demo app served on 127.0.0.1:5173. Headless, single worker, no
// retries — we're measuring fresh per-iteration wall time, not suite
// reliability. The compare.mjs harness spins up the server + calls
// playwright test once per iteration and parses JSON output.

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './playwright-flows',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: 'json',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    headless: true,
    // No trace, no video, no screenshots on failure — all of those are
    // useful for debugging but they inflate the timing we're measuring
    // and skew Playwright's numbers against itself. Benchmark is about
    // raw step-execution cost.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    actionTimeout: 10_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
