import { expect, test, type Page } from '@playwright/test';
import { assertStackReachable, login } from './support';

/**
 * Card and control primitives (issue #72 slice 3), asserted through the screen
 * that uses them.
 *
 * The properties worth testing are the ones a restyle silently breaks: a label
 * that stops being associated with its control, and a sub-task that drifts back
 * into the row with the Save button. Neither shows up in a typecheck, and the
 * first is invisible to anyone not using a screen reader.
 */
/**
 * The LDAP card's region (ADR-0029).
 *
 * BOTH directories are always on this page now, and their cards share titles —
 * each has "Role mappings", each has "Edit settings". Unscoped, those locators
 * match twice and fail on strict mode rather than on anything under test; that
 * is exactly how four of these tests failed whenever OIDC was also configured.
 * Everything about the LDAP form is asked of this region.
 */
const ldap = (page: Page) => page.getByRole('region', { name: 'Directory (LDAP)' });

test.describe('primitives', () => {
  test.beforeEach(async ({ request }) => {
    await assertStackReachable(request);
  });

  /**
   * The user report that started ADR-0029: an upgraded install showed
   * "NOT ENABLED — set LDAP_URL and restart", so directory sign-in could only
   * be turned on by editing .env. Now both directories are always configurable
   * here, each says where its configuration comes from, and neither tells the
   * operator to restart anything.
   */
  test('both directories are always configurable, with where their settings come from', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/settings/auth');

    const sso = page.getByRole('region', { name: 'Single sign-on (OIDC)' });
    await expect(ldap(page)).toBeVisible();
    await expect(sso).toBeVisible();

    for (const region of [ldap(page), sso]) {
      await expect(
        region.getByText(/^(Not configured|From the environment|Saved in the console)$/),
      ).toBeVisible();
    }

    await expect(page.getByText(/Set (LDAP_URL|OIDC_ISSUER)/)).toHaveCount(0);
    await expect(page.getByText(/restart the API|restart once/i)).toHaveCount(0);
  });

  /**
   * Disabled has to mean disabled, not merely look it.
   *
   * A `pointer-events-none` class or a lowered opacity would pass a visual
   * review and still let a keyboard user tab into the field and type. The
   * fieldset is what actually prevents that, and this is the assertion that
   * notices if somebody replaces it with styling.
   */
  test('a locked directory form cannot be typed into', async ({ page }) => {
    /*
     * This guards against somebody replacing the `<fieldset disabled>` with
     * styling that only looks inert while a keyboard user tabs in and types.
     * The locked state is the resting state of a CONFIGURED directory, so this
     * one saves a configuration first — and puts the deployment back after.
     */
    await login(page);
    await withStoredDirectory(page, async () => {
      await page.goto('/settings/auth');

      const url = ldap(page).getByRole('textbox', { name: /^Server URL/ });
      await expect(url).toBeVisible();
      await expect(url).not.toBeEditable();
    });
  });

  /**
   * Store a minimal LDAP configuration for the duration of `run`, through the
   * same API the console uses, and discard it afterwards whatever happens.
   *
   * No bind password: CI runs without CONFIG_ENCRYPTION_KEY, and an anonymous
   * search configuration is enough to put the form into its resting state.
   * Discarding returns the deployment to whatever it was — the environment
   * baseline, or dormant (ADR-0029).
   */
  async function withStoredDirectory(page: Page, run: () => Promise<void>): Promise<void> {
    const saved = await page.request.put('/api/settings/auth/ldap', {
      data: {
        url: 'ldaps://directory.e2e.invalid:636',
        searchBase: 'ou=people,dc=e2e,dc=invalid',
        roleMappings: [],
      },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    try {
      await run();
    } finally {
      await page.request.delete('/api/settings/auth/ldap');
    }
  }

  /**
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

    const region = ldap(page);
    const cta = region.getByRole('button', { name: 'Configure directory' });
    const url = region.getByRole('textbox', { name: /^Server URL/ });
    await expect(cta.or(url).first()).toBeVisible();
    if ((await cta.count()) > 0) await cta.click();
    await expect(url).toBeVisible();

    if (!editing) return;

    // Absent on a deployment that arrived through the empty-state CTA — that
    // path opens straight into an editable form, since there is nothing yet to
    // protect from an accidental keystroke.
    const edit = region.getByRole('button', { name: 'Edit settings' });
    if ((await edit.count()) > 0) await edit.click();
    await expect(url).toBeEditable();
  }

  test('an unconfigured deployment offers an empty state, not a blank form', async ({ page }) => {
    await login(page);
    await page.goto('/settings/auth');

    const region = ldap(page);
    const cta = region.getByRole('button', { name: 'Configure directory' });
    const url = region.getByRole('textbox', { name: /^Server URL/ });
    await expect(cta.or(url).first()).toBeVisible();

    if ((await cta.count()) > 0) {
      await expect(region.getByRole('heading', { name: 'No directory connected' })).toBeVisible();
      await expect(region.getByText('Not configured', { exact: true })).toBeVisible();
      await expect(url).toHaveCount(0);
      await cta.click();
      // Straight into an editable form: there is nothing yet to protect.
      await expect(url).toBeEditable();
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
    await login(page);
    await openDirectoryForm(page, { editing: true });

    for (const label of [
      'Server URL',
      'Bind DN',
      'Search base',
      'Group search base',
      'CA certificate',
    ]) {
      const control = ldap(page)
        .getByRole('textbox', { name: new RegExp(`^${label}`) })
        .first();
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
    const searchBase = ldap(page)
      .getByRole('textbox', { name: /^Search base/ })
      .first();
    const id = await searchBase.getAttribute('id');
    expect(id, 'the control has no id, so no label can point at it').toBeTruthy();

    await page.locator(`label[for="${id}"]`).click();
    await expect(searchBase).toBeFocused();
  });

  test('the form is grouped into cards rather than one flat list', async ({ page }) => {
    await login(page);
    await openDirectoryForm(page);

    for (const heading of ['Connection & authentication', 'Search parameters', 'Role mappings']) {
      await expect(ldap(page).getByRole('heading', { name: heading })).toBeVisible();
    }
  });

  test('field guidance is available from the keyboard', async ({ page }) => {
    await login(page);
    await openDirectoryForm(page, { editing: true });

    await ldap(page).getByRole('button', { name: 'About the server URL' }).focus();
    await expect(page.getByRole('tooltip')).toContainText('ldaps://');
    await page.keyboard.press('Escape');
  });

  test('TLS verification is a switch, not a bare checkbox', async ({ page }) => {
    await login(page);
    await openDirectoryForm(page);

    const toggle = ldap(page).getByRole('switch', { name: /Verify the directory/i });
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
    await login(page);
    await openDirectoryForm(page, { editing: true });

    const region = ldap(page);
    const heading = region.getByRole('heading', { name: 'Test this configuration' });
    await expect(heading).toBeVisible();

    const scope = heading.locator('xpath=ancestor::section[1]');
    await expect(scope.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(region.getByRole('button', { name: 'Save' })).toBeVisible();
    await expect(region.getByRole('button', { name: /Test connection/i })).toBeVisible();
  });

  const PEM_DASHES = '-----';

  /**
   * A CA is pasted, not mounted (ADR-0029 §5), and a private key pasted into
   * that box is refused with a message that says so — by the API, which is the
   * control; the form only relays it.
   */
  test('a private key pasted as the CA is refused, by name', async ({ page }) => {
    await login(page);

    const refused = await page.request.put('/api/settings/auth/ldap', {
      data: {
        url: 'ldaps://directory.e2e.invalid:636',
        searchBase: 'ou=people,dc=e2e,dc=invalid',
        // Assembled, not written out: CI fails any commit containing a literal
        // private-key header, and that guard is worth more than this fixture.
        caPem: [
          `${PEM_DASHES}BEGIN`,
          `PRIVATE KEY${PEM_DASHES}\nMIIE\n${PEM_DASHES}END`,
          `PRIVATE KEY${PEM_DASHES}\n`,
        ].join(' '),
      },
    });

    expect(refused.status()).toBe(400);
    expect(await refused.text()).toMatch(/private key/i);
  });
});
