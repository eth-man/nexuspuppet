import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, assertStackReachable, login } from './support';

/**
 * Authentication (ADR-0006).
 *
 * The regressions worth catching here are the ones that typecheck cleanly: a
 * disabled submit button, a session cookie that never reaches the browser, a
 * refresh path that 404s because a cookie was scoped to the wrong prefix.
 */
test.describe('authentication', () => {
  test.beforeAll(async ({ request }) => {
    await assertStackReachable(request);
  });

  test('signs in and lands on the dashboard', async ({ page }) => {
    await login(page);

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    // Scoped to the sidebar: "Nodes" also appears as a dashboard link and a
    // table caption, and an unscoped role query matches all three.
    //
    // The sidebar only renders navigation the session's permissions allow, so
    // its presence is evidence the principal actually loaded.
    await expect(
      page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: 'Nodes', exact: true }),
    ).toBeVisible();
  });

  /**
   * The login button was once permanently disabled because the page never
   * hydrated: it renders disabled until the session check resolves. Asserting
   * it becomes enabled catches a whole class of client-boot failure that
   * returns HTTP 200 and looks fine to any server-side check.
   */
  test('enables the submit button once the session check resolves', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled({ timeout: 15_000 });
  });

  test('rejects a wrong password without revealing whether the account exists', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(ADMIN_EMAIL);
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Scoped to the form: Next injects its own role="alert" route announcer
    // into every page, so an unscoped alert query is always ambiguous.
    const alert = page.locator('form').getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText('Invalid email or password.');
    await expect(page).toHaveURL(/\/login$/);
  });

  /**
   * The message for an unknown account must be identical to the one for a wrong
   * password. Any difference turns login into a user-enumeration oracle, and
   * the difference is easy to reintroduce while "improving" an error message.
   */
  test('gives an unknown account the same message as a wrong password', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('definitely-nobody@example.com');
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.locator('form').getByRole('alert')).toHaveText('Invalid email or password.');
  });

  test('sends an unauthenticated visitor to the login screen', async ({ page }) => {
    await page.goto('/nodes');
    await expect(page).toHaveURL(/\/login$/);
  });

  /**
   * Session cookies must be HttpOnly, or an XSS can exfiltrate them. The
   * refresh cookie must be scoped under the proxy prefix, or refresh silently
   * fails and every session dies at the access-token expiry.
   */
  test('issues HttpOnly cookies with the refresh token scoped to the proxy', async ({
    page,
    context,
  }) => {
    await login(page);

    const cookies = await context.cookies();
    const access = cookies.find((c) => c.name === 'nexuspuppet_access');
    const refresh = cookies.find((c) => c.name === 'nexuspuppet_refresh');

    expect(access?.httpOnly, 'access cookie must be HttpOnly').toBe(true);
    expect(refresh?.httpOnly, 'refresh cookie must be HttpOnly').toBe(true);
    expect(access?.path).toBe('/');
    expect(refresh?.path, 'refresh must be scoped under the API proxy prefix').toBe('/api/auth');
  });

  test('refreshes a session without re-authenticating', async ({ page }) => {
    await login(page);

    const response = await page.request.post('/api/auth/refresh');
    expect(response.status()).toBe(201);

    // Still authenticated afterwards, which a broken rotation would break.
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  /**
   * The session survives the access token expiring.
   *
   * The test above proves `/auth/refresh` works when something calls it. Nothing
   * proved the client ever does — and it did not. The access cookie carries
   * `expires` equal to the token lifetime, so the browser deletes it on expiry
   * and the next request arrives with no token at all; the guard answers a bare
   * 401 and the client only refreshed on the API's `TOKEN_EXPIRED` code, which
   * requires a token to have been presented. Operators were returned to the
   * login screen every access-token lifetime, holding a refresh cookie good for
   * another thirty days.
   *
   * Deleting the access cookie is exactly what the browser does at expiry, and
   * takes a second instead of an hour. The refresh cookie is left alone, because
   * that asymmetry IS the bug.
   */
  test('stays signed in when the access token expires', async ({ page, context }) => {
    await login(page);

    const remaining = (await context.cookies()).filter((c) => c.name !== 'nexuspuppet_access');
    await context.clearCookies();
    await context.addCookies(remaining);

    await page.goto('/nodes');

    // Still inside the console, and never sent back to sign in.
    await expect(page).not.toHaveURL(/\/login/);
    await expect(
      page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: 'Nodes', exact: true }),
    ).toBeVisible();

    // The recovery must be silent. An operator who sees an error banner has
    // still had their work interrupted, even if the next click succeeds.
    await expect(page.getByText(/authentication required/i)).toBeHidden();
  });

  test('gives up honestly when the refresh token is gone too', async ({ page, context }) => {
    // The other side of the same change: refreshing on ANY 401 must not turn a
    // genuinely ended session into a retry loop.
    await login(page);
    await context.clearCookies();

    await page.goto('/nodes');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('signs out and blocks the protected area again', async ({ page }) => {
    await login(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.goto('/nodes');
    await expect(page).toHaveURL(/\/login$/);
  });
});
