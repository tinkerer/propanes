import { test, expect, dismissWidget } from './_fixtures';

test.describe('Dispatch dialog', () => {
  test('opens via row dispatch action and renders agent picker', async ({ loggedInPage, env }) => {
    const page = loggedInPage;

    // Stub the dispatch POST so we don't actually spawn an agent session.
    await page.route('**/api/v1/admin/dispatch', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          dispatched: true,
          sessionId: 'e2e-fake-session',
          status: 200,
          response: 'ok',
        }),
      });
    });

    const fbId = env.feedbackIds[0];
    await page.goto(`/admin/#/app/${env.appId}/feedback`);
    await expect(page.locator(`a[href="#/app/${env.appId}/feedback/${fbId}"]`)).toBeVisible();

    // The quick-dispatch arrow on the row opens DispatchDialog. There's one per
    // un-dispatched row — find the row containing this feedback's link.
    const row = page.locator('tr', {
      has: page.locator(`a[href="#/app/${env.appId}/feedback/${fbId}"]`),
    });
    await row.locator('button.btn-dispatch-quick').click();

    // DispatchDialog renders a spotlight modal
    await expect(page.locator('.dispatch-dialog-v2')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Dispatch Feedback')).toBeVisible();
    await expect(page.locator('text=Dispatch Interactive')).toBeVisible();

    // Click Dispatch Interactive — backend POST is intercepted.
    await page.getByRole('button', { name: /Dispatch Interactive/ }).click();
    await expect(page.locator('.dispatch-dialog-v2')).not.toBeVisible({ timeout: 5_000 });
  });

  test('Escape closes the dispatch dialog', async ({ loggedInPage, env }) => {
    const page = loggedInPage;
    const fbId = env.feedbackIds[1] || env.feedbackIds[0];
    await page.goto(`/admin/#/app/${env.appId}/feedback`);
    const row = page.locator('tr', {
      has: page.locator(`a[href="#/app/${env.appId}/feedback/${fbId}"]`),
    });
    await row.locator('button.btn-dispatch-quick').click();
    await expect(page.locator('.dispatch-dialog-v2')).toBeVisible();

    // Click the dialog body to make sure focus is inside it (not on a sidebar
    // input from the parent layout) before sending Escape.
    await page.locator('.dispatch-dialog-v2').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Escape');
    await expect(page.locator('.dispatch-dialog-v2')).not.toBeVisible({ timeout: 5_000 });
  });

  test('@visual dispatch dialog baseline', async ({ loggedInPage, env }) => {
    const page = loggedInPage;
    const fbId = env.feedbackIds[0];
    await page.goto(`/admin/#/app/${env.appId}/feedback`);
    await dismissWidget(page);
    const row = page.locator('tr', {
      has: page.locator(`a[href="#/app/${env.appId}/feedback/${fbId}"]`),
    });
    await row.locator('button.btn-dispatch-quick').click();
    const dialog = page.locator('.dispatch-dialog-v2');
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(150);
    await expect(dialog).toHaveScreenshot('dispatch-dialog.png');
  });
});
