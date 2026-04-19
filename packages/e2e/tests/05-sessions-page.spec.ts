import { test, expect, dismissWidget } from './_fixtures';

test.describe('Sessions page', () => {
  test('renders without crashing on empty state', async ({ loggedInPage, env }) => {
    const page = loggedInPage;
    await page.goto(`/admin/#/app/${env.appId}/sessions`);

    // The page should mount — either an empty-state message, the filters bar,
    // or a table. Wait until *something* deterministic is visible.
    // Wait for any stable mount marker — the sessions page rolls multiple
    // top-level layouts depending on filter state. Use Locator.or() to chain
    // CSS + text-content matches; a comma-list mixing the two isn't supported.
    const settled = page
      .locator('.filters')
      .or(page.locator('.sessions-page'))
      .or(page.locator('table'))
      .or(page.getByText('No sessions'))
      .first();
    await expect(settled).toBeVisible({ timeout: 10_000 });
  });

  test('@visual sessions page baseline', async ({ loggedInPage, env }) => {
    const page = loggedInPage;
    await page.goto(`/admin/#/app/${env.appId}/sessions`);
    await dismissWidget(page);
    // Wait for any stable mount marker — the sessions page rolls multiple
    // top-level layouts depending on filter state. Use Locator.or() to chain
    // CSS + text-content matches; a comma-list mixing the two isn't supported.
    const settled = page
      .locator('.filters')
      .or(page.locator('.sessions-page'))
      .or(page.locator('table'))
      .or(page.getByText('No sessions'))
      .first();
    await expect(settled).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('sessions-page.png', {
      fullPage: false,
      mask: [
        page.locator('text=/\\b[0-9A-HJKMNP-TV-Z]{26}\\b/'),
        page.locator('text=/ago$|seconds|minute|hour/'),
      ],
    });
  });
});
