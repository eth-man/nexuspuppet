import { existsSync, readFileSync } from 'node:fs';
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

/**
 * Load .env if it is there, WITHOUT overriding anything already set.
 *
 * Credentials are rotated by scripts/dev/rotate-admin-password.mjs, which
 * writes E2E_ADMIN_PASSWORD into .env. Playwright does not read .env on its
 * own, so without this a rotation silently breaks every test that logs in.
 * Real environment variables still win, which is what CI relies on.
 */
function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match?.[1] === undefined) continue;
    if (process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = (match[2] ?? '').trim().replace(/^["']|["']$/g, '');
  }
}

loadDotEnv();

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
