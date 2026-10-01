import { expect, test, type APIRequestContext } from '@playwright/test';
import { apiLogin, assertStackReachable, login } from './support';

/**
 * The OIDC settings card on Settings → Directory (issue #106).
 *
 * Keyed on CONFIGURATION, not on an edition (ADR-0027). The form exists when
 * an OIDC provider is running — registered at boot because OIDC_ISSUER is set
 * — and the API reports that as `liveReload` on the settings view. Without
 * one the card is a header saying how to enable it, and that is asserted
 * wherever OIDC is not configured, which includes CI.
 */

async function oidcRunning(request: APIRequestContext): Promise<boolean> {
  await apiLogin(request);
  const response = await request.get('/api/settings/auth/oidc');
  if (!response.ok()) return false;
  const body = (await response.json()) as { liveReload?: boolean };
  return body.liveReload === true;
}

test.describe('OIDC settings card', () => {
  test.beforeEach(async ({ request }) => {
    await assertStackReachable(request);
  });

  test('renders on the Directory tab', async ({ page, request }) => {
    test.skip(!(await oidcRunning(request)), 'without OIDC_ISSUER the card is a header alone');

    await login(page);
    await page.goto('/settings/auth');

    await expect(page.getByRole('heading', { name: 'Identity provider' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Claims' })).toBeVisible();
  });

  test('the resting state is read-only', async ({ page, request }) => {
    // Only meaningful where the form exists; the header-only case is asserted
    // by 'says how to enable it and renders no unusable form' below.
    test.skip(!(await oidcRunning(request)), 'without OIDC_ISSUER there is no form to disable');

    await login(page);
    await page.goto('/settings/auth');

    // Matched by ACCESSIBLE NAME, not label text: a required field renders an
    // aria-hidden marker inside its <label>, so label-text matching sees
    // "Issuer ✱" and finds nothing.
    //
    // Locked until somebody presses Edit. Landing on the screen that decides
    // who can sign in must change nothing.
    await expect(page.getByRole('textbox', { name: 'Issuer' })).toBeDisabled();
    await expect(page.getByRole('textbox', { name: 'Client ID' })).toBeDisabled();
  });

  test('the secret field is empty and never carries a stored value', async ({ page, request }) => {
    test.skip(!(await oidcRunning(request)), 'without OIDC_ISSUER there is no field to inspect');

    await login(page);
    await page.goto('/settings/auth');

    // The API does not return it, so there is nothing to render. A masked
    // placeholder would leak its length and tempt the form into sending it back.
    await expect(page.getByLabel('Client secret', { exact: true })).toHaveValue('');
  });

  test('the API refuses OIDC writes independently of the UI', async ({ request }) => {
    // The disabled form is an affordance; this is the control (ADR-0006).
    await apiLogin(request);
    const response = await request.put('/api/settings/auth/oidc', {
      data: { issuer: 'https://idp.example.test', clientId: 'x', redirectUri: 'https://a.test/cb' },
    });

    // The settings route answers whether or not a provider is running — the
    // store is independent of registration (ADR-0016) — so what must NOT
    // happen is a 5xx. There is no 501 any more: nothing is unlicensed.
    expect([200, 400]).toContain(response.status());
  });

  test('says how to enable it and renders no unusable form', async ({ page, request }) => {
    test.skip(await oidcRunning(request), 'OIDC is configured — the form is real');

    await login(page);
    await page.goto('/settings/auth');

    // What is missing is configuration, and the card names it.
    await expect(page.getByText('Set OIDC_ISSUER', { exact: false })).toBeVisible();

    // Gone, not disabled — see integrations.spec.ts for why that distinction
    // is what makes this assertion able to fail. By role: `Issuer` also
    // matches the InfoHint button "About the issuer" under substring matching.
    await expect(page.getByRole('textbox', { name: 'Issuer' })).toHaveCount(0);
  });

  test.describe('editing (needs OIDC configured)', () => {
    test('unlock, delta, and a cancel that restores what is stored', async ({ page, request }) => {
      test.skip(!(await oidcRunning(request)), 'needs OIDC_ISSUER');

      await login(page);
      await page.goto('/settings/auth');

      const issuer = page.getByRole('textbox', { name: 'Issuer' });
      await expect(issuer).toBeDisabled();

      await page.getByRole('button', { name: 'Edit settings' }).last().click();
      await expect(issuer).toBeEnabled();

      const before = await issuer.inputValue();
      await issuer.fill('https://changed.example.test');

      // Nothing commits without stating what it changes (ADR-0016 §7).
      await expect(page.getByText('Pending changes')).toBeVisible();

      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(issuer).toBeDisabled();
      await expect(issuer).toHaveValue(before);
    });
  });
});
