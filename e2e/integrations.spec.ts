import { expect, test } from '@playwright/test';
import { apiLogin, assertStackReachable, login } from './support';

/**
 * The Integrations tab: audit forwarding (ADR-0016 §5, issue #94).
 *
 * The rules under test are the locked-card rules the ADR makes binding. Every
 * deployment can forward (ADR-0027), so all of it runs everywhere — until
 * then the edit-flow assertions skipped without the `audit.export` capability,
 * which is how CI never exercised them.
 */

test.describe('integrations tab', () => {
  test.beforeEach(async ({ request }) => {
    await assertStackReachable(request);
  });

  test('renders both transport cards with forwarding reported off', async ({ page }) => {
    await login(page);
    await page.goto('/settings/integrations');

    await expect(page.getByRole('heading', { name: 'Syslog' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Webhook', exact: true })).toBeVisible();

    // The status strip answers "do my records leave this box?" before any
    // card is read. A fresh deployment forwards nowhere.
    await expect(page.getByText('Audit forwarding is off')).toBeVisible();
  });

  test('the resting state is read-only', async ({ page }) => {
    await login(page);
    await page.goto('/settings/integrations');

    // Every input sits in a disabled fieldset until somebody presses Edit, so
    // landing on this page can change nothing.
    await expect(page.getByRole('textbox', { name: 'Collector host' })).toBeDisabled();
    await expect(page.getByRole('textbox', { name: 'Endpoint URL' })).toBeDisabled();
  });

  test('the API refuses to activate a transport with nothing stored', async ({ request }) => {
    // The UI gate is cosmetic (CLAUDE.md: can() is never a security control).
    // The API has its own reason to refuse: there is nothing to switch to.
    await apiLogin(request);
    const response = await request.put('/api/settings/audit/forwarding', {
      data: { active: 'syslog' },
    });

    expect(response.status()).toBe(409);
  });

  test.describe('editing', () => {
    test('unlock, delta, and a cancel that restores what is stored', async ({ page }) => {
      await login(page);
      await page.goto('/settings/integrations');

      const host = page.getByLabel('Collector host');
      await expect(host).toBeDisabled();

      // The syslog card's bar is the first — the cards render in a fixed order.
      await page.getByRole('button', { name: 'Edit settings' }).first().click();
      await expect(host).toBeEnabled();

      const before = await host.inputValue();
      await host.fill('changed.example.test');
      await page.getByRole('textbox', { name: 'Port', exact: true }).fill('6514');

      // Nothing commits without stating what it changes (ADR-0016 §7).
      await expect(page.getByText('Pending changes')).toBeVisible();

      // Cancel restores what is stored, not what was typed — a cancel that
      // keeps the edits is a slower save.
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(host).toBeDisabled();
      await expect(host).toHaveValue(before);
    });
  });
});
