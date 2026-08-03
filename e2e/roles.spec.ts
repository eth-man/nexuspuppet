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

  /**
   * Built-in roles are fixed (ADR-0018 §1).
   *
   * The API refuses to redefine one, so a console that offered the controls
   * would be offering an action that always fails. More to the point, the
   * reason has to be legible: an operator who wants "ADMIN without pql:raw"
   * needs to be told to build their own role, not left clicking a Save button
   * that 409s.
   */
  test('a built-in role cannot be edited', async ({ page }) => {
    await login(page);
    await page.goto('/settings/users');

    // The action itself says View, before anything is opened.
    await expect(page.getByRole('button', { name: 'View ADMIN' })).toBeVisible();
    await page.getByRole('button', { name: 'View ADMIN' }).click();
    const dialog = page.getByRole('dialog');

    // No name input at all — not a disabled one that a later change re-enables.
    await expect(dialog.getByLabel('Name')).toHaveCount(0);
    await expect(dialog.getByText(/fixed by the product/i)).toBeVisible();

    // Nothing that could commit a change.
    await expect(dialog.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: /^Delete/ })).toHaveCount(0);

    // Every permission control is present but inert, so the role is still
    // legible — the point is to show what ADMIN grants, not to hide it.
    const boxes = dialog.getByRole('checkbox');
    const count = await boxes.count();
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      await expect(boxes.nth(index)).toBeDisabled();
    }
  });

  /**
   * Assigning a role to a user is a privilege change on a PERSON.
   *
   * Choosing from the dropdown used to write immediately. One stray click
   * demoted this deployment's local administrator during review — no
   * confirmation, no statement of what changed, no undo. The <Select> must
   * stage the intent and keep showing the saved role until somebody commits.
   */
  test('changing a user role asks before it writes', async ({ page, request }) => {
    /*
     * Provisions its OWN subject rather than looking for one.
     *
     * The first version skipped when it could not find another local user, and
     * CI has exactly one — the bootstrap admin, whose control is disabled
     * because changing your own role is refused. So the guard for the bug it
     * was written for never ran anywhere it mattered.
     */
    await apiLogin(request);
    const email = `e2e.role.${Date.now().toString(36)}@example.com`;
    const created = await request.post('/api/users', {
      data: {
        email,
        displayName: 'Role change subject',
        role: 'VIEWER',
        authSource: 'local',
        password: 'a-sufficiently-long-password',
      },
    });
    expect(created.status(), 'could not provision a subject').toBe(201);
    const subject = (await created.json()) as { id: string };

    const calls: string[] = [];
    page.on('request', (outgoing) => {
      if (outgoing.method() !== 'PATCH') return;
      if (!/\/api\/users\//.test(outgoing.url())) return;
      calls.push(`PATCH ${new URL(outgoing.url()).pathname}`);
    });

    try {
      await login(page);
      await page.goto('/settings/users');

      const select = page.getByRole('combobox', { name: `Role for ${email}` });
      await expect(select).toBeVisible();
      await expect(select).toHaveValue('VIEWER');

      await select.selectOption('OPERATOR');

      // A confirmation, and nothing written yet.
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Change role' })).toBeVisible();
      expect(calls, 'selecting a role must not write').toEqual([]);

      // It has to say what actually changes, not just name two roles.
      await expect(dialog.getByText(/will (gain|lose)/i).first()).toBeVisible();

      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      expect(calls, 'cancelling must not write').toEqual([]);

      // And the control shows what is actually in force, not a change that
      // never happened.
      await expect(select).toHaveValue('VIEWER');

      // Committing writes once, and only once.
      await select.selectOption('OPERATOR');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Change role' }).click();
      await expect(dialog).toBeHidden();
      expect(calls).toEqual([`PATCH /api/users/${subject.id}`]);
      await expect(select).toHaveValue('OPERATOR');
    } finally {
      await request.delete(`/api/users/${subject.id}/permanent`);
    }
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
