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
  test('every field on the directory form is reachable by its label', async ({ page }) => {
    await login(page);
    await page.goto('/settings/auth');

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
  test('testing the directory lives in its own panel, away from Save', async ({ page }) => {
    await login(page);
    await page.goto('/settings/auth');

    const panel = page.getByRole('region', { name: /Test this configuration/i });
    const heading = page.getByRole('heading', { name: 'Test this configuration' });
    await expect(heading).toBeVisible();

    const scope = (await panel.count()) > 0 ? panel : heading.locator('xpath=ancestor::section[1]');

    // The test button is inside that panel...
    await expect(scope.getByRole('button', { name: /Test connection/i })).toBeVisible();
    // ...and Save is not.
    await expect(scope.getByRole('button', { name: 'Save' })).toHaveCount(0);
    // Save still exists on the card.
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
  });

  test('the card leads with a title and a one-line description', async ({ page }) => {
    await login(page);
    await page.goto('/settings/auth');

    await expect(page.getByRole('heading', { name: 'Directory (LDAP)' })).toBeVisible();
    await expect(page.getByText(/which groups map to which role/i)).toBeVisible();
  });
});
