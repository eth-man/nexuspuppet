import { expect, test, type APIRequestContext } from '@playwright/test';
import { apiLogin, assertStackReachable, login } from './support';

/**
 * The Integrations tab: audit forwarding (ADR-0016 §5, issue #94).
 *
 * The rules under test are the locked-card rules the ADR makes binding, and
 * the unlicensed rendering. The unlicensed assertions run everywhere —
 * including CI, which is core — because a disabled form is exactly what core
 * shows. The edit-flow assertions need the `audit.export` capability and
 * skip where the deployment does not advertise it, the same arrangement the
 * roles suite uses for `rbac.custom`.
 */

/** True when the deployment advertises `audit.export`, i.e. forwarding is editable. */
async function forwardingIsEditable(request: APIRequestContext): Promise<boolean> {
  await apiLogin(request);
  const response = await request.get('/api/capabilities');
  if (!response.ok()) return false;
  const body = (await response.json()) as { capabilities?: string[] };
  return body.capabilities?.includes('audit.export') === true;
}

test.describe('integrations tab', () => {
  test.beforeEach(async ({ request }) => {
    await assertStackReachable(request);
  });

  test('renders both transport cards with forwarding reported off', async ({ page }) => {
    await login(page);
    await page.goto('/settings/integrations');

    await expect(page.getByRole('heading', { name: 'Syslog' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Webhook' })).toBeVisible();

    // The status strip answers "do my records leave this box?" before any
    // card is read. A fresh deployment forwards nowhere.
    await expect(page.getByText('Audit forwarding is off')).toBeVisible();
  });

  test('the resting state is read-only', async ({ page }) => {
    await login(page);
    await page.goto('/settings/integrations');

    // Every input sits in a disabled fieldset until somebody presses Edit —
    // and in core, permanently. Either way, landing here can change nothing.
    await expect(page.getByLabel('Collector host')).toBeDisabled();
    await expect(page.getByLabel('Endpoint URL')).toBeDisabled();
  });

  test('the API refuses forwarding writes without touching the UI', async ({ request }) => {
    // The UI gate is cosmetic (CLAUDE.md: can() is never a security control).
    // What makes the disabled form honest is the API refusing the same write.
    await apiLogin(request);
    const response = await request.put('/api/settings/audit/forwarding', {
      data: { active: 'syslog' },
    });

    const editable = await forwardingIsEditable(request);
    if (editable) {
      // Entitled deployments refuse for a different reason: nothing stored.
      expect(response.status()).toBe(409);
    } else {
      expect(response.status()).toBe(501);
      const body = (await response.json()) as { capability?: string };
      expect(body.capability).toBe('audit.export');
    }
  });

  test('core names the capability instead of hiding the feature', async ({ page, request }) => {
    test.skip(await forwardingIsEditable(request), 'entitled deployment — nothing is grayed out');

    await login(page);
    await page.goto('/settings/integrations');

    // Disabled, not hidden, and it says which capability — the same name the
    // API's 501 carries. No Edit button anywhere: a row of live buttons under
    // a form nobody can use is the "configure a dead form" trap.
    await expect(page.getByText('audit.export')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit settings' })).toHaveCount(0);
  });

  test.describe('editing (needs audit.export)', () => {
    test('unlock, delta, and a cancel that restores what is stored', async ({ page, request }) => {
      test.skip(!(await forwardingIsEditable(request)), 'needs the audit.export capability');

      await login(page);
      await page.goto('/settings/integrations');

      const host = page.getByLabel('Collector host');
      await expect(host).toBeDisabled();

      // The syslog card's bar is the first — the cards render in a fixed order.
      await page.getByRole('button', { name: 'Edit settings' }).first().click();
      await expect(host).toBeEnabled();

      const before = await host.inputValue();
      await host.fill('changed.example.test');
      await page.getByLabel('Port').fill('6514');

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
