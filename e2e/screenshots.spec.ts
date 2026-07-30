import { expect, test } from '@playwright/test';
import { apiLogin, assertStackReachable, deleteGroupsByPrefix, login } from './support';

/**
 * Regenerate the README screenshots.
 *
 *   CAPTURE_SCREENSHOTS=1 npx playwright test e2e/screenshots.spec.ts
 *
 * NOT part of the normal suite. It writes PNGs into the repository and mutates
 * classification state, neither of which belongs in a pull-request check.
 *
 * The guard is an explicit env var rather than a tag: a `@screenshots` name does
 * NOT exclude anything on its own — `npx playwright test --list` still showed
 * both of these in the default run, which would have had CI capturing
 * screenshots on every PR.
 *
 * WHY THIS IS A TEST RATHER THAN A MANUAL CAPTURE. The two features the README
 * leads on are the two that are hardest to photograph: a plan dialog only exists
 * mid-edit, and a conflict report needs an estate where two groups genuinely
 * fight over a parameter. Reproducing that by hand every time the UI moves is
 * how screenshots quietly come to show a version of the product nobody ships.
 * This builds the state, captures it, and removes it again.
 */

const SHOTS = 'docs/images';

/** Wide enough for the plan diff, short enough to embed without scrolling. */
const VIEWPORT = { width: 1280, height: 800 };

test.describe('@screenshots', () => {
  test.use({ viewport: VIEWPORT, deviceScaleFactor: 2 });

  // Opt in explicitly. Without this the suite runs wherever Playwright runs.
  test.skip(
    process.env['CAPTURE_SCREENSHOTS'] !== '1',
    'set CAPTURE_SCREENSHOTS=1 to regenerate the README screenshots',
  );

  /**
   * Groups are named as an operator would name them — `web-tier`, not
   * `e2e-shot-web-tier`. These end up in a README, and visible test scaffolding
   * undercuts the thing the screenshot is meant to demonstrate.
   *
   * The cost is that the prefix sweep cannot find them, so they are tracked and
   * deleted by id. Acceptable here because this spec is manual-only and never
   * runs in CI; the sweep still runs first to clear anything a previous suite
   * left behind.
   */
  const created: string[] = [];

  test.beforeAll(async ({ request }) => {
    await assertStackReachable(request);
    await deleteGroupsByPrefix(request);
  });

  test.afterAll(async ({ request }) => {
    await apiLogin(request);
    for (const id of created) await request.delete(`/api/node-groups/${id}`);
    await deleteGroupsByPrefix(request);
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  /**
   * Plan before apply — the feature the README now leads on.
   *
   * Captured mid-flow, because that is the whole point: the dialog exists only
   * between deciding to change something and it happening.
   */
  test('plan review dialog', async ({ page, request }) => {
    await apiLogin(request);
    const id = await createGroup(request, 'web-tier', 200);
    created.push(id);

    // Give the group something to hand out BEFORE adding the rule, so the plan
    // shows a catalog diff and not just a membership count. A screenshot that
    // says "47 nodes affected" is far weaker than one showing what those 47
    // nodes would actually gain.
    await put(request, `/api/node-groups/${id}/classes`, {
      className: 'profile::nginx',
      params: { worker_processes: 4, keepalive_timeout: 65 },
    });

    await page.goto(`/classification/${id}`);

    // Scoped to the Matching rules card. An unscoped getByLabel('Value') also
    // matches the parameters editor further down the page, which is how the
    // first attempt at this produced a rule with no value, a group that matched
    // nothing, and a screenshot of the flagship feature reporting "0 nodes
    // affected".
    // Attribute selectors, not getByLabel. Only the RULE inputs carry
    // aria-label="Value"; the parameters editor lower down uses a <label
    // htmlFor>, which getByLabel also matches — and that is how the first
    // attempt filled the wrong box, leaving a rule with no value and producing
    // a screenshot of the flagship feature reporting "0 nodes affected".
    await page.getByRole('button', { name: 'Add rule' }).click();
    await page.locator('input[aria-label="Fact path"]').last().fill('kernel');
    await page.locator('input[aria-label="Value"]').last().fill('Linux');
    await page.getByRole('button', { name: 'Save rules' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Review change')).toBeVisible();
    // Wait for the plan itself, not just the shell — a screenshot of the
    // "Working out what this would do…" state would be worse than none.
    await expect(dialog.getByText(/node(s)? affected/)).toBeVisible({ timeout: 15_000 });
    // Refuse to photograph a no-op. If the plan reports nothing affected, the
    // setup is wrong and the screenshot would misrepresent the feature.
    //
    // Assert the DIFF, not the words "newly classified" — these nodes are
    // already classified by other groups, so the plan calls them "changed", and
    // a guard looking for the wrong phrase rejected a perfectly good plan.
    await expect(dialog.getByText('profile::nginx').first()).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByText('affects no nodes today')).toHaveCount(0);

    await page.screenshot({ path: `${SHOTS}/plan-review.png` });

    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // Removed here, not in afterAll: the next capture photographs the group
    // list, and a leftover scaffolding group in it would be visible in the
    // README.
    await request.delete(`/api/node-groups/${id}`);
    created.splice(created.indexOf(id), 1);
  });

  /**
   * Estate-wide conflict report.
   *
   * Needs two groups that both match the same nodes and both set the same
   * parameter, then a materialization pass — there is no way to photograph this
   * without genuinely creating the conflict.
   */
  /**
   * Photographs the estate AS IT IS, staging nothing.
   *
   * The fixture estate already contains a genuine conflict — `redhat-hardening`
   * at rank 300 overriding `base-linux` for profile::base.ntp_servers on the
   * RedHat subset. An earlier version of this test created its own conflicting
   * group, which worked and was worse: the group list in the screenshot then
   * showed scaffolding that does nothing, and the conflict it produced was less
   * representative than the one already there.
   *
   * If the fixtures ever stop producing a conflict this fails loudly, which is
   * the right outcome — the screenshot would otherwise quietly show an empty
   * report for a feature the README leads on.
   */
  test('estate-wide conflict report', async ({ page, request }) => {
    await apiLogin(request);

    await expect
      .poll(
        async () => {
          const response = await request.get('/api/classification/conflicts');
          const body = (await response.json()) as { conflicts: unknown[] };
          return body.conflicts.length;
        },
        { timeout: 30_000, intervals: [1000] },
      )
      .toBeGreaterThan(0);

    await page.goto('/classification');
    await expect(page.getByRole('heading', { name: 'Overrides in effect' })).toBeVisible();
    await expect(page.getByText('profile::base.ntp_servers')).toBeVisible();

    await page.screenshot({ path: `${SHOTS}/conflict-report.png` });
  });
});

async function put(
  request: Parameters<Parameters<typeof test>[1]>[0]['request'],
  url: string,
  data: unknown,
): Promise<void> {
  const response = await request.put(url, { data });
  if (!response.ok()) {
    throw new Error(`PUT ${url} failed: HTTP ${response.status()} ${await response.text()}`);
  }
}

async function createGroup(
  request: Parameters<Parameters<typeof test>[1]>[0]['request'],
  name: string,
  rank: number,
): Promise<string> {
  const response = await request.post('/api/node-groups', {
    data: { name, rank, strategy: 'ALL_RULES', environment: null, isEnabled: true, parentId: null },
  });
  if (!response.ok()) {
    throw new Error(
      `could not create group "${name}": HTTP ${response.status()} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { group: { id: string } };
  return body.group.id;
}
