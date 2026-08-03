import { expect, test } from '@playwright/test';
import { assertStackReachable, login } from './support';

/**
 * Light and dark (issue #72 slice 1).
 *
 * The assertions worth having here are the ones that fail silently otherwise:
 * a preference that does not survive a reload, a theme resolved late enough to
 * flash, and a component that hardcoded a colour and therefore stays dark on a
 * white page. None of those show up in a typecheck, and the last one is
 * invisible to anyone testing only in the theme they use.
 */
test.describe('theme', () => {
  test.beforeEach(async ({ request }) => {
    await assertStackReachable(request);
  });

  test('defaults to dark', async ({ page }) => {
    await login(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('a choice survives a reload', async ({ page }) => {
    await login(page);

    await page.getByRole('radio', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await page.reload();

    /*
     * The regression this catches: a theme applied only by React comes back
     * dark for a frame — or forever, if the preference was never stored.
     */
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('the palette actually changes, not just the attribute', async ({ page }) => {
    await login(page);

    const surfaceIn = async (theme: 'light' | 'dark') => {
      await page.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      return page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim(),
      );
    };

    const light = await surfaceIn('light');
    const dark = await surfaceIn('dark');

    expect(light).not.toBe('');
    expect(dark).not.toBe('');
    expect(light).not.toBe(dark);
  });

  /**
   * Nothing may hardcode a colour.
   *
   * A component written with `bg-slate-900` instead of `bg-panel` looks correct
   * for as long as only one theme exists, and becomes a dark rectangle on a
   * white page the moment the other one ships. Comparing the rendered pixels of
   * the same element across themes is what notices, because it asks the browser
   * rather than the source.
   */
  test('the chrome repaints in both themes', async ({ page }) => {
    await login(page);

    const backgroundOf = async (theme: 'light' | 'dark', selector: string) => {
      await page.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      return page
        .locator(selector)
        .first()
        .evaluate((node) => getComputedStyle(node).backgroundColor);
    };

    for (const selector of ['body', 'nav']) {
      const light = await backgroundOf('light', selector);
      const dark = await backgroundOf('dark', selector);
      expect(light, `${selector} did not repaint between themes`).not.toBe(dark);
    }
  });

  test('the interactive accent stays distinct from changed-status in light too', async ({
    page,
  }) => {
    await login(page);
    await page.getByRole('radio', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    const { accent, changed } = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        accent: style.getPropertyValue('--color-accent-interactive').trim(),
        changed: style.getPropertyValue('--color-state-changed').trim(),
      };
    });

    expect(accent).not.toBe('');
    expect(changed).not.toBe('');
    expect(accent).not.toBe(changed);
  });
});
