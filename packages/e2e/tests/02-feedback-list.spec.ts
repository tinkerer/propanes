import { test, expect, dismissWidget } from './_fixtures';

test.describe('Feedback list', () => {
  test('renders seeded feedback rows for the test app', async ({ loggedInPage, env }) => {
    const page = loggedInPage;
    await expect(page.locator('table').first()).toBeVisible({ timeout: 10_000 });
    // Each seeded title shows up as a link
    for (const id of env.feedbackIds) {
      await expect(page.locator(`a[href="#/app/${env.appId}/feedback/${id}"]`)).toBeVisible();
    }
  });

  test('search filter narrows the table', async ({ loggedInPage }) => {
    const page = loggedInPage;
    // Scope to the page-level filters bar — the sidebar SessionsListView
    // also renders a `placeholder="Search..."` input.
    const searchInput = page.locator('.filters input[placeholder="Search..."]').first();
    await expect(searchInput).toBeVisible();
    await searchInput.fill('dispatch button');
    await searchInput.press('Enter');

    // After the filter applies, every visible row should match the keyword.
    await expect.poll(async () => {
      const texts = await page.locator('table tbody tr').allInnerTexts();
      return texts.length > 0 && texts.every((t) => /dispatch/i.test(t));
    }, { timeout: 5_000 }).toBe(true);
  });

  test('opens "+ New" inline form', async ({ loggedInPage }) => {
    const page = loggedInPage;
    await page.getByRole('button', { name: /\+ New/ }).click();
    await expect(page.getByPlaceholder('Title')).toBeVisible();
    await expect(page.getByPlaceholder('Description (optional)')).toBeVisible();
  });

  test('@visual feedback list baseline', async ({ loggedInPage }) => {
    const page = loggedInPage;
    await dismissWidget(page);
    await expect(page.locator('table').first()).toBeVisible();
    // Allow the table to settle
    await page.waitForTimeout(250);
    await expect(page.locator('table').first()).toHaveScreenshot('feedback-list-table.png', {
      mask: [
        // Created-at column is time-relative; mask it out
        page.locator('td').filter({ hasText: /ago|seconds|minute/ }),
        // ID column is ULID-derived per run
        page.locator('table tbody td:nth-child(2)'),
      ],
    });
  });
});
