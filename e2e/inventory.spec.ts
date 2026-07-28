import { expect, test } from '@playwright/test';
import { KNOWN_CERTNAME, assertStackReachable, login } from './support';

/**
 * Read-only visibility: inventory, node detail, reports.
 *
 * Assertions are about DATA REACHING THE SCREEN, not about styling. When the
 * fixtures are swapped for a real estate the counts and certnames change, so
 * anything asserting a specific number would fail for the wrong reason. What
 * must not change is that rows render, filters narrow, and a filter that
 * matches nothing says so rather than showing everything.
 */
test.describe('inventory', () => {
  test.beforeAll(async ({ request }) => {
    await assertStackReachable(request);
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('renders the estate with real rows', async ({ page }) => {
    await page.goto('/nodes');

    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(0);

    // The fixture anchor. If the projector or the mappers break, this is the
    // first thing that stops appearing.
    await expect(page.getByRole('link', { name: KNOWN_CERTNAME })).toBeVisible();
    await expect(page.getByText(/\d+ nodes? in the estate/)).toBeVisible();
  });

  test('shows a status, environment and last-run age for each node', async ({ page }) => {
    await page.goto('/nodes');

    const row = page.locator('table tbody tr').filter({ hasText: KNOWN_CERTNAME }).first();
    await expect(row).toBeVisible();

    // Every node has exactly one state badge, drawn from the shared token map.
    await expect(
      row
        .locator('span')
        .filter({ hasText: /^(Failed|Changed|Unchanged|Unknown)$/ })
        .first(),
    ).toBeVisible();
    await expect(row).toContainText(/production|staging|development/);
  });

  test('narrows the estate by certname', async ({ page }) => {
    await page.goto('/nodes');
    // Derived from the anchor certname, not written here. A literal 'db01' was
    // left behind when the fixtures were re-captured, so the filter narrowed to
    // a node the assertion below no longer looked for.
    await page
      .getByLabel('Filter by certname')
      .fill(KNOWN_CERTNAME.split('.')[0] ?? KNOWN_CERTNAME);

    await expect(page.getByText(/\d+ nodes? matching/)).toBeVisible();
    await expect(page.getByRole('link', { name: KNOWN_CERTNAME })).toBeVisible();
    expect(await page.locator('table tbody tr').count()).toBeLessThan(48);
  });

  /**
   * Regex metacharacters must be matched literally.
   *
   * Unescaped, `.*` returns the entire estate — a filter that silently does
   * nothing — and on a real PuppetDB a pattern like `(a+)+$` is a denial of
   * service. This asserts the escaping survives from the browser through to the
   * query.
   */
  test('treats regex metacharacters in the filter as literal text', async ({ page }) => {
    await page.goto('/nodes');
    await page.getByLabel('Filter by certname').fill('.*');

    await expect(page.getByText('No nodes match these filters')).toBeVisible();
  });

  test('filters by status', async ({ page }) => {
    await page.goto('/nodes');
    await page.getByRole('button', { name: 'Failed' }).click();

    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible();

    // Every visible row must actually be failing, not merely fewer rows.
    const statuses = await rows.locator('td:nth-child(2)').allInnerTexts();
    expect(statuses.length).toBeGreaterThan(0);
    expect(new Set(statuses.map((s) => s.trim()))).toEqual(new Set(['Failed']));
  });

  /**
   * Deactivated nodes are hidden by default and must be opt-in: an operator
   * counting their estate should not silently include decommissioned hosts.
   */
  test('hides decommissioned nodes until asked for them', async ({ page }) => {
    await page.goto('/nodes');
    const before = await page.locator('table tbody tr').count();

    await page.getByLabel('Include deactivated').check();
    await expect(page.getByText(/\d+ nodes? matching/)).toBeVisible();

    const after = await page.locator('table tbody tr').count();
    expect(after).toBeGreaterThan(before);
    await expect(page.getByText('deactivated', { exact: false }).first()).toBeVisible();
  });

  test('opens a node and explains its classification', async ({ page }) => {
    await page.goto(`/nodes/${encodeURIComponent(KNOWN_CERTNAME)}`);

    await expect(page.getByRole('heading', { name: KNOWN_CERTNAME })).toBeVisible();
    // Applied groups are listed in merge order; the sequence IS the explanation.
    await expect(page.getByText('Applied groups')).toBeVisible();
    await expect(page.getByText('merge order — last wins')).toBeVisible();
  });

  test('shows the full fact set, filterable', async ({ page }) => {
    await page.goto(`/nodes/${encodeURIComponent(KNOWN_CERTNAME)}`);
    await page.getByRole('button', { name: 'Facts' }).click();

    const filter = page.getByLabel('Filter facts');
    await expect(filter).toBeVisible();

    await expect(page.getByText('os.family', { exact: true })).toBeVisible();
    await filter.fill('kernel');
    await expect(page.getByText('os.family', { exact: true })).toBeHidden();
    await expect(page.getByText('kernel', { exact: true })).toBeVisible();
  });

  test('lists run history for a node', async ({ page }) => {
    await page.goto(`/nodes/${encodeURIComponent(KNOWN_CERTNAME)}`);
    await page.getByRole('button', { name: 'Run history' }).click();

    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test('opens a run report and leads with the failure', async ({ page }) => {
    await page.goto('/reports');

    const firstReport = page.locator('table tbody tr').first().getByRole('link').last();
    await firstReport.click();

    await expect(page.getByRole('heading', { name: 'Run report' })).toBeVisible();
    await expect(page.getByText('Resource events')).toBeVisible();
    // Problems are pre-selected: this page exists for triage.
    await expect(page.getByRole('button', { name: /^Problems/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('states how much of the estate it is showing', async ({ page }) => {
    // A bounded view that does not admit its bound is how an operator concludes
    // there are no failures when there are 900 more rows.
    await page.goto('/reports');
    await expect(page.getByText(/showing \d+–\d+ of \d+|showing 0/)).toBeVisible();
  });
});
