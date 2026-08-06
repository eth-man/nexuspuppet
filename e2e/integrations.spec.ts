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

  test('the resting state is read-only', async ({ page, request }) => {
    /*
     * Only meaningful where the form exists. Without `audit.export` there are
     * no inputs to be disabled — the cards render as a header alone, which the
     * "renders no unusable form" test below asserts directly.
     */
    test.skip(!(await forwardingIsEditable(request)), 'core renders no form to disable');

    await login(page);
    await page.goto('/settings/integrations');

    // Every input sits in a disabled fieldset until somebody presses Edit, so
    // landing on this page can change nothing.
    await expect(page.getByRole('textbox', { name: 'Collector host' })).toBeDisabled();
    await expect(page.getByRole('textbox', { name: 'Endpoint URL' })).toBeDisabled();
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

  test('core names the capability and renders no unusable form', async ({ page, request }) => {
    test.skip(await forwardingIsEditable(request), 'entitled deployment — the form is real');

    await login(page);
    await page.goto('/settings/integrations');

    // The feature is still NAMED and still says which capability unlocks it —
    // the same name the API's 501 carries.
    await expect(page.getByRole('heading', { name: 'Syslog' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Webhook' })).toBeVisible();
    // .first(): both cards name the capability now, which is the point — each
    // one explains itself rather than relying on a shared footnote.
    await expect(page.getByText('audit.export').first()).toBeVisible();
    await expect(page.getByText('Enterprise').first()).toBeVisible();

    /*
     * And the form itself is GONE, not merely disabled. This is the assertion
     * that can actually fail: the previous version rendered every input with
     * `disabled`, and `toBeDisabled()` would have passed just as happily
     * against a screen full of dead fields.
     *
     * By role, not by label — a required Field renders an aria-hidden marker
     * inside its <label>, so getByLabel does not match these inputs.
     */
    await expect(page.getByRole('textbox', { name: 'Collector host' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Endpoint URL' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit settings' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Test connection' })).toHaveCount(0);
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
      await page.getByRole('textbox', { name: 'Port' }).fill('6514');

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
