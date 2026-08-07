import { expect, test } from '@playwright/test';
import {
  apiLogin,
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
    // NOT applyReviewed: malformed input is rejected in the form, before the
    // review step is reached. That ordering is deliberate — there is nothing to
    // preview about a change that cannot be expressed — so no dialog appears.
    await page.getByRole('button', { name: 'Assign', exact: true }).last().click();

    await expect(page.getByRole('heading', { name: 'Review change' })).toBeHidden();
    // The assign dialog stays open with an inline error, and nothing was sent.
    await expect(page.getByLabel('Parameters (JSON)')).toBeVisible();
    expect(called, 'invalid parameters must not reach the API').toBe(false);
  });

  /**
   * An invalid class name is caught AT THE FIELD, before a request is made.
   *
   * This test used to assert the older behaviour: the review dialog opened, the
   * write was attempted, and the API answered 400. That worked, but a real
   * session found what it cost — a single-colon typo produced a preview that
   * failed, and the dialog then offered to apply the change anyway. The name is
   * now validated with the same schema the API uses, so the dialog never opens
   * for a name that cannot work.
   *
   * The API still rejects it; that is covered by plan-contract.spec.ts, which
   * compares the plan and write schemas against the same inputs.
   */
  test('rejects an invalid Puppet class name at the field', async ({ page }) => {
    const name = uniqueGroupName('classname');

    await page.goto('/classification');
    await page.getByRole('button', { name: 'New group' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/classification\/[0-9a-f-]{36}$/);

    await page.getByRole('button', { name: 'Assign' }).click();
    // A single colon — the typo that prompted this. Ordinary, and previously
    // answered with "internal server error".
    await page.getByLabel('Class name').fill('profile:monitoring');
    await page.getByLabel('Parameters (JSON)').fill('{}');

    let requested = false;
    page.on('request', (r) => {
      if (r.url().includes('/classes') || r.url().includes('/classification/plan'))
        requested = true;
    });

    await page.getByRole('button', { name: 'Assign', exact: true }).last().click();

    await expect(page.getByText(/Not a valid Puppet class name/)).toBeVisible();
    // The whole point: no preview, because there is nothing to preview.
    await expect(page.getByRole('heading', { name: 'Review change' })).toHaveCount(0);
    expect(requested, 'an invalid name must not reach the network').toBe(false);

    // And the error clears as soon as the name is corrected, so the field does
    // not stay red once the problem is fixed.
    await page.getByLabel('Class name').fill('profile::monitoring');
    await expect(page.getByText(/Not a valid Puppet class name/)).toHaveCount(0);
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

  /**
   * ADR-0009 accepts silent last-writer-wins ONLY because conflicts stay
   * visible, and named two surfaces: the node view, and this estate-wide one.
   * The second went unbuilt for a long time, so this test exists as much to keep
   * it present as to check it renders.
   */
  test('the estate-wide override report renders on the classification page', async ({ page }) => {
    // No login() here — the describe's beforeEach already did it. Calling it
    // again navigates to /login while authenticated and races the redirect
    // away, which surfaces as a fill() timeout on an input that is visibly
    // present. Every other test in this file goes straight to goto().
    await page.goto('/classification');

    const report = page.getByRole('heading', { name: 'Overrides in effect' });
    await expect(report).toBeVisible();

    // The fixture estate may or may not contain an override, and both are
    // legitimate — so assert the panel reports SOMETHING about the estate rather
    // than asserting a count that would make this test a fixture detector.
    await expect(page.getByText(/node(s)? *$|of \d+ node/).first()).toBeVisible();
  });
});

/**
 * Where each line of a node's classification came from (#141).
 *
 * Built against REAL state rather than a stub: two groups are created, both
 * assigning the same class with different parameter values, and one node is
 * pinned into both. That is the shape the card exists to explain — and it is
 * the shape that previously required opening each group in turn and
 * re-deriving the merge by hand.
 */
test.describe('classification provenance', () => {
  test.beforeAll(async ({ request }) => {
    await assertStackReachable(request);
    await deleteGroupsByPrefix(request);
  });

  test.afterAll(async ({ request }) => {
    await deleteGroupsByPrefix(request);
  });

  test('names the group that set each value, and the one it overrode', async ({
    page,
    request,
  }) => {
    await apiLogin(request);

    const certname = await firstCertname(request);
    test.skip(certname === null, 'the projection has produced no nodes to classify');

    const low = uniqueGroupName('prov-low');
    const high = uniqueGroupName('prov-high');

    // Lower rank first, so the higher-ranked group is the one that wins.
    const lowId = await createPinnedGroup(request, low, 100, certname as string, 5432);
    const highId = await createPinnedGroup(request, high, 900, certname as string, 6543);
    expect(lowId).not.toBe('');
    expect(highId).not.toBe('');

    await waitForMaterialization(request, certname as string);

    await login(page);
    await page.goto(`/nodes/${encodeURIComponent(certname as string)}`);

    const card = page.getByText('Where it came from');
    await expect(card).toBeVisible();

    /*
     * Matched on text ONLY the attribution card produces, which took two
     * attempts to get right:
     *
     *   - the group names are vacuous — both already appear in the Applied
     *     groups card, so the assertion passed with attribution removed;
     *   - the class key is ambiguous — it appears in the Conflicts card too,
     *     because these two groups set different values.
     *
     * "over <group> <value>" is rendered here and nowhere else. Conflicts says
     * "overriding", which this pattern does not match: after `over` it needs
     * whitespace, and there it is followed by `riding`.
     *
     * Verified by deleting the card and watching this fail.
     */
    await expect(page.getByText(new RegExp(`over\\s+${low}`))).toBeVisible();
  });

  async function firstCertname(request: import('@playwright/test').APIRequestContext) {
    const response = await request.get('/api/nodes?limit=1');
    if (!response.ok()) return null;
    const body = (await response.json()) as
      { items?: Array<{ certname: string }> } | Array<{ certname: string }>;
    const items = Array.isArray(body) ? body : (body.items ?? []);
    return items[0]?.certname ?? null;
  }

  async function createPinnedGroup(
    request: import('@playwright/test').APIRequestContext,
    name: string,
    rank: number,
    certname: string,
    port: number,
  ): Promise<string> {
    const created = await request.post('/api/node-groups', {
      data: { name, rank, strategy: 'PINNED' },
    });
    if (!created.ok()) return '';
    const { group } = (await created.json()) as { group: { id: string } };

    await request.post(`/api/node-groups/${group.id}/pins`, { data: { certnames: [certname] } });
    await request.put(`/api/node-groups/${group.id}/classes`, {
      data: { className: 'profile::provenance_demo', params: { port } },
    });
    return group.id;
  }

  /** The write answers 202; the file lands a moment later (ADR-0003). */
  async function waitForMaterialization(
    request: import('@playwright/test').APIRequestContext,
    certname: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await request.get(
        `/api/nodes/${encodeURIComponent(certname)}/classification`,
      );
      if (response.ok()) {
        const body = (await response.json()) as { attribution?: unknown; pending?: boolean };
        if (body.attribution !== undefined && body.pending !== true) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  test('says why each group matched, naming the fact and its projected value', async ({
    page,
    request,
  }) => {
    await apiLogin(request);

    const certname = await firstCertname(request);
    test.skip(certname === null, 'the projection has produced no nodes to classify');

    const pinned = uniqueGroupName('why-pinned');
    const id = await createPinnedGroup(request, pinned, 120, certname as string, 1234);
    expect(id).not.toBe('');

    await waitForMaterialization(request, certname as string);

    await login(page);
    await page.goto(`/nodes/${encodeURIComponent(certname as string)}`);

    /*
     * "pinned — ... no rule was evaluated" is produced by the match-reason
     * renderer and nowhere else. The group NAME would not do: it already
     * appears in the applied list, so asserting it would pass with the reason
     * removed entirely — the same trap that made the #141 test vacuous twice.
     */
    // Scoped to THIS group's row. The reason renders once per applied group,
    // and the previous test's groups are still pinned to the same node — so an
    // unscoped match is ambiguous, and scoping also asserts the stronger thing:
    // that the reason belongs to the group it is shown under.
    const row = page.getByRole('listitem').filter({ hasText: pinned });
    await expect(row.getByText(/pinned — this node is named on the group/)).toBeVisible();
  });
});
