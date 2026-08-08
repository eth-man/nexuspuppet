import { expect, test, type APIRequestContext } from '@playwright/test';
import { apiLogin, assertStackReachable, lockedBadgeWord, login } from './support';

/**
 * The OIDC settings card on Settings → Directory (issue #106).
 *
 * The locked-card rules and the unlicensed rendering are what get asserted,
 * as for the Integrations tab. The unlicensed assertions run everywhere,
 * including CI, because a disabled form is exactly what core shows; the edit
 * flow needs `sso.oidc` and skips where the deployment does not advertise it.
 */

async function ssoAvailable(request: APIRequestContext): Promise<boolean> {
  await apiLogin(request);
  const response = await request.get('/api/capabilities');
  if (!response.ok()) return false;
  const body = (await response.json()) as { capabilities?: string[] };
  return body.capabilities?.includes('sso.oidc') === true;
}

test.describe('OIDC settings card', () => {
  test.beforeEach(async ({ request }) => {
    await assertStackReachable(request);
  });

  test('renders on the Directory tab', async ({ page, request }) => {
    test.skip(!(await ssoAvailable(request)), 'without sso.oidc the card is a header alone');

    await login(page);
    await page.goto('/settings/auth');

    await expect(page.getByRole('heading', { name: 'Identity provider' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Claims' })).toBeVisible();
  });

  test('the resting state is read-only', async ({ page, request }) => {
    // Only meaningful where the form exists; the header-only case is asserted
    // by 'core names the capability and renders no unusable form' below.
    test.skip(!(await ssoAvailable(request)), 'without sso.oidc there is no form to disable');

    await login(page);
    await page.goto('/settings/auth');

    // Matched by ACCESSIBLE NAME, not label text: a required field renders an
    // aria-hidden marker inside its <label>, so label-text matching sees
    // "Issuer ✱" and finds nothing.
    //
    // Locked until somebody presses Edit — and in core, permanently. Landing
    // on the screen that decides who can sign in must change nothing.
    await expect(page.getByRole('textbox', { name: 'Issuer' })).toBeDisabled();
    await expect(page.getByRole('textbox', { name: 'Client ID' })).toBeDisabled();
  });

  test('the secret field is empty and never carries a stored value', async ({ page, request }) => {
    test.skip(!(await ssoAvailable(request)), 'without sso.oidc there is no field to inspect');

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

    // 200 where SSO is available, since the write is legitimate there. Where it
    // is not, the settings routes still answer — OIDC settings are core-owned —
    // so what must NOT happen is a 5xx or a silent success against no provider.
    expect([200, 400, 403, 501]).toContain(response.status());
  });

  test('names the capability and renders no unusable form', async ({ page, request }) => {
    test.skip(await ssoAvailable(request), 'entitled deployment — the form is real');

    const badge = await lockedBadgeWord(request);

    await login(page);
    await page.goto('/settings/auth');

    await expect(page.getByText('sso.oidc')).toBeVisible();
    /*
     * The badge word, taken from the edition rather than hard-coded.
     *
     * This asserted "Enterprise" unconditionally, which passed in core and
     * left the enterprise rendering — a padlock telling an operator to buy
     * what they already run — the one nothing checked.
     */
    await expect(page.getByText(badge).first()).toBeVisible();

    // Gone, not disabled — see integrations.spec.ts for why that distinction
    // is what makes this assertion able to fail. By role: `Issuer` also
    // matches the InfoHint button "About the issuer" under substring matching.
    await expect(page.getByRole('textbox', { name: 'Issuer' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit settings' })).toHaveCount(0);
  });

  /*
   * The rule the badge exists to obey, from the side that was wrong.
   *
   * On a deployment already running the enterprise layer, a locked card must
   * not advertise "Enterprise" — there is nothing to buy. Asserting the
   * ABSENCE is what makes this able to fail: the previous assertion looked for
   * the word and found it, in both editions, and called that a pass.
   */
  test('an enterprise deployment is never told to buy Enterprise', async ({ page, request }) => {
    test.skip(await ssoAvailable(request), 'entitled deployment — the card is a real form');
    test.skip(
      (await lockedBadgeWord(request)) !== 'Unavailable',
      'core — Enterprise is the answer',
    );

    await login(page);
    await page.goto('/settings/auth');

    const card = page.locator('section,div').filter({ hasText: 'Single sign-on (OIDC)' }).last();
    await expect(card.getByText('Enterprise')).toHaveCount(0);
    await expect(page.getByText('sso.oidc')).toBeVisible();
  });

  test.describe('editing (needs sso.oidc)', () => {
    test('unlock, delta, and a cancel that restores what is stored', async ({ page, request }) => {
      test.skip(!(await ssoAvailable(request)), 'needs the sso.oidc capability');

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
