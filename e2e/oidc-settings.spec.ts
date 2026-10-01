import { expect, test, type Page } from '@playwright/test';
import { apiLogin, assertStackReachable, login } from './support';

/**
 * The OIDC settings card on Settings → Directory / Auth (issue #106).
 *
 * Always a form since ADR-0029: the OIDC provider is registered on every
 * deployment, so SSO can be enabled from here with no OIDC_ISSUER and no
 * restart. With nothing configured the card is an empty state one click from
 * that form; with something configured it is the form, locked at rest.
 *
 * Every locator is scoped to the OIDC region. The LDAP card beside it has an
 * "Edit settings" button and a "Role mappings" heading too, and an unscoped
 * locator matches both.
 */

const sso = (page: Page) => page.getByRole('region', { name: 'Single sign-on (OIDC)' });

/** Show the form, through the empty state if that is what is there. */
async function openForm(page: Page): Promise<void> {
  await page.goto('/settings/auth');
  const region = sso(page);
  const cta = region.getByRole('button', { name: 'Configure single sign-on' });
  const issuer = region.getByRole('textbox', { name: 'Issuer' });
  await expect(cta.or(issuer).first()).toBeVisible();
  if ((await cta.count()) > 0) await cta.click();
  await expect(issuer).toBeVisible();
}

/**
 * A stored OIDC configuration for the duration of `run`, discarded afterwards.
 * No client secret: CI runs without CONFIG_ENCRYPTION_KEY, and a public
 * client is a valid configuration. Nothing contacts the issuer — saving does
 * not, and nobody signs in.
 */
async function withStoredSso(page: Page, run: () => Promise<void>): Promise<void> {
  const saved = await page.request.put('/api/settings/auth/oidc', {
    data: {
      issuer: 'https://idp.e2e.invalid/realms/e2e',
      clientId: 'nexuspuppet-e2e',
      redirectUri: 'https://console.e2e.invalid/api/auth/callback',
      scopes: ['profile', 'email'],
      emailClaim: 'email',
      displayNameClaim: 'name',
      groupsClaim: 'groups',
      roleMappings: [],
      timeoutMs: 10_000,
      clockSkewSeconds: 60,
    },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  try {
    await run();
  } finally {
    await page.request.delete('/api/settings/auth/oidc');
  }
}

test.describe('OIDC settings card', () => {
  test.beforeEach(async ({ request }) => {
    await assertStackReachable(request);
  });

  test('renders as a form on the Directory tab', async ({ page }) => {
    await login(page);
    await openForm(page);

    await expect(sso(page).getByRole('heading', { name: 'Identity provider' })).toBeVisible();
    await expect(sso(page).getByRole('heading', { name: 'Claims' })).toBeVisible();
  });

  test('with nothing configured, offers an empty state rather than a header to read', async ({
    page,
    request,
  }) => {
    await apiLogin(request);
    const view = (await (await request.get('/api/settings/auth/oidc')).json()) as {
      source: string;
    };
    test.skip(view.source !== 'unset', 'this deployment configures OIDC');

    await login(page);
    await page.goto('/settings/auth');

    await expect(sso(page).getByText('Not configured', { exact: true })).toBeVisible();
    await expect(
      sso(page).getByRole('heading', { name: 'No identity provider connected' }),
    ).toBeVisible();
    // The old card's instruction is gone: nothing here needs the environment.
    await expect(page.getByText('Set OIDC_ISSUER', { exact: false })).toHaveCount(0);

    await sso(page).getByRole('button', { name: 'Configure single sign-on' }).click();
    // Straight into an editable form: there is nothing yet to protect.
    await expect(sso(page).getByRole('textbox', { name: 'Issuer' })).toBeEditable();
  });

  test('the resting state is read-only', async ({ page }) => {
    await login(page);
    await withStoredSso(page, async () => {
      await page.goto('/settings/auth');

      // Matched by ACCESSIBLE NAME, not label text: a required field renders an
      // aria-hidden marker inside its <label>, so label-text matching sees
      // "Issuer ✱" and finds nothing.
      //
      // Locked until somebody presses Edit. Landing on the screen that decides
      // who can sign in must change nothing.
      await expect(sso(page).getByRole('textbox', { name: 'Issuer' })).toBeDisabled();
      await expect(sso(page).getByRole('textbox', { name: 'Client ID' })).toBeDisabled();
      await expect(sso(page).getByText('Saved in the console', { exact: true })).toBeVisible();
    });
  });

  test('the secret field is empty and never carries a stored value', async ({ page }) => {
    await login(page);
    await openForm(page);

    // The API does not return it, so there is nothing to render. A masked
    // placeholder would leak its length and tempt the form into sending it back.
    await expect(sso(page).getByLabel('Client secret', { exact: true })).toHaveValue('');
  });

  test('the API refuses an incomplete OIDC configuration independently of the UI', async ({
    request,
  }) => {
    // The form is an affordance; the API is the control (ADR-0006).
    await apiLogin(request);
    const response = await request.put('/api/settings/auth/oidc', {
      data: { issuer: 'https://idp.example.test', clientId: 'x', redirectUri: 'https://a.test/cb' },
    });

    expect(response.status()).toBe(400);
  });

  /*
   * Enabled from the console, it reaches the LOGIN PAGE with no restart, and
   * leaves it again when discarded (ADR-0029). The login page is read through
   * the same public endpoint it renders from.
   */
  test('saving puts SSO on the login page; discarding takes it off', async ({ page }) => {
    await login(page);

    const sources = async () =>
      (
        (await (await page.request.get('/api/auth/mode')).json()) as {
          sources: { source: string }[];
        }
      ).sources.map((s) => s.source);

    const before = await sources();
    await withStoredSso(page, async () => {
      expect(await sources()).toContain('oidc');
    });
    expect(await sources()).toEqual(before);
  });

  test.describe('editing', () => {
    test('unlock, delta, and a cancel that restores what is stored', async ({ page }) => {
      await login(page);
      await withStoredSso(page, async () => {
        await page.goto('/settings/auth');

        const issuer = sso(page).getByRole('textbox', { name: 'Issuer' });
        await expect(issuer).toBeDisabled();

        await sso(page).getByRole('button', { name: 'Edit settings' }).click();
        await expect(issuer).toBeEnabled();

        const before = await issuer.inputValue();
        await issuer.fill('https://changed.example.test');

        // Nothing commits without stating what it changes (ADR-0016 §7).
        await expect(sso(page).getByText('Pending changes')).toBeVisible();

        await sso(page).getByRole('button', { name: 'Cancel' }).click();
        await expect(issuer).toBeDisabled();
        await expect(issuer).toHaveValue(before);
      });
    });
  });
});
