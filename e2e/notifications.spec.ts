import { expect, test } from '@playwright/test';
import { assertStackReachable, login } from './support';

/**
 * The Notifications tab: where operational conditions are routed (ADR-0021).
 *
 * This suite exists because the tab shipped as a stub reading "This deployment
 * does not send notifications" — written before ADR-0021 and left standing
 * after it. Delivery worked, and was configured one tab away under
 * Integrations, so the single screen named after the feature was the one place
 * that denied it existed. Nothing failed; nothing was covering it.
 *
 * So the first test here is the one that would have caught it: the panels are
 * on THIS tab. Neither needs configuration to render, so all of this runs
 * everywhere.
 */

test.describe('the Notifications tab', () => {
  test.beforeEach(async ({ request }) => {
    await assertStackReachable(request);
  });

  test('routes conditions from the tab named after them, not from Integrations', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/settings/notifications');

    await expect(page.getByRole('heading', { name: 'Notification webhook' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Notification email' })).toBeVisible();
  });

  /*
   * The other half of the same boundary: audit forwarding carries RECORDS;
   * these carry CONDITIONS. Two
   * destinations that look alike and are not, so neither tab may quietly
   * acquire the other's cards.
   */
  test('leaves audit forwarding on Integrations', async ({ page }) => {
    await login(page);
    await page.goto('/settings/notifications');

    await expect(page.getByRole('heading', { name: 'Syslog' })).toHaveCount(0);

    await page.goto('/settings/integrations');
    await expect(page.getByRole('heading', { name: 'Notification webhook' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Notification email' })).toHaveCount(0);
  });
});

/**
 * The notification webhook (ADR-0021 §4).
 *
 * A SEPARATE destination from the audit webhook on Integrations.
 */
test.describe('the notification webhook', () => {
  test('is offered, and says it is not the audit webhook', async ({ page }) => {
    await login(page);
    await page.goto('/settings/notifications');

    await expect(page.getByRole('heading', { name: 'Notification webhook' })).toBeVisible();
    // The distinction that keeps the boundary legible on screen.
    await expect(page.getByText('never audit records')).toBeVisible();
  });

  test('the endpoint field is locked until Edit is pressed', async ({ page }) => {
    await login(page);
    await page.goto('/settings/notifications');

    const url = page.getByRole('textbox', { name: 'Notification endpoint' });
    await expect(url).toBeDisabled();
  });
});

/**
 * The notification email relay (ADR-0021 §4).
 *
 * Like the webhook, it needs no configuration to render.
 */
test.describe('the notification email relay', () => {
  test('is offered, with one team recipient', async ({ page }) => {
    await login(page);
    await page.goto('/settings/notifications');

    await expect(page.getByRole('heading', { name: 'Notification email' })).toBeVisible();
    // One address, not per user — the bystander effect is why (ADR-0021 §5).
    await expect(page.getByText('One team address')).toBeVisible();
  });

  test('the relay host is locked until Edit is pressed', async ({ page }) => {
    await login(page);
    await page.goto('/settings/notifications');

    await expect(page.getByRole('textbox', { name: 'Relay host' })).toBeDisabled();
  });
});
