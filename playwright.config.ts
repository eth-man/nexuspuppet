import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests for the console.
 *
 * These run against a RUNNING stack — `npm run dev:stack` — rather than
 * spinning one up per invocation. The stack is three processes plus Postgres,
 * and a `webServer` block that starts them would make a failed test
 * indistinguishable from a failed boot.
 *
 * The suite is deliberately thin on assertions about styling and thick on
 * assertions about BEHAVIOUR that would silently break when real PuppetDB data
 * replaces the fixtures: does login work, does the inventory render rows, does a
 * classification write actually answer 202 and queue materialization.
 */

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:3000';

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.results',
  fullyParallel: false,
  /**
   * Serial, single worker. The write tests mutate shared classification state,
   * and a parallel run would have one test's full reconcile racing another's
   * assertions about queue scope. Correctness over wall-clock on a suite this
   * size.
   */
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] === undefined ? 0 : 1,
  reporter: process.env['CI'] === undefined ? [['list']] : [['list'], ['github']],

  expect: {
    // The console writes are asynchronous by design (ADR-0003), so assertions
    // about materialization need room without being flaky.
    timeout: 10_000,
  },
  timeout: 60_000,

  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // Local runs reuse a cached browser whose revision predates this driver.
    // CI installs its own and leaves this unset.
    launchOptions:
      process.env['PLAYWRIGHT_CHROMIUM_PATH'] === undefined
        ? {}
        : { executablePath: process.env['PLAYWRIGHT_CHROMIUM_PATH'] },
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
