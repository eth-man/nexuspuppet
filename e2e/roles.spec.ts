import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { apiLogin, assertStackReachable, login } from './support';

/**
 * The roles screen (ADR-0018).
 *
 * This suite exists for one property above all others: **the table does not
 * mutate**. An earlier version toggled permissions inline, so a mis-aimed click
 * in a list of eight chips granted or revoked `settings:manage` immediately,
 * with no confirmation and no undo. That is a one-character diff away from
 * coming back — swapping a <span> for a <button> reads like a tidy-up — and
 * nothing else in the suite would notice.
 *
 * So the assertions here are about REQUESTS, not appearance. Counting the
 * mutating calls the page makes is the only check that fails when the anti-
 * pattern returns, whatever the markup happens to look like.
 */

/** Records every mutating call to the roles API for the life of the page. */
function watchRoleMutations(page: Page): { calls: string[] } {
  const calls: string[] = [];
  page.on('request', (request) => {
    const method = request.method();
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) return;
    if (!/\/api\/roles(\/|$|\?)/.test(request.url())) return;
    calls.push(`${method} ${new URL(request.url()).pathname}`);
  });
  return { calls };
}

/** True when the deployment advertises `rbac.custom`, i.e. roles are editable. */
async function rolesAreEditable(request: APIRequestContext): Promise<boolean> {
  await apiLogin(request);
  const response = await request.get('/api/capabilities');
  if (!response.ok()) return false;
  const body = (await response.json()) as { capabilities?: string[] };
  return body.capabilities?.includes('rbac.custom') === true;
}

const SCRATCH_PREFIX = 'e2e.roles.';

async function createScratchRole(request: APIRequestContext, permissions: string[]) {
  await apiLogin(request);
  const name = `${SCRATCH_PREFIX}${Date.now().toString(36)}`;
  const response = await request.post('/api/roles', { data: { name, permissions } });
  expect(response.ok(), `could not create scratch role: ${response.status()}`).toBe(true);
  return { name, id: ((await response.json()) as { id: string }).id };
}

async function deleteScratchRoles(request: APIRequestContext): Promise<void> {
  await apiLogin(request);
  const response = await request.get('/api/roles');
  if (!response.ok()) return;
  const roles = (await response.json()) as Array<{ id: string; name: string }>;
  for (const role of roles.filter((r) => r.name.startsWith(SCRATCH_PREFIX))) {
    await request.delete(`/api/roles/${role.id}`);
  }
}

