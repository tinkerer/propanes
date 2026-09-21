import type { Page, Locator } from '@playwright/test';
import { test, expect } from './_fixtures';

// The widget's sticky "Auto-dispatch" checkbox must make a plain Enter submit
// carry autoDispatch=true, and choosing a one-shot mode from the send menu
// must not clear it. The feedback POST is intercepted (see README) so no
// feedback row or agent session is created — we only inspect the payload.

type FeedbackPayload = { autoDispatch?: boolean; description?: string };

function parseFeedbackBody(body: string | null): FeedbackPayload {
  const text = body ?? '';
  if (text.trimStart().startsWith('{')) return JSON.parse(text);
  // Multipart form (attachments present): the JSON rides in the "feedback" part.
  const m = text.match(/name="feedback"\r?\n(?:[^\r\n]*\r?\n)*?\r?\n([\s\S]*?)\r?\n--/);
  if (!m) throw new Error(`feedback part not found in body: ${text.slice(0, 200)}`);
  return JSON.parse(m[1]);
}

const HOST = 'propanes-host';

async function waitForWidgetReady(page: Page) {
  await page.waitForFunction(() => !!(window as any).promptWidget, null, { timeout: 15_000 });
  // The send-menu dropdown only renders once the server's WS config has
  // confirmed the app allows auto-dispatch.
  await page.waitForFunction(
    () => (window as any).promptWidget?.sessionBridge?.autoDispatch === true,
    null,
    { timeout: 15_000 }
  );
}

async function openPanel(page: Page): Promise<Locator> {
  await page.evaluate(() => {
    const w = (window as any).promptWidget;
    w.close?.();
    w.open();
  });
  const input = page.locator(`${HOST} #pw-chat-input`);
  await expect(input).toBeVisible({ timeout: 10_000 });
  await expect(input).toBeEnabled();
  return input;
}

async function reopenAfterSubmit(page: Page): Promise<Locator> {
  // showFlash() closes the panel ~1s after a successful submit.
  await page.waitForTimeout(1300);
  return openPanel(page);
}

test.describe('Widget auto-dispatch on Enter', () => {
  test('sticky Auto-dispatch flag survives a one-shot menu Send', async ({ page, env, baseURL, request }) => {
    const target = baseURL || 'http://localhost:3001';
    const loginRes = await request.post(`${target}/api/v1/auth/login`, {
      data: { username: env.adminUser, password: env.adminPass },
    });
    const { token } = await loginRes.json();

    await page.context().addInitScript((t: string) => {
      try {
        localStorage.setItem('pw-admin-token', t);
        localStorage.setItem('pw-auto-dispatch', '1');
        localStorage.removeItem('pw-dispatch-mode');
      } catch {}
    }, token);

    const captured: FeedbackPayload[] = [];
    await page.route('**/api/v1/feedback', async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.continue();
      const payload = parseFeedbackBody(req.postData());
      captured.push(payload);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: `01E2EFAKE${captured.length}`, appId: env.appId }),
      });
    });

    const submitViaEnter = async (input: Locator, text: string) => {
      const before = captured.length;
      await input.fill(text);
      await input.press('Enter');
      await expect.poll(() => captured.length, { timeout: 8_000 }).toBe(before + 1);
      return captured[captured.length - 1];
    };

    await page.goto(`/admin/#/app/${env.appId}/feedback`);
    await waitForWidgetReady(page);
    let input = await openPanel(page);

    await expect
      .poll(() => page.evaluate(() => (window as any).promptWidget.dispatchMode))
      .toBe('auto');

    // 1. Enter with the sticky flag → dispatch
    const first = await submitViaEnter(input, 'e2e auto-dispatch: Enter with sticky flag');
    expect(first.autoDispatch).toBe(true);

    // 2. Send menu → Mode "Submit only" → Send: one-shot, no dispatch
    input = await reopenAfterSubmit(page);
    await page.locator(`${HOST} #pw-send-dropdown`).click();
    const modeSel = page.locator(`${HOST} .pw-send-menu select[aria-label="Send mode"]`);
    await expect(modeSel).toBeVisible();
    await modeSel.selectOption('submit');
    await input.fill('e2e auto-dispatch: menu Send with Submit only');
    const before = captured.length;
    await page.locator(`${HOST} .pw-send-menu-send-btn`).click();
    await expect.poll(() => captured.length, { timeout: 8_000 }).toBe(before + 1);
    expect(captured[captured.length - 1].autoDispatch).toBeFalsy();

    // The sticky preference is untouched by the one-shot choice.
    const sticky = await page.evaluate(() => ({
      mode: (window as any).promptWidget.dispatchMode,
      flag: localStorage.getItem('pw-auto-dispatch'),
      sendMode: localStorage.getItem('pw-dispatch-mode'),
    }));
    expect(sticky).toEqual({ mode: 'auto', flag: '1', sendMode: 'submit' });

    // 3. Enter again → still dispatches
    input = await reopenAfterSubmit(page);
    const third = await submitViaEnter(input, 'e2e auto-dispatch: Enter after menu Send');
    expect(third.autoDispatch).toBe(true);

    // 4. Uncheck Auto-dispatch → Enter no longer dispatches
    input = await reopenAfterSubmit(page);
    await page.locator(`${HOST} #pw-send-dropdown`).click();
    const autoCb = page
      .locator(`${HOST} .pw-send-menu-checkbox`, { hasText: 'Auto-dispatch' })
      .locator('input');
    await expect(autoCb).toBeChecked();
    await autoCb.uncheck();
    await page.locator(`${HOST} #pw-send-dropdown`).click();
    await expect(page.locator(`${HOST} .pw-send-menu`)).toHaveCount(0);
    const fourth = await submitViaEnter(input, 'e2e auto-dispatch: Enter with flag off');
    expect(fourth.autoDispatch).toBeFalsy();
    expect(await page.evaluate(() => localStorage.getItem('pw-auto-dispatch'))).toBeNull();
  });
});
