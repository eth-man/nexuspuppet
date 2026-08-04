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
   * It used to render the whole form, accept a save, and explain in a warning
   * box that nothing would take effect. However honestly worded, an
   * open-source user fills in six fields, gets a success, finds nobody can
   * sign in, and concludes the product is broken.
   */
  test('core sees the real form, and can operate none of it', async ({ page }) => {
    test.skip(directory, 'this deployment can run a directory');

    await login(page);
    await page.goto('/settings/auth');

    /*
     * VISIBLE and INERT, which is the whole pattern. Hiding the form means
     * nobody can see what the feature is; leaving it usable means somebody
     * fills it in, saves, and finds later that nothing ran.
     */
    const url = page.getByRole('textbox', { name: /^Server URL/ });
    await expect(url).toBeVisible();
    await expect(url).toBeDisabled();

    /*
     * ABSENT, not merely disabled.
     *
     * The action bar sits outside the fieldset now — it has to, or the Edit
     * button disables itself — so a disabled bar in core would depend on props
     * rather than on the browser. Not rendering it is the stronger guarantee
     * and the simpler one: there is nothing to act on, so there are no
     * actions.
     */
    for (const name of ['Save', 'Test connection', 'Edit settings']) {
      await expect(page.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveCount(0);
    }

    await expect(page.getByRole('switch', { name: /Verify the directory/i })).toBeDisabled();

    // Said once, quietly, at the bottom.
    await expect(page.getByText('This feature requires NexusPuppet Enterprise.')).toBeVisible();
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
   */
  async function openDirectoryForm(page: import('@playwright/test').Page) {
    await page.goto('/settings/auth');

    const cta = page.getByRole('button', { name: 'Configure directory' });
    const url = page.getByRole('textbox', { name: /^Server URL/ });
    await expect(cta.or(url).first()).toBeVisible();
    if ((await cta.count()) > 0) await cta.click();
    await expect(url).toBeVisible();
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
    await openDirectoryForm(page);

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
    await openDirectoryForm(page);

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
    await openDirectoryForm(page);

    const heading = page.getByRole('heading', { name: 'Test this configuration' });
    await expect(heading).toBeVisible();

    const scope = heading.locator('xpath=ancestor::section[1]');
    await expect(scope.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Test connection/i })).toBeVisible();
  });
});