test.describe('roles', () => {
  test.beforeEach(async ({ request }) => {
    await assertStackReachable(request);
  });

  test.afterAll(async ({ request }) => {
    await deleteScratchRoles(request);
  });

  test('the table renders roles without any inline permission control', async ({ page }) => {
    const watcher = watchRoleMutations(page);
    await login(page);
    await page.goto('/settings/users');

    const table = page.getByRole('table').filter({ has: page.getByText('Permissions') });
    await expect(table).toBeVisible();
    await expect(table.getByText('ADMIN', { exact: true })).toBeVisible();

    /*
     * The permission chips must not be buttons, checkboxes, or anything else
     * with a press behaviour. Querying by ROLE rather than by class is what
     * makes this survive a restyle: it asks the accessibility tree "is there
     * something pressable here", which is the actual question.
     */
    await expect(table.getByRole('button', { name: /settings:manage/i })).toHaveCount(0);
    await expect(table.getByRole('checkbox')).toHaveCount(0);

    // Clicking a chip opens the editor. It must not change anything.
    await table.getByText('settings:manage', { exact: true }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();

    expect(watcher.calls, 'the table must not mutate roles').toEqual([]);
  });

  test('the editor explains what each permission grants', async ({ page }) => {
    await login(page);
    await page.goto('/settings/users');

    await page.getByRole('button', { name: /^(Edit|View) ADMIN$/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // The key is not enough on its own; the consequence has to be spelled out.
    await expect(dialog.getByText('settings:manage', { exact: true })).toBeVisible();
    await expect(dialog.getByText(/grant itself anything/i)).toBeVisible();
    await expect(dialog.getByText(/changes managed infrastructure/i)).toBeVisible();
    await expect(dialog.getByText(/administrative/i).first()).toBeVisible();
  });

  /**
   * A closed <dialog> must stay closed.
   *
   * The browser hides one with `dialog:not([open]) { display: none }`, which any
   * unconditional display utility on the element outranks. Adding a bare `flex`
   * to the shared Dialog once did exactly that, and every closed dialog on this
   * screen — new user, reset password, delete user — rendered inline down the
   * page at once. It typechecks, it lints, and no assertion about the open
   * dialog notices, because the open one is still perfectly correct.
   */
  test('no closed dialog renders', async ({ page }) => {
    await login(page);

    for (const path of ['/settings/users', '/classification', '/']) {
      await page.goto(path);
      await expect(page.locator('main')).not.toBeEmpty();

      const leaked = await page.evaluate(() =>
        [...document.querySelectorAll('dialog')]
          .filter((node) => !node.open && getComputedStyle(node).display !== 'none')
          .map((node) => node.querySelector('h2')?.textContent ?? '(untitled)'),
      );

      expect(leaked, `closed dialogs rendered on ${path}`).toEqual([]);
    }
  });

  test('a built-in role cannot be renamed', async ({ page }) => {
    await login(page);
    await page.goto('/settings/users');

    await page.getByRole('button', { name: /^(Edit|View) ADMIN$/ }).click();
    const dialog = page.getByRole('dialog');

    // No name input at all — not a disabled one that a later change re-enables.
    await expect(dialog.getByLabel('Name')).toHaveCount(0);
    await expect(dialog.getByText(/the name cannot/i)).toBeVisible();
  });

  /**
   * Editing needs the `rbac.custom` capability, which core-only deployments —
   * including CI — do not have. These tests skip there rather than fail, but the
   * read-only assertions above still run everywhere, so the anti-pattern guard
   * is never the part that gets skipped.
   *
   * The probe runs once in beforeAll: `test.skip()` in describe scope cannot
   * take an async condition, so the flag has to be resolved before the bodies.
   */
  test.describe('when roles are editable', () => {
    let editable = false;

    test.beforeAll(async ({ request }) => {
      editable = await rolesAreEditable(request);
    });

    test('a permission change is not committed until Save', async ({ page, request }) => {
      test.skip(!editable, 'requires the rbac.custom capability');
      const scratch = await createScratchRole(request, ['inventory:read']);

      const watcher = watchRoleMutations(page);
      await login(page);
      await page.goto('/settings/users');

      await page.getByRole('button', { name: `Edit ${scratch.name}` }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();

      await dialog.getByRole('checkbox', { name: /Puppet run reports/i }).check();

      // The whole point of the redesign: the tick is local until committed.
      await expect(dialog.getByText('Pending changes')).toBeVisible();
      await expect(dialog.getByText(/Granting/)).toBeVisible();
      expect(watcher.calls, 'ticking a box must not reach the API').toEqual([]);

      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      expect(watcher.calls, 'Cancel must discard, not save').toEqual([]);

      // And the discard was real, not merely uncommitted in the UI.
      const after = await request.get(`/api/roles`);
      const roles = (await after.json()) as Array<{ name: string; permissions: string[] }>;
      const reloaded = roles.find((r) => r.name === scratch.name);
      expect(reloaded?.permissions).toEqual(['inventory:read']);
    });

    test('Save commits exactly one update', async ({ page, request }) => {
      test.skip(!editable, 'requires the rbac.custom capability');
      const scratch = await createScratchRole(request, ['inventory:read']);

      const watcher = watchRoleMutations(page);
      await login(page);
      await page.goto('/settings/users');

      await page.getByRole('button', { name: `Edit ${scratch.name}` }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('checkbox', { name: /Puppet run reports/i }).check();
      await dialog.getByRole('button', { name: 'Save changes' }).click();

      await expect(dialog).toBeHidden();

      // Exactly one. A double-submit here would be invisible in the UI and would
      // show up only as duplicated audit rows.
      expect(watcher.calls).toEqual([`PATCH /api/roles/${scratch.id}`]);

      const after = await request.get('/api/roles');
      const roles = (await after.json()) as Array<{ name: string; permissions: string[] }>;
      const reloaded = roles.find((r) => r.name === scratch.name);
      expect(reloaded?.permissions.sort()).toEqual(['inventory:read', 'reports:read']);
    });

    test('Save stays disabled until something actually changes', async ({ page, request }) => {
      test.skip(!editable, 'requires the rbac.custom capability');
      const scratch = await createScratchRole(request, ['inventory:read']);

      await login(page);
      await page.goto('/settings/users');
      await page.getByRole('button', { name: `Edit ${scratch.name}` }).click();

      const dialog = page.getByRole('dialog');
      const save = dialog.getByRole('button', { name: 'Save changes' });
      await expect(save).toBeDisabled();

      await dialog.getByRole('checkbox', { name: /Puppet run reports/i }).check();
      await expect(save).toBeEnabled();

      // Back to the original set — no net change, so nothing to commit.
      await dialog.getByRole('checkbox', { name: /Puppet run reports/i }).uncheck();
      await expect(save).toBeDisabled();
    });

    test('deleting asks first', async ({ page, request }) => {
      test.skip(!editable, 'requires the rbac.custom capability');
      const scratch = await createScratchRole(request, ['inventory:read']);

      const watcher = watchRoleMutations(page);
      await login(page);
      await page.goto('/settings/users');

      await page.getByRole('button', { name: `Edit ${scratch.name}` }).click();
      const dialog = page.getByRole('dialog');

      await dialog.getByRole('button', { name: `Delete ${scratch.name}` }).click();
      // First click only arms it.
      expect(watcher.calls).toEqual([]);
      await expect(dialog.getByRole('button', { name: /^Yes, delete/ })).toBeVisible();

      await dialog.getByRole('button', { name: 'Keep it' }).click();
      expect(watcher.calls, 'backing out must not delete').toEqual([]);
    });
  });
});
