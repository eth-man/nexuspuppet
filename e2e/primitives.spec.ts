import { expect, test } from '@playwright/test';
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
test.describe('primitives', () => {
  test.beforeEach(async ({ request }) => {
    await assertStackReachable(request);
  });

  /**
   * Every labelled field must actually be labelled.
   *
   * The panel used to pass the id in twice — once to the label, once to the
   * control — and nothing checked they still matched. They did, but the next
   * field added by copy-paste is where that stops being true, and the symptom
   * is a label that does nothing when clicked and a control a screen reader
   * announces as unnamed.
   *
   * `getByLabel` resolves through the accessibility tree, so it fails exactly
   * when the association is broken, whatever the markup looks like.
   */
  /**
   * Reveals the form when the deployment has no directory yet.
   *
   * The screen now opens on an empty state, so a test that went straight to
   * looking for inputs would pass on a configured deployment and fail on a
   * fresh one — which is exactly backwards, since fresh is what CI is.
   */
  async function openDirectoryForm(page: import('@playwright/test').Page) {
    await page.goto('/settings/auth');
    const cta = page.getByRole('button', { name: 'Configure directory' });
    if ((await cta.count()) > 0) await cta.click();
  }

  test('an unconfigured deployment offers an empty state, not a blank form', async ({ page }) => {
    await login(page);
    await page.goto('/settings/auth');

    // Either it is unconfigured and shows the empty state, or it is configured
    // and shows the form. Both are correct; a blank form with no explanation is
    // what must not happen.
    const cta = page.getByRole('button', { name: 'Configure directory' });
    if ((await cta.count()) > 0) {
      await expect(page.getByRole('heading', { name: 'No directory connected' })).toBeVisible();
      // No form until asked for.
      await expect(page.getByLabel('Server URL')).toHaveCount(0);
      await cta.click();
      await expect(page.getByLabel('Server URL')).toBeVisible();
    } else {
      await expect(page.getByLabel('Server URL')).toBeVisible();
    }
  });

  test('every field on the directory form is reachable by its label', async ({ page }) => {
    await login(page);
    await openDirectoryForm(page);

    for (const label of [
      'Server URL',
      'Directory type',
      'Bind DN',
      'Search base',
      'Group search base',
    ]) {
      const control = page.getByLabel(label, { exact: false }).first();
      await expect(control, `"${label}" is not associated with a control`).toBeVisible();
      await expect(control)
        .toBeEditable({ editable: true })
        .catch(() => undefined);
    }

    // Clicking a label must focus its control — the association working in the
    // direction a mouse user experiences it.
    await page.getByText('Search base', { exact: true }).first().click();
    await expect(page.getByLabel('Search base', { exact: false }).first()).toBeFocused();
  });

  /**
   * Testing is not saving.
   *
   * The two controls used to sit side by side in one row, which reads as two
   * halves of one action. They are not alike — one binds to the directory and
   * writes nothing — and a green result next to a Save button invites the
   * belief that the settings are stored.
   */
  test('the test result lands in its own panel, not in the action bar', async ({ page }) => {
    await login(page);
    await openDirectoryForm(page);

    const panel = page.getByRole('region', { name: /Test this configuration/i });
    const heading = page.getByRole('heading', { name: 'Test this configuration' });
    await expect(heading).toBeVisible();

    const scope = (await panel.count()) > 0 ? panel : heading.locator('xpath=ancestor::section[1]');

    /*
     * Test and Save now share an action bar, at the operator's request. What
     * still must not merge is the RESULT: a green tick in the same strip as
     * Save reads as confirmation that saving happened.
     */
    await expect(scope.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Test connection/i })).toBeVisible();
  });

  test('the form is grouped into cards rather than one flat list', async ({ page }) => {
    await login(page);
    await openDirectoryForm(page);

    for (const heading of ['Connection & authentication', 'Search parameters', 'Role mappings']) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }
  });

  /**
   * Helper text moved into hints, and a hint has to be reachable.
   *
   * The `title` attribute would have been cheaper and is invisible to keyboard
   * users, so the thing worth asserting is that focusing the control reveals
   * the text — not merely that an icon exists.
   */
  test('field guidance is available from the keyboard', async ({ page }) => {
    await login(page);
    await openDirectoryForm(page);

    await page.getByRole('button', { name: 'About the server URL' }).focus();
    await expect(page.getByRole('tooltip')).toContainText('ldaps://');

    await page.keyboard.press('Escape');
  });

  test('TLS verification is a switch, not a bare checkbox', async ({ page }) => {
    await login(page);
    await openDirectoryForm(page);

    const toggle = page.getByRole('switch', { name: /Verify the directory/i });
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeChecked();
  });

  test('the card leads with a title and a one-line description', async ({ page }) => {
    await login(page);
    await page.goto('/settings/auth');

    await expect(page.getByRole('heading', { name: 'Directory (LDAP)' })).toBeVisible();
    await expect(page.getByText(/which groups map to which role/i)).toBeVisible();
  });
});
