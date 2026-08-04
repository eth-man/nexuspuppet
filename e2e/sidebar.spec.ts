import { expect, test } from '@playwright/test';
import { assertStackReachable, login } from './support';

/**
 * Sidebar treatment (issue #72 slice 4): active marking, and collapse.
 *
 * The assertions worth having are the ones a restyle breaks silently. Colour is
 * measured by `qa:contrast` rather than here — a screenshot comparison would
 * fail on a font hint and pass on an unreadable pill.
 */
test.describe('sidebar', () => {
  test.beforeEach(async ({ page }) => {
    await assertStackReachable(page.request);
    await login(page);
  });

  const NAV = ['Dashboard', 'Nodes', 'Reports', 'Classification', 'Settings'];

  /**
   * The regression this slice existed to fix.
   *
   * Collapsed, the label was not rendered at all and the icon is aria-hidden,
   * so every nav link had an EMPTY accessible name — five unlabelled links to a
   * screen reader. `title` did not cover it: advisory only, and invisible to a
   * keyboard user.
   *
   * Asserted through getByRole, which resolves the accessible name the same way
   * assistive technology does. A test that looked for the text node would pass
   * on `sr-only` and also pass on the broken version, since neither is visible.
   */
  test('every navigation link keeps its name when collapsed', async ({ page }) => {
    await page.goto('/');

    for (const label of NAV) {
      await expect(page.getByRole('link', { name: label })).toBeVisible();
    }

    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();

    for (const label of NAV) {
      // Still resolvable by name, though the text is no longer on screen.
      await expect(page.getByRole('link', { name: label })).toBeAttached();
    }
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeAttached();
  });

  test('the current page is marked, and only the current page', async ({ page }) => {
    await page.goto('/nodes');

    await expect(page.getByRole('link', { name: 'Nodes' })).toHaveAttribute('aria-current', 'page');
    for (const label of NAV.filter((l) => l !== 'Nodes')) {
      await expect(page.getByRole('link', { name: label })).not.toHaveAttribute(
        'aria-current',
        'page',
      );
    }
  });

  /**
   * Active and hover must not be the same treatment.
   *
   * They were: both were `bg-panel-raised`, so "where I am" and "what I am
   * pointing at" rendered identically. The accent border is what separates
   * them, and it is the part that survives collapsing.
   */
  test('the active item is marked by more than a background', async ({ page }) => {
    await page.goto('/nodes');

    const active = page.getByRole('link', { name: 'Nodes' });
    const inactive = page.getByRole('link', { name: 'Reports' });

    const borderOf = (locator: ReturnType<typeof page.getByRole>) =>
      locator.evaluate((el) => getComputedStyle(el).borderLeftColor);

    const activeBorder = await borderOf(active);
    const inactiveBorder = await borderOf(inactive);

    expect(activeBorder).not.toBe(inactiveBorder);
    // Transparent, not merely a different colour — the inactive border exists
    // only to stop the row shifting sideways when it becomes active.
    expect(inactiveBorder).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  });

  test('the active marking survives collapsing', async ({ page }) => {
    await page.goto('/nodes');
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();

    const active = page.getByRole('link', { name: 'Nodes' });
    await expect(active).toHaveAttribute('aria-current', 'page');

    const border = await active.evaluate((el) => getComputedStyle(el).borderLeftColor);
    expect(border).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  });

  test('collapse is remembered across a reload', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();

    await page.reload();

    // Still collapsed: the control offers to expand, not to collapse again.
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();

    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
  });
});
