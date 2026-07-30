import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { assertStackReachable, login } from './support';

/**
 * The pages nobody means to visit.
 *
 * Found by the QA fuzzer: an unknown route dropped the operator on Next's
 * built-in 404 — white, system font, no navigation, no indication of which
 * product it belonged to. Nothing was broken; the product had simply stopped
 * being on screen. A stale bookmark, a link in an old runbook and a URL
 * truncated by a chat client all arrive here.
 */
test.describe('error boundaries', () => {
  test.beforeAll(async ({ request }) => {
    await assertStackReachable(request);
  });

  test('an unknown URL renders the branded 404, not the Next.js default', async ({ page }) => {
    const response = await page.goto('/no-such-page-exists');

    // A styled page answering 200 would be worse than the default one, because
    // crawlers and uptime checks believe it.
    expect(response?.status()).toBe(404);

    await expect(page.getByText('This page does not exist')).toBeVisible();
    await expect(page.getByRole('link', { name: /dashboard/i })).toBeVisible();

    // Being IN the product is the actual finding, so assert the theme too —
    // the copy alone would pass on a white page with the right words on it.
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).not.toBe('rgb(255, 255, 255)');
  });

  test('the 404 link leads somewhere real', async ({ page }) => {
    // A link existing is not a link working, and a dead-ending 404 is the
    // finding rather than the copy on it.
    await login(page);
    await page.goto('/no-such-page-exists');
    await page.getByRole('link', { name: /dashboard/i }).click();

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  /**
   * Note on what is NOT asserted here.
   *
   * An unmatched URL renders the ROOT not-found even for a signed-in operator,
   * without the console shell. That is Next's behaviour and not a defect: it
   * resolves the root file outside every route group, so it cannot know the
   * visitor belongs inside `(app)`.
   *
   * An earlier version of this file asserted the sidebar survived an unknown
   * route, and a `(app)/not-found.tsx` was written to satisfy it. Running it
   * showed the file was unreachable — nothing calls `notFound()` — so it was
   * deleted rather than kept as coverage that covers nothing.
   */
  test('a group that does not exist reads as absence, not failure', async ({ page }) => {
    // Generated, never hardcoded. The first version of this test used a
    // "made-up" UUID that turned out to be a real fixture group, so it opened
    // that group and asserted nothing at all.
    const absent = randomUUID();

    await login(page);
    await page.goto(`/classification/${absent}`);

    await expect(page.getByText(/could not be found/i)).toBeVisible();
    // It used to render the red "Request failed" banner — the same treatment a
    // 500 gets — which sends operators looking for an outage that is not
    // happening.
    await expect(page.getByText('Request failed')).toBeHidden();
    // The console shell survives, so they have not lost their place.
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  });
});
