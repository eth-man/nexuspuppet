import { expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Shared helpers.
 *
 * Credentials come from the environment so the suite can run against any
 * deployment, defaulting to what `scripts/dev/stack.sh` bootstraps.
 */

export const ADMIN_EMAIL = process.env['E2E_ADMIN_EMAIL'] ?? 'admin@example.com';
/**
 * No default.
 *
 * A hardcoded fallback is a credential in the repository, and it goes stale the
 * moment the password is rotated — after which every test fails at the login
 * step with an error about a button never becoming enabled, nowhere near the
 * actual cause.
 */
export const ADMIN_PASSWORD = (() => {
  const password = process.env['E2E_ADMIN_PASSWORD'];
  if (password === undefined || password === '') {
    throw new Error('E2E_ADMIN_PASSWORD is not set. Export it before running the suite.');
  }
  return password;
})();

/**
 * A certname the fixtures are known to contain.
 *
 * `db01.example.com` is the first node scripts/generate-fixtures.mjs emits and
 * the one the factset fixture belongs to, so it is the safest anchor for
 * assertions about rendering.
 */
export const KNOWN_CERTNAME = 'db01.example.com';

/**
 * Every test that creates classification state uses a unique, prefixed name.
 *
 * The suite runs against a live stack that a human may also be using. A fixed
 * name would collide with a leftover from a failed run and fail on a
 * uniqueness constraint rather than on the thing under test; the prefix makes
 * strays identifiable and safe to sweep.
 */
export function uniqueGroupName(label: string): string {
  return `e2e-${label}-${Date.now().toString(36)}`;
}

export async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await Promise.all([page.waitForURL('/'), page.getByRole('button', { name: 'Sign in' }).click()]);
}

/**
 * Authenticate an APIRequestContext.
 *
 * The `request` fixture is a SEPARATE context from the browser's — it does not
 * inherit the cookies `login()` established on a page. Without this, every
 * authenticated API call from a hook silently 401s.
 */
export async function apiLogin(request: APIRequestContext): Promise<void> {
  const response = await request.post('/api/auth/login', {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(response.ok(), `API login failed: ${response.status()}`).toBe(true);
}

/**
 * Remove anything this suite created, by prefix.
 *
 * Deleting through the API rather than the database keeps the cleanup honest:
 * it exercises the same capture-affected-nodes path a real delete takes, and it
 * cannot leave the ENC tree inconsistent with Postgres.
 *
 * This ASSERTS rather than returning quietly on failure. An earlier version
 * bailed out silently when the listing 401'd, so seventeen groups accumulated
 * across runs while the suite reported success — cleanup that cannot fail is
 * cleanup that never runs.
 */
export async function deleteGroupsByPrefix(
  request: APIRequestContext,
  prefix = 'e2e-',
): Promise<void> {
  await apiLogin(request);

  const response = await request.get('/api/node-groups');
  expect(response.ok(), `could not list groups to clean up: ${response.status()}`).toBe(true);

  const groups = (await response.json()) as Array<{ id: string; name: string }>;
  for (const group of groups.filter((g) => g.name.startsWith(prefix))) {
    const deleted = await request.delete(`/api/node-groups/${group.id}`);
    // 404 is fine: a test may have deleted its own group already.
    expect(
      [202, 404].includes(deleted.status()),
      `failed to clean up ${group.name}: ${deleted.status()}`,
    ).toBe(true);
  }
}

/** Asserts the stack is up before a suite runs, so a dead stack fails loudly. */
export async function assertStackReachable(request: APIRequestContext): Promise<void> {
  const response = await request.get('/api/auth/mode');
  expect(
    response.ok(),
    'The console is not reachable. Start it with `npm run dev:stack` before running E2E tests.',
  ).toBe(true);
}
