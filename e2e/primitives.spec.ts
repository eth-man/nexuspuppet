import { expect, test } from '@playwright/test';
import { apiLogin, assertStackReachable, login } from './support';

/**
 * Card and control primitives (issue #72 slice 3), asserted through the screen
 * that uses them.
 *
 * The properties worth testing are the ones a restyle silently breaks: a label
 * that stops being associated with its control, and a sub-task that drifts back
 * into the row with the Save button. Neither shows up in a typecheck, and the
 * first is invisible to anyone not using a screen reader.
 */
test.describe('primitives', () => {
  /**
   * Whether this deployment can run a directory at all.
   *
   * Core does not, and the screen is a teaser rather than a form there — so
   * every assertion about inputs has to know which edition it is looking at.
   * Resolved once, in beforeAll, because `test.skip()` in describe scope cannot
   * take an async condition.
   */
  let directory = false;

  test.beforeAll(async ({ request }) => {
    await apiLogin(request);
    const response = await request.get('/api/capabilities');
    if (!response.ok()) return;
    const body = (await response.json()) as { capabilities?: string[] };
    directory = body.capabilities?.includes('directory.ldap') === true;
  });

  test.beforeEach(async ({ request }) => {
    await assertStackReachable(request);
  });

  /**
   * Core must not be able to configure something that cannot run.
   *
   * It first rendered the whole form, accepted a save, and explained in a
   * warning box that nothing would take effect — however honestly worded, an
   * open-source user fills in six fields, gets a success, finds nobody can
   * sign in, and concludes the product is broken.
   *
   * It then rendered the form inert, so the feature could still be SEEN. That
   * was better, and it was still thirty controls nobody could fill, pushing
   * the settings this deployment can actually use below the fold.
   *
   * Now: named, explained, and not drawn. The feature is still discoverable —
   * the header was the part anyone read — and there is nothing to operate.
   */
  test('core names the directory feature and draws no form', async ({ page }) => {
    test.skip(directory, 'this deployment can run a directory');

    await login(page);
    await page.goto('/settings/auth');

    // Still NAMED, and it still says which capability unlocks it — the same
    // string the API's 501 carries.
    await expect(page.getByRole('heading', { name: /Directory/ })).toBeVisible();
    await expect(page.getByText('directory.ldap')).toBeVisible();
    await expect(page.getByText('Enterprise').first()).toBeVisible();

    /*
     * ABSENT, not merely disabled — and that distinction is the point of this
     * test. `toBeDisabled()` passed happily against the previous version, so
     * only an absence assertion can tell the two apart.
     */
    await expect(page.getByRole('textbox', { name: /^Server URL/ })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: /Verify the directory/i })).toHaveCount(0);

    for (const name of ['Save', 'Test connection', 'Edit settings']) {
      await expect(page.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveCount(0);
    }
  });

  /**
   * Disabled has to mean disabled, not merely look it.
   *
   * A `pointer-events-none` class or a lowered opacity would pass a visual
   * review and still let a keyboard user tab into the field and type. The
   * fieldset is what actually prevents that, and this is the assertion that
   * notices if somebody replaces it with styling.
   */
  test('core cannot type into the disabled form', async ({ page }) => {
    test.skip(directory, 'this deployment can run a directory');

    await login(page);
    await page.goto('/settings/auth');

    const url = page.getByRole('textbox', { name: /^Server URL/ });
    await expect(url).toBeVisible();
    await expect(url).not.toBeEditable();
    await expect(url).toHaveValue('');
  });

  /**
   * Everything below needs a directory-capable deployment.
   *
   * Reveals the form when nothing is configured yet. `count()` does NOT
   * auto-wait: called straight after `goto` it returns 0 because the panel has
   * not loaded, the branch never runs, and the failure surfaces as a missing
   * field rather than as a race. Waiting on "the CTA or the form, whichever
   * arrives" is what makes the branch decision mean anything.
   *
   * @param editing ask for the form to be UNLOCKED as well as shown.
   *
   * The screen renders read-only until somebody asks to change it (ADR-0016), so
   * "the form is on screen" and "the form can be typed into" stopped being the
   * same state. Anything that clicks, focuses or saves needs the second one;
   * anything asserting layout or presence should stay on the first, because that
   * is what an operator sees on arrival.
   */
  async function openDirectoryForm(
    page: import('@playwright/test').Page,
    { editing = false }: { editing?: boolean } = {},
  ) {
    await page.goto('/settings/auth');

    const cta = page.getByRole('button', { name: 'Configure directory' });
    const url = page.getByRole('textbox', { name: /^Server URL/ });
    await expect(cta.or(url).first()).toBeVisible();
    if ((await cta.count()) > 0) await cta.click();
    await expect(url).toBeVisible();

    if (!editing) return;

    // Absent on a deployment that arrived through the empty-state CTA — that
    // path opens straight into an editable form, since there is nothing yet to
    // protect from an accidental keystroke.
    const edit = page.getByRole('button', { name: 'Edit settings' });
    if ((await edit.count()) > 0) await edit.click();
    await expect(url).toBeEditable();
  }

  test('an unconfigured deployment offers an empty state, not a blank form', async ({ page }) => {
    test.skip(!directory, 'requires the directory.ldap capability');

    await login(page);
    await page.goto('/settings/auth');

    const cta = page.getByRole('button', { name: 'Configure directory' });
    const url = page.getByRole('textbox', { name: /^Server URL/ });
    await expect(cta.or(url).first()).toBeVisible();

    if ((await cta.count()) > 0) {
      await expect(page.getByRole('heading', { name: 'No directory connected' })).toBeVisible();
      await expect(url).toHaveCount(0);
      await cta.click();
      await expect(url).toBeVisible();
    } else {
      await expect(url).toBeVisible();
    }
  });

  /**
   * Every labelled field must actually be labelled.
   *
   * By ROLE and accessible name, not getByLabel: that is a case-insensitive
   * substring match over label text AND aria-label, so "Server URL" also
   * matches the hint button beside it, labelled "About the server URL".
   * Resolving through the accessibility tree fails exactly when the
   * association is broken, whatever the markup looks like.
   */
  test('every field on the directory form is reachable by its label', async ({ page }) => {
    test.skip(!directory, 'requires the directory.ldap capability');

    await login(page);
    await openDirectoryForm(page, { editing: true });

    for (const label of ['Server URL', 'Bind DN', 'Search base', 'Group search base']) {
      const control = page.getByRole('textbox', { name: new RegExp(`^${label}`) }).first();
      await expect(control, `"${label}" is not associated with a control`).toBeVisible();
    }

    /*
     * Clicking a label focuses its control — the association working in the
     * direction a mouse user experiences it.
     *
     * Located through the control's own id rather than by label TEXT: a
     * required field renders a `*` inside its <label>, so an exact text match
     * finds nothing and a loose one also matches "Group search base". Going via
     * `for` asks the same question the browser does.
     */
    const searchBase = page.getByRole('textbox', { name: /^Search base/ }).first();
    const id = await searchBase.getAttribute('id');
    expect(id, 'the control has no id, so no label can point at it').toBeTruthy();

    await page.locator(`label[for="${id}"]`).click();
    await expect(searchBase).toBeFocused();
  });

  test('the form is grouped into cards rather than one flat list', async ({ page }) => {
    test.skip(!directory, 'requires the directory.ldap capability');

    await login(page);
    await openDirectoryForm(page);

    for (const heading of ['Connection & authentication', 'Search parameters', 'Role mappings']) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }
  });

  test('field guidance is available from the keyboard', async ({ page }) => {
    test.skip(!directory, 'requires the directory.ldap capability');

    await login(page);
    await openDirectoryForm(page, { editing: true });

    await page.getByRole('button', { name: 'About the server URL' }).focus();
    await expect(page.getByRole('tooltip')).toContainText('ldaps://');
    await page.keyboard.press('Escape');
  });

  test('TLS verification is a switch, not a bare checkbox', async ({ page }) => {
    test.skip(!directory, 'requires the directory.ldap capability');

    await login(page);
    await openDirectoryForm(page);

    const toggle = page.getByRole('switch', { name: /Verify the directory/i });
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeChecked();
  });

  /**
   * Testing is not saving.
   *
   * The two buttons share an action bar by request. What must stay apart is the
   * RESULT: a green tick in the same strip as Save reads as confirmation that
   * saving happened.
   */
  test('the test result lands in its own panel, not in the action bar', async ({ page }) => {
    test.skip(!directory, 'requires the directory.ldap capability');

    await login(page);
    await openDirectoryForm(page, { editing: true });

    const heading = page.getByRole('heading', { name: 'Test this configuration' });
    await expect(heading).toBeVisible();

    const scope = heading.locator('xpath=ancestor::section[1]');
    await expect(scope.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Test connection/i })).toBeVisible();
  });
});
