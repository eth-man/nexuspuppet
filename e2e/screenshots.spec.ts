import { expect, test, type APIRequestContext } from '@playwright/test';
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
    /*
     * The conflict THIS estate has, not one named in this file. The guarantee
     * is unchanged — refuse to photograph an empty report — but naming
     * `profile::base.ntp_servers` tied it to the dev fixtures, and staging's
     * genuine conflict is on a different key.
     */
    const found = (await (await request.get('/api/classification/conflicts')).json()) as {
      conflicts: Array<{ key: string }>;
    };
    const key = found.conflicts[0]?.key;
    if (key === undefined) throw new Error('no conflict to photograph');
    await expect(page.getByText(key).first()).toBeVisible({ timeout: 15_000 });

    /*
     * THE PANEL, not the page.
     *
     * The conflict report and the group list live on the same route, so two
     * full-page captures of /classification produced BYTE-IDENTICAL files —
     * the README's "estate-wide conflict report" and the guide's
     * "classification" were the same picture, each captioned as something
     * different. Framing the card makes the image show what its caption
     * claims, and reads better besides.
     */
    const panel = page
      .getByText('Overrides in effect')
      // The Card, not the CardHeader. `.last()` on a filtered div list returned
      // the innermost match — a 2092x74 strip containing the title and nothing
      // the caption promises. `glass-panel` is the class Card carries and its
      // header does not.
      .locator('xpath=ancestor::div[contains(@class,"glass-panel")][1]');
    await expect(panel).toBeVisible();
    await panel.screenshot({ path: `${SHOTS}/conflict-report.png` });
  });

  /**
   * The screens the README shows, captured rather than photographed by hand.
   *
   * These were hand-captured once and then aged: by the time fact filtering,
   * the Resources page and saved queries had shipped, the README was showing a
   * product three releases old. That is precisely the failure the note at the
   * top of this file describes, and the fix is to bring them under the same
   * command as the other two.
   *
   * Each one WAITS FOR ITS CONTENT before shooting. A screenshot of a loading
   * skeleton is worse than a stale one — it looks like the product is empty.
   */
  test('node inventory, filtered by fact', async ({ page }) => {
    await page.goto('/nodes');
    await expect(page.getByRole('heading', { name: 'Nodes' })).toBeVisible();
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15_000 });

    // Filter by a fact, because that is the feature — an unfiltered table is
    // the screenshot this already had.
    await page.getByRole('button', { name: /Filter by fact/ }).click();
    await page.locator('input[aria-label="Fact"]').last().fill('os.name');
    await page.locator('input[aria-label="Value"]').last().fill('Ubuntu');
    await expect(page.getByText(/nodes? matching/)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('table tbody tr').first()).toBeVisible();

    await page.screenshot({ path: `${SHOTS}/nodes.png` });
  });

  /**
   * Estate-wide resource search — the feature the README does not mention at
   * all, and the one that answers "do these nodes agree".
   */
  test('resource consistency search', async ({ page }) => {
    /*
     * WIDER THAN THE OTHERS. The consistency table carries eight columns, and
     * at 1280 the two that the screen exists for — nodes and variants — fall
     * off the right edge. A screenshot of this feature that omits the variant
     * count shows everything except the point.
     */
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto('/resources');
    await expect(page.getByRole('heading', { name: 'Resources' })).toBeVisible();

    await page.locator('input[aria-label="Resource type (required)"]').fill('File');
    await page.getByRole('button', { name: 'Search', exact: true }).click();

    // Refuse to photograph a consistent estate: the whole point of the screen
    // is the row that disagrees, and a table of ticks demonstrates nothing.
    await expect(page.getByText('sshd_config').first()).toBeVisible({ timeout: 20_000 });
    const drifted = page.locator('tr', { has: page.locator('[aria-label="Nodes disagree"]') });
    await expect(drifted.first()).toBeVisible({ timeout: 20_000 });

    // Open one, so the capture shows WHICH nodes differ rather than only that
    // some do.
    await drifted.first().click();
    await expect(page.getByText(/Differs ·/).first()).toBeVisible({ timeout: 15_000 });

    await page.screenshot({ path: `${SHOTS}/resource-search.png` });
  });

  test('classification group detail', async ({ page }) => {
    await page.goto('/classification');
    await expect(page.getByRole('heading', { name: /Classification/ })).toBeVisible();

    /*
     * WHATEVER GROUP IS THERE, not one named in this file. The dev fixtures
     * call theirs `base-linux`; staging's are "Base platform" and "Web tier".
     * A hardcoded name makes the capture runnable against exactly one estate,
     * which is how these screenshots went a month without being refreshed.
     */
    const firstGroup = page.locator('a[href^="/classification/"]').first();
    await expect(firstGroup).toBeVisible({ timeout: 15_000 });
    await firstGroup.click();
    await expect(page.getByText('Matching rules')).toBeVisible({ timeout: 15_000 });

    await page.screenshot({ path: `${SHOTS}/classification-detail.png` });
  });

  test('node classification detail', async ({ page, request }) => {
    await apiLogin(request);
    const response = await request.get('/api/nodes?limit=1');
    const body = (await response.json()) as { items: Array<{ certname: string }> };
    const certname = body.items[0]?.certname;
    if (certname === undefined) throw new Error('no nodes in the estate to photograph');

    await page.goto(`/nodes/${certname}`);
    // The classification panel is the point of this screenshot, not the facts.
    await expect(page.getByText(/Classification|Applied groups/).first()).toBeVisible({
      timeout: 20_000,
    });

    await page.screenshot({ path: `${SHOTS}/node-detail.png` });
  });

  test('report detail', async ({ page, request }) => {
    await apiLogin(request);
    /*
     * Reports hang off a NODE — there is no top-level list to take the first
     * of, and asking for one returns 404. Find a node that has reported.
     */
    const nodes = (await (await request.get('/api/nodes?limit=25')).json()) as {
      items: Array<{ latestReportHash: string | null }>;
    };
    const hash = nodes.items.find((n) => n.latestReportHash !== null)?.latestReportHash;
    if (hash === undefined || hash === null) {
      throw new Error('no node in the estate has reported, so there is nothing to photograph');
    }

    await page.goto(`/reports/${hash}`);
    await expect(page.getByText(/Resource events|events/).first()).toBeVisible({ timeout: 20_000 });

    await page.screenshot({ path: `${SHOTS}/report-detail.png` });
  });

  /*
   * The USER_GUIDE captures.
   *
   * Same argument as the README ones, and the same neglect: these were taken
   * on 29 July and the guide has been showing a product several releases old
   * ever since.
   */
  test('sign in', async ({ page, context }) => {
    /*
     * SIGNED OUT, which the beforeEach has just undone. Clearing the cookies is
     * what makes /login render the form rather than redirect to the dashboard —
     * without it this captures the page nobody sees.
     */
    await context.clearCookies();
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 15_000 });
    // The identifier field, whatever this deployment calls it.
    await expect(page.getByLabel(/^(Email|Username)$/)).toBeVisible();

    await page.screenshot({ path: `${SHOTS}/login.png` });
  });

  test('dashboard', async ({ page }) => {
    await page.goto('/');
    // Wait for real numbers. A dashboard of zeroes and skeletons is a
    // screenshot of the product still loading.
    await expect(page.getByText(/Nodes/).first()).toBeVisible({ timeout: 20_000 });
    // A real RegExp, not a `text=/…/` string selector — the backslash inside a
    // string is an escape ESLint rightly flags, and this reads as what it is.
    await expect(page.getByText(/^\d+$/).first()).toBeVisible({ timeout: 20_000 });

    await page.screenshot({ path: `${SHOTS}/dashboard.png` });
  });

  test('reports list', async ({ page }) => {
    await page.goto('/reports');
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 20_000 });

    await page.screenshot({ path: `${SHOTS}/reports.png` });
  });

  test('classification list', async ({ page }) => {
    await page.goto('/classification');
    await expect(page.locator('a[href^="/classification/"]').first()).toBeVisible({
      timeout: 20_000,
    });

    await page.screenshot({ path: `${SHOTS}/classification.png` });
  });

  test('settings', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: /Settings/ })).toBeVisible({ timeout: 20_000 });

    await page.screenshot({ path: `${SHOTS}/settings.png` });
  });

  /*
   * The screens the 1.10 and 1.11 sections of the guide walk through.
   *
   * The guide tells an operator where the support bundle is and how to switch
   * a directory on from the console. Prose that says "click Configure
   * directory" next to no picture of it is how the old Not enabled card stayed
   * in the guide a release after it was removed.
   */
  test('support bundle card', async ({ page }) => {
    /*
     * WIDER THAN THE DEFAULT. General lays its cards out in three columns, and
     * at 1280 the host command at the foot of this card is clipped mid-filename
     * — the one line an operator is meant to copy.
     */
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto('/settings/general');
    const title = page.getByText('Support bundle', { exact: true });
    await expect(title).toBeVisible({ timeout: 20_000 });

    /*
     * THE CARD, not the page: General also holds the log level and the
     * deployment details, and a full-page capture shrinks the one card the
     * caption is about to a corner. Same framing as the conflict report.
     */
    const card = title.locator('xpath=ancestor::div[contains(@class,"glass-panel")][1]');
    await expect(card.getByRole('link', { name: 'Download' })).toBeVisible();
    // Open the "what is in it" list: it is the answer to the first question
    // anybody asks before sending a file to support.
    await card.getByText('What is in it, and what is not').click();
    await expect(card.getByText(/Never included/)).toBeVisible();

    await card.screenshot({ path: `${SHOTS}/settings-support-bundle.png` });
  });

  /**
   * Directory / Auth with no directory configured — the state an upgraded
   * install opens on, and the one the guide's walkthrough starts from.
   *
   * SKIPPED, not failed, where a directory is configured: that is a perfectly
   * good deployment to photograph everything else against (staging has one),
   * and the empty state cannot be produced there without discarding its
   * settings, which this file must never do.
   */
  test('directory: not configured, then the LDAP form', async ({ page, request }) => {
    await apiLogin(request);
    const view = (await (await request.get('/api/settings/auth/ldap')).json()) as {
      source: string;
    };
    test.skip(view.source !== 'unset', `LDAP is configured here (${view.source})`);

    await page.goto('/settings/auth');
    const ldap = page.getByRole('region', { name: 'Directory (LDAP)' });
    await expect(ldap.getByText('Not configured', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(ldap.getByRole('button', { name: 'Configure directory' })).toBeVisible();

    await page.screenshot({ path: `${SHOTS}/directory-not-configured.png` });

    /*
     * Filled with example.com values ONLY. This picture is published; a real
     * domain controller's name in it would be a gift to anybody mapping the
     * estate. The CA is a throwaway self-signed certificate — public material,
     * the kind the field exists for — whose key was discarded at generation.
     *
     * NOT SAVED. The form is photographed and left; the page is navigated away
     * from, and the deployment stays exactly as unconfigured as it was found.
     */
    await ldap.getByRole('button', { name: 'Configure directory' }).click();
    /*
     * By ROLE, not getByLabel: each field's info button is labelled "About the
     * server name" and so on, which getByLabel also matches.
     */
    const box = (name: string | RegExp) => ldap.getByRole('textbox', { name });
    await box(/^Server name or IP/).fill('dc01.example.com');
    // LDAPS on 636 and a Regular bind are the defaults; shown as they arrive.
    await ldap.getByRole('combobox', { name: 'Protocol' }).selectOption('ldaps');
    await ldap.getByRole('combobox', { name: 'Bind type' }).selectOption('regular');
    await box(/^User DN\b(?! pattern)/).fill(
      'cn=nexuspuppet-svc,ou=Service Accounts,dc=example,dc=com',
    );
    // A password input has no textbox role.
    await ldap.locator('input[type="password"]').fill('example-only-password');
    await box(/^CA certificate/).fill(EXAMPLE_CA_PEM);
    await box(/^Search base/).fill('ou=People,dc=example,dc=com');
    await box(/^Group search base/).fill('ou=Groups,dc=example,dc=com');
    // Typing leaves the textarea scrolled to its last line; show the
    // BEGIN CERTIFICATE header, which is what tells a reader what goes there.
    await box(/^CA certificate/).evaluate((el) => {
      el.scrollTop = 0;
    });

    // Framed on the connection card and the search card together: the fields
    // the walkthrough names, top to bottom.
    await ldap.getByText('Connection & authentication').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/directory-ldap-form.png` });
  });
});

/**
 * A self-signed "Example Corp Root CA", generated once for this capture with
 * its private key thrown away. A certificate is public by design; nothing here
 * can sign anything.
 */
const EXAMPLE_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBwTCCAWegAwIBAgIUVZ1K24SfL8vCQuPrg8CgIXPHXWIwCgYIKoZIzj0EAwIw
NjEVMBMGA1UECgwMRXhhbXBsZSBDb3JwMR0wGwYDVQQDDBRFeGFtcGxlIENvcnAg
Um9vdCBDQTAeFw0yNjEwMDUxNDQ5MzhaFw0zNjEwMDIxNDQ5MzhaMDYxFTATBgNV
BAoMDEV4YW1wbGUgQ29ycDEdMBsGA1UEAwwURXhhbXBsZSBDb3JwIFJvb3QgQ0Ew
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARG+11JrXaI35Lo+a3DkB8HRLf6dzfe
YT935jm1FtqTQOrLxTJ5a6bt+WLw5kumbAxbmggSAwDR0sFMAUmc01Kxo1MwUTAd
BgNVHQ4EFgQUqW57kk0mEVctQBuPasMcABiHwI4wHwYDVR0jBBgwFoAUqW57kk0m
EVctQBuPasMcABiHwI4wDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBF
AiEAvqKhGnQhtqClMaaoupbIVBNG0mlpFxBOyZSiw+JQUaMCIE066iVGuysiQ8jX
3z6tslk5lsoABT6MPr6e9T5joI41
-----END CERTIFICATE-----`;

async function put(request: APIRequestContext, url: string, data: unknown): Promise<void> {
  const response = await request.put(url, { data });
  if (!response.ok()) {
    throw new Error(`PUT ${url} failed: HTTP ${response.status()} ${await response.text()}`);
  }
}

async function createGroup(
  request: APIRequestContext,
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
