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
   * Scoped to the sidebar's own landmark, and matched exactly.
   *
   * A page-wide `getByRole('link', { name: 'Nodes' })` is ambiguous: the
   * dashboard also links to /nodes from a stat card ("Nodes 48") and from
   * "All nodes →". Playwright's strict mode caught it, which is the behaviour
   * working — an unscoped locator that happened to resolve today would break
   * the first time a page added another link to the same place.
   */
  const navLink = (page: import('@playwright/test').Page, label: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label, exact: true });

  /**
   * The label is real text, not a `title` attribute.
   *
   * Collapsed, the label used to be omitted entirely and the name came from
   * `title` — which IS a valid fallback in the accessible-name spec, so these
   * links were never nameless. The first version of this test asserted they
   * were, and passed against both implementations, which is how that got
   * caught.
   *
   * What actually changed is where the name comes from, and it is worth
   * changing: `title` is the weakest source available. It is not surfaced on
   * touch, it is skipped by some screen-reader configurations, and it is
   * commonly untranslated. Rendered text hidden with `sr-only` is announced by
   * every assistive technology and translated with the page.
   *
   * So the assertion is on the CONTENT: the label must be in the element's text
   * whether or not it is on screen. That distinguishes the two versions, which
   * `getByRole` alone could not.
   */
  test('every navigation link keeps its name when collapsed', async ({ page }) => {
    await page.goto('/');

    for (const label of NAV) {
      await expect(navLink(page, label)).toBeVisible();
    }

    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();

    for (const label of NAV) {
      const link = navLink(page, label);
      await expect(link).toBeAttached();
      // The name comes from text the element owns, not from an attribute.
      await expect(link).toHaveText(label);
      /*
       * And it is genuinely off-screen, so an un-collapsed sidebar cannot pass
       * this test by accident.
       *
       * Measured as a BOUNDING BOX, not with `not.toBeVisible()`. `sr-only`
       * clips to a 1x1 pixel rather than setting `display: none`, so Playwright
       * reports it as visible — correctly, by its own definition. The box is
       * the property that actually differs: about forty pixels wide when the
       * label is on screen, one when it is not.
       */
      const box = await link.locator('span').boundingBox();
      expect(box === null || box.width <= 1).toBe(true);
    }
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveText('Sign out');
  });

  test('the current page is marked, and only the current page', async ({ page }) => {
    await page.goto('/nodes');

    await expect(navLink(page, 'Nodes')).toHaveAttribute('aria-current', 'page');
    for (const label of NAV.filter((l) => l !== 'Nodes')) {
      await expect(navLink(page, label)).not.toHaveAttribute('aria-current', 'page');
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

    const active = navLink(page, 'Nodes');
    const inactive = navLink(page, 'Reports');

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

    const active = navLink(page, 'Nodes');
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
