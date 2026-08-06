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

    /*
     * The TAB, not the card inside it.
     *
     * This asserted a card title — "Directory (LDAP)" — which made a test about
     * tab routing fail whenever the directory screen was redesigned, and which
     * cannot be edition-independent: core shows a teaser there, enterprise
     * shows a form, and the two share no heading. `aria-current` is what the
     * tab bar actually promises, and it is what the sibling test below already
     * checks.
     */
    const tab = page.getByRole('link', { name: 'Directory / Auth' });
    await expect(tab).toHaveAttribute('aria-current', 'page');

    await page.reload();

    // The failure this catches: a tab bar holding its selection in component
    // state comes back on the first tab and the operator loses their place.
    await expect(page).toHaveURL(/\/settings\/auth$/);
    await expect(tab).toHaveAttribute('aria-current', 'page');
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

/**
 * The update check reports the version that is RUNNING.
 *
 * Untested until now, which is how a deployment on 1.3.0 came to display
 * "Up to date (v1.2.0)" — the newest PUBLISHED release, rendered where an
 * operator reads the installed version. Running ahead of the newest release is
 * a normal state (a tag never published, a build from main, a fork), so the
 * number shown must come from the deployment rather than from GitHub.
 *
 * THE RESPONSE IS STUBBED, deliberately. A first version of this test called
 * the real endpoint and passed against the broken code, because neither CI nor
 * an air-gapped estate can reach the release list — so the branch under test
 * never ran and the test asserted nothing. Stubbing is what makes it able to
 * fail.
 */
test.describe('the update check', () => {
  test.beforeEach(async ({ request }) => {
    await assertStackReachable(request);
  });

  test('shows the running version when ahead of the newest release', async ({ page }) => {
    await login(page);

    // Exactly the shape that produced the bug: running 1.3.0, newest published
    // release v1.2.0, so no update is available and the deployment is ahead.
    await page.route('**/api/system/update-check', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          current: '1.3.0',
          latest: 'v1.2.0',
          updateAvailable: false,
          releaseUrl: null,
          reachable: true,
          message: null,
        }),
      }),
    );

    await page.goto('/settings/general');
    await page.getByRole('button', { name: /Check for updates/ }).click();

    const status = page.getByRole('status');
    await expect(status).toContainText('Up to date (1.3.0)');
    // And it says why the two differ, rather than hiding it.
    await expect(status).toContainText('ahead of the newest published release');
  });

  test('says up to date once, when the running version is the newest', async ({ page }) => {
    await login(page);

    await page.route('**/api/system/update-check', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          current: '1.3.0',
          latest: 'v1.3.0',
          updateAvailable: false,
          releaseUrl: null,
          reachable: true,
          message: null,
        }),
      }),
    );

    await page.goto('/settings/general');
    await page.getByRole('button', { name: /Check for updates/ }).click();

    const status = page.getByRole('status');
    await expect(status).toContainText('Up to date (1.3.0)');
    // The `v` prefix is the only difference, so this must NOT read as ahead.
    await expect(status).not.toContainText('ahead of');
  });
});
