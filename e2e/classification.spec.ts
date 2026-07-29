import { expect, test } from '@playwright/test';
import {
  applyReviewed,
  assertStackReachable,
  deleteGroupsByPrefix,
  login,
  uniqueGroupName,
} from './support';

/**
 * Classification writes — the flow that eventually reconfigures real machines.
 *
 * The assertions that matter are not "the button worked". They are:
 *
 *   - the API answers 202, never 200, because the change is durable but NOT yet
 *     effective (ADR-0003);
 *   - the UI reports the queue rather than claiming the estate is converged;
 *   - a rule edit queues a FULL reconcile, because it can pull in nodes that
 *     never matched before;
 *   - invalid input is rejected before it can reach a node.
 *
 * Every test names its group uniquely and the suite sweeps its own leftovers,
 * so a run against a live stack cannot collide with a human using it.
 */
test.describe('classification', () => {
  test.beforeAll(async ({ request }) => {
    await assertStackReachable(request);
    // Sweep before as well as after: a crashed or interrupted previous run
    // leaves groups behind, and they would otherwise accumulate silently.
    await deleteGroupsByPrefix(request);
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test.afterAll(async ({ request }) => {
    await deleteGroupsByPrefix(request);

    const remaining = (await (await request.get('/api/node-groups')).json()) as Array<{
      name: string;
    }>;
    expect(
      remaining.filter((g) => g.name.startsWith('e2e-')),
      'the suite must leave no groups behind',
    ).toEqual([]);
  });

  test('lists node groups in merge order', async ({ page }) => {
    await page.goto('/classification');

    await expect(page.getByRole('heading', { name: 'Classification' })).toBeVisible();
    await expect(page.getByText('higher rank is applied last and wins')).toBeVisible();

    const ranks = await page.locator('table tbody tr td:first-child').allInnerTexts();
    const numeric = ranks.map((r) => Number(r.trim()));
    // Ascending rank IS the evaluation order; reading the table top to bottom
    // is reading how a classification is built up.
    expect(numeric).toEqual([...numeric].sort((a, b) => a - b));
  });

  /**
   * The full write path, asserting the HTTP status directly.
   *
   * A 200 here would be a correctness bug rather than a cosmetic one: it tells
   * the UI the estate is already configured this way, when the ENC file has not
   * been written yet.
   */
  test('creating a group answers 202 and lands in the editor', async ({ page }) => {
    const name = uniqueGroupName('create');

    await page.goto('/classification');
    await page.getByRole('button', { name: 'New group' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Rank').fill('450');

    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/node-groups') && r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: 'Create' }).click(),
    ]);

    expect(response.status(), 'a write must be Accepted, not OK').toBe(202);

    // Straight into the editor: a group with no rules classifies nothing, so
    // creation is never the end of the task.
    await expect(page).toHaveURL(/\/classification\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name })).toBeVisible();
  });

  /**
   * A rule change can pull in nodes that have never matched this group, and
   * current membership cannot tell us which — so the only correct answer is to
   * recompute everything. If this ever narrows to named nodes, newly-matching
   * hosts silently keep their old classification.
   */
  /**
   * "Plan before apply".
   *
   * The three properties that make a preview worth having: Save must not write,
   * Cancel must leave everything exactly as it was, and Apply must perform the
   * write that was rehearsed. A preview that sometimes writes anyway is worse
   * than none, because it is trusted.
   */
  test('Save opens a review instead of writing', async ({ page }) => {
    const name = uniqueGroupName('review');
    await page.goto('/classification');
    await page.getByRole('button', { name: 'New group' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/classification\/[0-9a-f-]{36}$/);

    let wrote = false;
    page.on('request', (request) => {
      if (request.url().includes('/rules') && request.method() === 'PUT') wrote = true;
    });

    await page.getByRole('button', { name: 'Add rule' }).click();
    await page.getByLabel('Fact path').first().fill('kernel');
    await page.getByLabel('Value').first().fill('Linux');
    await page.getByRole('button', { name: 'Save rules' }).click();

    await expect(page.getByRole('heading', { name: 'Review change' })).toBeVisible();
    // The forecast caveat is part of the contract with the operator.
    await expect(page.getByText('Forecast based on the current estate state.')).toBeVisible();
    expect(wrote).toBe(false);
  });

  test('Cancel leaves the change unwritten', async ({ page }) => {
    const name = uniqueGroupName('cancel');
    await page.goto('/classification');
    await page.getByRole('button', { name: 'New group' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/classification\/[0-9a-f-]{36}$/);

    let wrote = false;
    page.on('request', (request) => {
      if (request.url().includes('/rules') && request.method() === 'PUT') wrote = true;
    });

    await page.getByRole('button', { name: 'Add rule' }).click();
    await page.getByLabel('Fact path').first().fill('kernel');
    await page.getByLabel('Value').first().fill('Linux');
    await page.getByRole('button', { name: 'Save rules' }).click();
    await expect(page.getByRole('heading', { name: 'Review change' })).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { name: 'Review change' })).toBeHidden();
    expect(wrote).toBe(false);

    // And the group really is unchanged after a reload — not merely un-posted.
    await page.reload();
    await expect(page.getByText(/A rule-based group with no rules matches nothing/)).toBeVisible();
  });

  /**
   * The preview must describe the estate, not guess at it. This group matches
   * every node in the fixture estate, so the count has to be the real one.
   */
  test('the review reports how many nodes a change would affect', async ({ page }) => {
    const name = uniqueGroupName('blast');
    await page.goto('/classification');
    await page.getByRole('button', { name: 'New group' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/classification\/[0-9a-f-]{36}$/);

    // A class first, so matching nodes actually change rather than matching an
    // empty group and producing an identical document.
    await page.getByRole('button', { name: 'Assign' }).click();
    await page.getByLabel('Class name').fill('profile::base');
    await applyReviewed(page, () =>
      page.getByRole('button', { name: 'Assign', exact: true }).last().click(),
    );

    await page.getByRole('button', { name: 'Add rule' }).click();
    await page.getByLabel('Fact path').first().fill('kernel');
    await page.getByLabel('Value').first().fill('Linux');
    await page.getByRole('button', { name: 'Save rules' }).click();

    const review = page.getByRole('dialog');
    await expect(review.getByRole('heading', { name: 'Review change' })).toBeVisible();
    await expect(review.getByText(/nodes? affected/)).toBeVisible();
    // Newly classified, not merely "changed" — these nodes had nothing before.
    await expect(review.getByText(/newly classified/)).toBeVisible();
    // Scoped to the dialog: the class is also listed on the page behind it, and
    // an unscoped match would resolve to both.
    await expect(review.getByText('profile::base')).toBeVisible();

    await page.getByRole('button', { name: /^Apply/ }).click();
    await expect(page.getByText('Change saved — materialization queued')).toBeVisible();
  });

  test('a rule change queues a FULL reconcile and says so', async ({ page }) => {
    const name = uniqueGroupName('rules');

    await page.goto('/classification');
    await page.getByRole('button', { name: 'New group' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/classification\/[0-9a-f-]{36}$/);

    await page.getByRole('button', { name: 'Add rule' }).click();
    await page.getByLabel('Fact path').first().fill('os.family');
    await page.getByLabel('Value').first().fill('RedHat');

    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/rules') && r.request().method() === 'PUT'),
      // Save opens the review dialog; the write happens on Apply.
      applyReviewed(page, () => page.getByRole('button', { name: 'Save rules' }).click()),
    ]);

    expect(response.status()).toBe(202);
    expect((await response.json()).materializationQueued.scope).toBe('full-reconcile');

    await expect(page.getByText('Change saved — materialization queued')).toBeVisible();
    await expect(page.getByText(/Every node will be recomputed/)).toBeVisible();
  });

  /**
   * The UI must never claim a change is live. Puppet applies it on each node's
   * next run, and until the materializer writes the file the estate is still
   * running the previous classification.
   */
  test('never reports a write as applied', async ({ page }) => {
    const name = uniqueGroupName('wording');

    await page.goto('/classification');
    await page.getByRole('button', { name: 'New group' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/classification\/[0-9a-f-]{36}$/);

    await page.getByRole('button', { name: 'Assign' }).click();
    await page.getByLabel('Class name').fill('profile::e2e');
    await page.getByLabel('Parameters (JSON)').fill('{"marker":"e2e"}');
    await applyReviewed(page, () =>
      page.getByRole('button', { name: 'Assign', exact: true }).last().click(),
    );

    const banner = page.getByRole('status').first();
    await expect(banner).toContainText('materialization queued');
    await expect(banner).toContainText(/next run/);
    await expect(page.getByText(/^Saved$/)).toHaveCount(0);
  });

  test('assigning a class answers 202 and shows it on the group', async ({ page }) => {
    const name = uniqueGroupName('class');

    await page.goto('/classification');
    await page.getByRole('button', { name: 'New group' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/classification\/[0-9a-f-]{36}$/);

    await page.getByRole('button', { name: 'Assign' }).click();
    await page.getByLabel('Class name').fill('profile::e2e::tuning');
    await page
      .getByLabel('Parameters (JSON)')
      .fill('{"extra_config_line":"client_max_body_size 64m;"}');

    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/classes') && r.request().method() === 'PUT'),
      applyReviewed(page, () =>
        page.getByRole('button', { name: 'Assign', exact: true }).last().click(),
      ),
    ]);

    expect(response.status()).toBe(202);
    await expect(page.getByText('profile::e2e::tuning')).toBeVisible();
    await expect(page.getByText(/client_max_body_size/)).toBeVisible();
  });

  /**
   * Parameters are validated in the browser with the SAME Zod schema the API
   * uses, so malformed input is rejected before a round trip — and, more
   * importantly, before it can reach a node.
   */
  test('rejects malformed JSON parameters without calling the API', async ({ page }) => {
    const name = uniqueGroupName('zod');

    await page.goto('/classification');
    await page.getByRole('button', { name: 'New group' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/classification\/[0-9a-f-]{36}$/);

    let called = false;
    page.on('request', (r) => {
      if (r.url().includes('/classes') && r.method() === 'PUT') called = true;
    });

    await page.getByRole('button', { name: 'Assign' }).click();
    await page.getByLabel('Class name').fill('profile::e2e');
    await page.getByLabel('Parameters (JSON)').fill('{ this is not json }');
    await applyReviewed(page, () =>
      page.getByRole('button', { name: 'Assign', exact: true }).last().click(),
    );

    // The dialog stays open with an inline error, and nothing was sent.
    await expect(page.getByLabel('Parameters (JSON)')).toBeVisible();
    expect(called, 'invalid parameters must not reach the API').toBe(false);
  });

  /**
   * An invalid class name is caught at the API boundary rather than surfacing
   * during catalog compilation on an agent, where it would be an opaque failure
   * far from its cause.
   */
  test('rejects an invalid Puppet class name', async ({ page }) => {
    const name = uniqueGroupName('classname');

    await page.goto('/classification');
    await page.getByRole('button', { name: 'New group' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/classification\/[0-9a-f-]{36}$/);

    await page.getByRole('button', { name: 'Assign' }).click();
    await page.getByLabel('Class name').fill('Invalid::ClassName');
    await page.getByLabel('Parameters (JSON)').fill('{}');

    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/classes') && r.request().method() === 'PUT'),
      applyReviewed(page, () =>
        page.getByRole('button', { name: 'Assign', exact: true }).last().click(),
      ),
    ]);

    expect(response.status()).toBe(400);
    await expect(page.getByText('Change rejected')).toBeVisible();
  });

  /**
   * A rule on an unprojected fact can NEVER match. Silently never matching is
   * the worst outcome available here: the group simply classifies nothing and
   * nobody is told.
   */
  test('warns when a rule names a fact the projection does not carry', async ({ page }) => {
    const name = uniqueGroupName('unprojected');

    await page.goto('/classification');
    await page.getByRole('button', { name: 'New group' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/classification\/[0-9a-f-]{36}$/);

    await page.getByRole('button', { name: 'Add rule' }).click();
    await page.getByLabel('Fact path').first().fill('definitely_not_a_real_fact');

    await expect(page.getByText(/can never match/)).toBeVisible();
  });

  test('offers the projected fact paths as suggestions', async ({ page }) => {
    const name = uniqueGroupName('suggest');

    await page.goto('/classification');
    await page.getByRole('button', { name: 'New group' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/classification\/[0-9a-f-]{36}$/);

    // Discovered from the projection, not from PuppetDB's full fact set —
    // suggesting an unprojected path would offer a rule guaranteed to fail.
    await expect(page.getByText(/\d+ fact paths available/)).toBeVisible();

    const options = page.locator('datalist[id^="fact-paths-"] option');
    expect(await options.count()).toBeGreaterThan(0);
  });

  /**
   * Deleting a group must state its blast radius BEFORE the operator confirms,
   * and must queue the nodes it was classifying so they stop receiving it.
   */
  test('deleting a group confirms first, then queues the affected nodes', async ({ page }) => {
    const name = uniqueGroupName('delete');

    await page.goto('/classification');
    await page.getByRole('button', { name: 'New group' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/classification\/[0-9a-f-]{36}$/);

    await page.getByRole('button', { name: 'Delete group' }).click();
    await expect(page.getByText(/will be rewritten without it/)).toBeVisible();

    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/node-groups/') && r.request().method() === 'DELETE',
      ),
      page.getByRole('button', { name: 'Delete group', exact: true }).last().click(),
    ]);

    expect(response.status()).toBe(202);
    await expect(page).toHaveURL(/\/classification$/);
    await expect(page.getByRole('link', { name })).toHaveCount(0);
  });
});
