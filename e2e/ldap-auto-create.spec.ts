import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { apiLogin, assertStackReachable, login } from './support';

/**
 * Directory accounts created at first sign-in, and the label people sign in
 * with (ADR-0031), on Settings → Directory / Auth.
 *
 * Saved through the real API, as the console saves it. Anonymous bind, so no
 * secret needs storing — CI runs without CONFIG_ENCRYPTION_KEY — and a host
 * that cannot resolve: Save tries the connection, reports that it failed, and
 * saves anyway. Nobody signs in against it.
 *
 * Every locator is scoped to the LDAP region; the OIDC card beside it has a
 * "Role mappings" heading too.
 */

const ldap = (page: Page) => page.getByRole('region', { name: 'Directory (LDAP)' });
const AUTO_CREATE = 'Create accounts automatically for people in a mapped group';

async function withStoredLdap(
  request: APIRequestContext,
  autoCreateAccounts: boolean,
  run: () => Promise<void>,
): Promise<void> {
  await apiLogin(request);
  const before = (await (await request.get('/api/settings/auth/ldap')).json()) as {
    source: string;
  };
  test.skip(before.source === 'database', 'this deployment already stores an LDAP configuration');

  const saved = await request.put('/api/settings/auth/ldap', {
    data: {
      host: 'ldap.e2e.invalid',
      port: 636,
      protocol: 'ldaps',
      bindType: 'anonymous',
      searchBase: 'dc=e2e,dc=invalid',
      roleMappings: [{ groupDn: 'cn=puppet-ops,dc=e2e,dc=invalid', role: 'OPERATOR' }],
      autoCreateAccounts,
      timeoutMs: 2000,
    },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  try {
    await run();
  } finally {
    await request.delete('/api/settings/auth/ldap');
  }
}

test.describe('LDAP: accounts created at first sign-in', () => {
  test.beforeEach(async ({ request }) => {
    await assertStackReachable(request);
  });

  test('the setting round-trips through the API, and is off unless sent', async ({ request }) => {
    await withStoredLdap(request, true, async () => {
      const view = (await (await request.get('/api/settings/auth/ldap')).json()) as {
        config: { autoCreateAccounts?: boolean } | null;
      };
      expect(view.config?.autoCreateAccounts).toBe(true);
    });

    await withStoredLdap(request, false, async () => {
      const view = (await (await request.get('/api/settings/auth/ldap')).json()) as {
        config: { autoCreateAccounts?: boolean } | null;
      };
      expect(view.config?.autoCreateAccounts).toBe(false);
    });
  });

  test('the form shows the stored choice, locked until Edit, with what it means', async ({
    page,
    request,
  }) => {
    await login(page);
    await withStoredLdap(request, true, async () => {
      await page.goto('/settings/auth');

      const box = ldap(page).getByRole('checkbox', { name: new RegExp(AUTO_CREATE) });
      await expect(box).toBeChecked();
      // Locked at rest, like every other field on the screen that decides who
      // can sign in.
      await expect(box).toBeDisabled();
      await expect(
        ldap(page).getByText(/anyone who can sign in to the directory and is in a mapped group/),
      ).toBeVisible();

      await ldap(page).getByRole('button', { name: 'Edit settings' }).click();
      await expect(box).toBeEnabled();
      await box.uncheck();
      // Said in words before Save, because it changes what the mappings mean.
      await expect(
        page.getByText('Automatic account creation: on → off', { exact: false }),
      ).toBeVisible();
    });
  });

  test('with LDAP configured the login field asks for a username or email', async ({
    page,
    request,
  }) => {
    await withStoredLdap(request, false, async () => {
      const mode = (await (await request.get('/api/auth/mode')).json()) as {
        sources: Array<{ source: string; identifierLabel: string }>;
      };
      expect(mode.sources.find((s) => s.source === 'ldap')?.identifierLabel).toBe(
        'Username or email',
      );

      await page.context().clearCookies();
      await page.goto('/login');
      const field = page.getByLabel('Username or email', { exact: true });
      await expect(field).toBeVisible();
      // Plain text, so `jdoe` is not refused by the browser as no email.
      await expect(field).toHaveAttribute('type', 'text');
    });
  });
});
