import { test, expect } from './_fixtures';

test.describe('Widget programmatic submit', () => {
  test('POST /api/v1/feedback round-trips into the admin list', async ({ page, env, baseURL, request }) => {
    // Submit programmatic feedback as if the widget had POSTed it. Uses the
    // X-API-Key header path (resolveAppId in routes/feedback.ts).
    const target = baseURL || 'http://localhost:3001';
    const uniqueTitle = `widget-e2e-${Date.now()}`;
    const submitRes = await request.post(`${target}/api/v1/feedback/programmatic`, {
      headers: { 'X-API-Key': env.apiKey, 'Content-Type': 'application/json' },
      data: {
        title: uniqueTitle,
        description: 'Submitted by Playwright via /api/v1/feedback/programmatic',
        type: 'manual',
        sourceUrl: 'http://localhost/e2e',
        userAgent: 'playwright-e2e',
      },
    });
    expect(submitRes.status(), await submitRes.text()).toBe(201);
    const { id, appId } = await submitRes.json();
    expect(appId).toBe(env.appId);

    // Now confirm the new item appears in the admin feedback list UI.
    // Stash auth and load the page.
    const loginRes = await request.post(`${target}/api/v1/auth/login`, {
      data: { username: env.adminUser, password: env.adminPass },
    });
    const { token } = await loginRes.json();

    await page.context().addInitScript((t: string) => {
      try { localStorage.setItem('pw-admin-token', t); } catch {}
    }, token);
    await page.goto(`/admin/#/app/${env.appId}/feedback`);
    // Search for the unique title to avoid pagination flakiness
    const searchInput = page.locator('.filters input[placeholder="Search..."]').first();
    await expect(searchInput).toBeVisible({ timeout: 10_000 });
    await searchInput.fill(uniqueTitle);
    await searchInput.press('Enter');

    await expect(page.locator(`a[href="#/app/${env.appId}/feedback/${id}"]`)).toBeVisible({
      timeout: 5_000,
    });
  });

  test('widget script is served on admin pages', async ({ page }) => {
    await page.goto('/admin/');
    // The admin index.html has a widget <script> that points to /widget/propanes.js.
    const scriptSrc = await page.locator('script[src*="/widget/propanes.js"]').first().getAttribute('src');
    expect(scriptSrc).toContain('/widget/propanes.js');
  });
});
