import { test, expect, dismissWidget } from './_fixtures';

test.describe('Auth + landing', () => {
  test('login form renders and submits to feedback list', async ({ page, env }) => {
    await page.goto('/admin/');
    await expect(page.getByRole('heading', { name: 'Admin Login' })).toBeVisible();

    const username = page.locator('input[type="text"]').first();
    const password = page.locator('input[type="password"]').first();
    await username.fill(env.adminUser);
    await password.fill(env.adminPass);
    await page.getByRole('button', { name: /Login/ }).click();

    await page.waitForFunction(() => !!localStorage.getItem('pw-admin-token'), null, { timeout: 5_000 });
    expect(await page.evaluate(() => localStorage.getItem('pw-admin-token'))).toBeTruthy();

    // Land on default route — admin SPA either lands on /, getting started,
    // or our seeded app's feedback page. Navigate explicitly to the seeded app
    // so the assertion is stable across both empty and seeded environments.
    await page.goto(`/admin/#/app/${env.appId}/feedback`);
    await expect(page.locator('table').first()).toBeVisible({ timeout: 10_000 });
  });

  test('login rejects bad credentials with inline error', async ({ page }) => {
    await page.goto('/admin/');
    await page.locator('input[type="text"]').first().fill('admin');
    await page.locator('input[type="password"]').first().fill('definitely-wrong');
    await page.getByRole('button', { name: /Login/ }).click();
    // The api.ts client converts 401 → "Unauthorized" before it reaches the
    // login form, so we accept either the raw server message or that wrapper.
    await expect(page.locator('.error-msg')).toContainText(/Invalid credentials|HTTP 401|Unauthorized/);
  });

  test('@visual login page baseline', async ({ page }) => {
    await page.goto('/admin/');
    await dismissWidget(page);
    await expect(page.locator('.login-card')).toBeVisible();
    await expect(page).toHaveScreenshot('login-page.png', {
      fullPage: false,
      mask: [page.locator('.login-card .error-msg')],
    });
  });
});
