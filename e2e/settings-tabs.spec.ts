import { expect, test } from '@playwright/test';
import { assertStackReachable, login } from './support';

/**
 * Settings is a set of addresses, not a page with internal state (issue #72).
 *
 * The tests that matter here are the ones a `useState` tab bar would fail:
 * reload, deep link, and back. Those are the reasons for using routes at all,
 * so they are what gets asserted.
 */
test.describe('settings tabs', () => {
  test.beforeEach(async ({ request }) => {
    await assertStackReachable(request);
  });

  test('/settings lands on General', async ({ page }) => {
    await login(page);
    await page.goto('/settings');

    await expect(page).toHaveURL(/\/settings\/general$/);
    await expect(page.getByRole('link', { name: 'General' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('a tab survives a reload', async ({ page }) => {
    await login(page);
    await page.goto('/settings/auth');
    await expect(page.getByText('Directory (LDAP)')).toBeVisible();

    await page.reload();

    // The failure this catches: a tab bar holding its selection in component
    // state comes back on the first tab and the operator loses their place.
    await expect(page).toHaveURL(/\/settings\/auth$/);
    await expect(page.getByText('Directory (LDAP)')).toBeVisible();
  });

  test('back returns to the previous tab', async ({ page }) => {
    await login(page);
    await page.goto('/settings/general');
    await page.getByRole('link', { name: 'Users & Roles' }).click();
    await expect(page).toHaveURL(/\/settings\/users$/);

    await page.goBack();

    await expect(page).toHaveURL(/\/settings\/general$/);
  });

  test('a tab is linkable on its own', async ({ page }) => {
    await login(page);
    // Straight to the address, no navigation through the bar first.
    await page.goto('/settings/users');

    await expect(page.getByRole('link', { name: 'Users & Roles' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('every tab renders something, so none is a dead end', async ({ page }) => {
    await login(page);

    for (const slug of ['general', 'auth', 'integrations', 'notifications', 'users']) {
      await page.goto(`/settings/${slug}`);
      // Not a blank page and not the app's error boundary.
      await expect(page.locator('main')).not.toBeEmpty();
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    }
  });

  /**
   * The palette regression that prompted the token split.
   *
   * `--color-accent` and `--color-state-changed` were the same value, so the
   * colour meaning "this node changed" was also the colour meaning "this is
   * clickable". They must stay apart; this is the test that says so, because
   * the two definitions sit four lines apart and look like a duplicate.
   */
  test('the interactive accent is not the changed-status blue', async ({ page }) => {
    await login(page);
    await page.goto('/settings/general');

    const { accent, changed } = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        accent: style.getPropertyValue('--color-accent-interactive').trim(),
        changed: style.getPropertyValue('--color-state-changed').trim(),
      };
    });

    expect(accent).not.toBe('');
    expect(changed).not.toBe('');
    expect(accent).not.toBe(changed);
  });
});
