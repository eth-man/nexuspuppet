import { expect, test, type Page } from '@playwright/test';
import { assertStackReachable } from './support';

/**
 * What the login screen offers, for every shape `/auth/mode` can answer with
 * (ADR-0023 §3).
 *
 * STUBBED, and it has to be. The rendering under test depends on which
 * providers a deployment registered, and CI is core — it has exactly one, so a
 * real stack can only ever exercise the single-source case. That is precisely
 * how the previous version shipped: it drew an SSO button only for a
 * `redirect` answer, the endpoint could never give one, and nothing noticed
 * because nothing could produce the input.
 *
 * These intercept the endpoint rather than reconfigure the stack, so the page
 * is tested against every answer it will ever see, in any edition.
 */

interface Source {
  source: string;
  mode: 'credentials' | 'redirect';
  identifierLabel: string;
}

const LOCAL: Source = { source: 'local', mode: 'credentials', identifierLabel: 'Email' };
const LDAP: Source = { source: 'ldap', mode: 'credentials', identifierLabel: 'Username' };
const OIDC: Source = { source: 'oidc', mode: 'redirect', identifierLabel: 'Email' };

/**
 * Matched by PREDICATE, not by glob.
 *
 * A glob is resolved against the config's `baseURL`, and a pattern that misses
 * fails silently — the real endpoint answers, the page renders the deployment's
 * own single source, and an assertion written for that shape passes for the
 * wrong reason. Which is exactly what happened while writing these.
 *
 * The hit counter exists for the same reason: a stub that never fires must fail
 * loudly rather than quietly hand the test a real answer.
 */
async function loginPageWith(page: Page, sources: Source[]): Promise<() => number> {
  let hits = 0;

  await page.route(
    (url) => url.pathname === '/api/auth/mode',
    (route) => {
      hits += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sources }),
      });
    },
  );

  await page.goto('/login');
  return () => hits;
}

const passwordField = (page: Page) => page.getByLabel('Password', { exact: true });

test.describe('the login screen', () => {
  test.beforeAll(async ({ request }) => {
    await assertStackReachable(request);
  });

  test('offers a password form when every source takes credentials', async ({ page }) => {
    const hits = await loginPageWith(page, [LDAP, LOCAL]);

    /*
     * If the stub never fired, everything below is asserting the real
     * deployment's shape and proves nothing.
     *
     * POLLED, not read once. `goto` resolves on load; the page fetches this
     * after hydration, so a bare read is a race that reports 0 on a fast
     * machine and passes on a slow one. Every other assertion here retries,
     * which is why this was the only one that failed.
     */
    await expect.poll(() => hits()).toBeGreaterThan(0);
    await expect(passwordField(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Continue with/ })).toHaveCount(0);
  });

  /*
   * The case this ticket exists for, and the one that was impossible before:
   * a form AND a button, not one or the other. A deployment running SSO still
   * has local accounts (ADR-0015), and an administrator locked out by a broken
   * IdP needs the form that was previously replaced by the button.
   */
  test('offers the form AND the SSO button together', async ({ page }) => {
    await loginPageWith(page, [LOCAL, OIDC]);

    await expect(passwordField(page)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Continue with oidc' })).toBeVisible();
  });

  test('offers only buttons when nothing takes credentials', async ({ page }) => {
    await loginPageWith(page, [OIDC]);

    await expect(page.getByRole('link', { name: 'Continue with oidc' })).toBeVisible();
    await expect(passwordField(page)).toHaveCount(0);
  });

  /*
   * The identifier label is the directory's, not local's. A form labelled
   * "Email" in front of a directory expecting sAMAccountName tells every user
   * to type the wrong thing — and local is the source whose users least need
   * telling.
   */
  test('labels the identifier the way the directory expects', async ({ page }) => {
    await loginPageWith(page, [LDAP, LOCAL]);

    await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
  });

  test('says so rather than rendering an empty card when there is nothing to offer', async ({
    page,
  }) => {
    await loginPageWith(page, []);

    // Filtered: the API-unreachable banner is also role="alert", and an
    // unfiltered query resolves to two elements and fails on strict mode
    // rather than on the thing under test.
    await expect(page.getByRole('alert').filter({ hasText: 'no way to sign in' })).toBeVisible();
    await expect(passwordField(page)).toHaveCount(0);
  });

  /*
   * A refusal must read identically whichever source refused it. The resolver
   * pads timing for the same reason (ADR-0015 §2); a login screen that names
   * the source in its error would hand back the map the padding hides.
   */
  test('refuses without naming which source refused', async ({ page }) => {
    await loginPageWith(page, [LDAP, LOCAL]);

    await page.getByLabel('Username', { exact: true }).fill('nobody@corp.invalid');
    await passwordField(page).fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    /*
     * Exact text, not "contains" plus two negatives. `toHaveText` proves the
     * message says that and NOTHING else — a source name appended to it would
     * fail, and so would any other embellishment somebody adds later.
     */
    await expect(page.getByRole('alert').filter({ hasText: 'Invalid' })).toHaveText(
      'Invalid email or password.',
    );
  });
});
