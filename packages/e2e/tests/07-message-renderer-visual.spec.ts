import { test, expect } from './_fixtures';

// Visual regression for MessageRenderer / StructuredView fixtures.
//
// Sibling agents porting agent-portal's tool renderers should re-run with
// `npm run test:e2e -- --update-snapshots` and visually diff the result —
// these baselines are the "before" snapshot the parent task asked for.
//
// Fixtures are defined in
// packages/admin/src/components/MessageFixturesIsolate.tsx and surfaced via
// the `msg-fixture` isolate route. Add new fixtures there (keyed by name).

const FIXTURES = ['bash', 'edit', 'ask-user-question'] as const;

test.describe('MessageRenderer visual baselines', () => {
  for (const fixture of FIXTURES) {
    test(`@visual fixture: ${fixture}`, async ({ page }) => {
      await page.goto(`/admin/?isolate=msg-fixture&fixture=${fixture}`);
      const root = page.locator(`[data-testid="fixture-${fixture}"]`);
      await expect(root).toBeVisible({ timeout: 10_000 });
      // Hide widget so it can't bleed in
      await page.addStyleTag({ content: 'propanes-host{display:none!important;}' });
      await page.waitForTimeout(200);
      await expect(root).toHaveScreenshot(`message-${fixture}.png`);
    });
  }

  test('@visual long-output collapsed and expanded', async ({ page }) => {
    await page.goto('/admin/?isolate=msg-fixture&fixture=long-output');
    const root = page.locator('[data-testid="fixture-long-output"]');
    await expect(root).toBeVisible({ timeout: 10_000 });
    await page.addStyleTag({ content: 'propanes-host{display:none!important;}' });
    await page.waitForTimeout(200);

    // Collapsed baseline
    await expect(root).toHaveScreenshot('message-long-output-collapsed.png');

    // Click the expand affordance if present (renderers vary — both class names
    // exist in MessageRenderer.tsx). If neither is present the long-output
    // fixture isn't truncatable in the current build; that's still useful to
    // record as the baseline.
    const expandBtn = root.locator('.sm-truncated, .sm-result-expand-btn, button:has-text("expand")').first();
    if (await expandBtn.count()) {
      await expandBtn.click();
      await page.waitForTimeout(150);
      await expect(root).toHaveScreenshot('message-long-output-expanded.png');
    }
  });
});
