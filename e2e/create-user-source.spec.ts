import { expect, test, type Page } from '@playwright/test';
import { assertStackReachable, login } from './support';

/**
 * Which authority a new account belongs to (ADR-0023 §4).
 *
 * STUBBED for the same reason the login-screen suite is: CI is core, a real
 * stack there has exactly one source, and the behaviour under test only exists
 * when there are two or three. Nothing but a stub can produce that input.
 *
 * The rule is about the SHAPE of the mistakes, not convenience. Defaulting to a
 * directory and getting it wrong means somebody cannot sign in — noticed in
 * minutes. Defaulting to local and getting it wrong means a directory-managed
 * person holds a password-backed account that survives their offboarding.
 */

interface Source {
  source: string;
  mode: 'credentials' | 'redirect';
  identifierLabel: string;
}

const LOCAL: Source = { source: 'local', mode: 'credentials', identifierLabel: 'Email' };
const LDAP: Source = { source: 'ldap', mode: 'credentials', identifierLabel: 'Username' };
const OIDC: Source = { source: 'oidc', mode: 'redirect', identifierLabel: 'Email' };

/** Matched by predicate, not glob — a glob that misses fails silently. */
async function usersPageWith(page: Page, sources: Source[]): Promise<() => number> {
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

  await page.goto('/settings/users');
  await page.getByRole('button', { name: 'New user' }).click();
  return () => hits;
}

const sourceSelect = (page: Page) => page.getByLabel('Authentication', { exact: true });
const createButton = (page: Page) => page.getByRole('button', { name: 'Create user' });

test.describe('choosing a new user’s authentication source', () => {
  test.beforeAll(async ({ request }) => {
    await assertStackReachable(request);
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  /*
   * A select with one option is a control that cannot be operated. Core has
   * only local, so the dialog must look exactly as it always has.
   */
  test('offers no selector at all when local is the only source', async ({ page }) => {
    const hits = await usersPageWith(page, [LOCAL]);
    await expect.poll(() => hits()).toBeGreaterThan(0);

    await expect(sourceSelect(page)).toHaveCount(0);
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  });

  test('defaults to the directory when there is exactly one', async ({ page }) => {
    const hits = await usersPageWith(page, [LOCAL, LDAP]);
    await expect.poll(() => hits()).toBeGreaterThan(0);

    await expect(sourceSelect(page)).toHaveValue('ldap');
    // A directory account is given no password — a stored hash would keep it
    // usable through local auth after the directory revoked access.
    await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  });

  test('lets that default be overridden back to local', async ({ page }) => {
    const hits = await usersPageWith(page, [LOCAL, LDAP]);
    await expect.poll(() => hits()).toBeGreaterThan(0);

    await sourceSelect(page).selectOption('local');

    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(createButton(page)).toBeDisabled(); // no password typed yet
  });

  /*
   * THE CASE THE RULE EXISTS FOR. Between two directories neither is the safer
   * guess, so the dialog refuses to make one.
   */
  test('refuses to guess between two directories', async ({ page }) => {
    const hits = await usersPageWith(page, [LOCAL, LDAP, OIDC]);
    await expect.poll(() => hits()).toBeGreaterThan(0);

    await expect(sourceSelect(page)).toHaveValue('');
    await expect(createButton(page)).toBeDisabled();

    // And every source is on offer, not just the first two.
    await expect(sourceSelect(page).getByRole('option')).toContainText([
      'Choose…',
      'local (password)',
      'ldap',
      'oidc',
    ]);
  });

  test('accepts the form once one of the two is chosen', async ({ page }) => {
    const hits = await usersPageWith(page, [LOCAL, LDAP, OIDC]);
    await expect.poll(() => hits()).toBeGreaterThan(0);

    await page.getByLabel('Email', { exact: true }).fill('someone@corp.invalid');
    await page.getByLabel('Display name', { exact: true }).fill('Someone');
    await sourceSelect(page).selectOption('oidc');

    await expect(createButton(page)).toBeEnabled();
  });
});
