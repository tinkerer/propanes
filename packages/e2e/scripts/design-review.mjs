// Read-only visual smoke test against the isolated onboarding instance.
import { chromium, expect } from '@playwright/test';

const base = process.env.PROPANES_REVIEW_URL || 'http://localhost:3101';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  const auth = await context.request.post(base + '/api/v1/auth/login', { data: {
    username: process.env.REVIEW_USER || 'admin', password: process.env.REVIEW_PASSWORD || 'admin',
  } });
  expect(auth.ok()).toBeTruthy();
  const { token } = await auth.json();
  await context.addInitScript(token => {
    localStorage.setItem('pw-admin-token', token);
    localStorage.setItem('pw-hints-enabled', 'false');
  }, token);
  await page.goto(base + '/admin/#/settings/getting-started');
  await expect(page.getByRole('heading', { name: 'Small start. Real possibilities.' }).first()).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    // Let color transitions settle before checking contrast or taking evidence.
    await page.waitForTimeout(250);
    const contrast = await page.locator('.onboarding-guide .btn-primary').first().evaluate(button => {
      const style = getComputedStyle(button);
      const luminance = color => {
        const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => {
          const c = n / 255;
          return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
        });
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      const values = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => a - b);
      return (values[1] + .05) / (values[0] + .05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: `/tmp/propanes-design-${theme}.png` });
    await page.getByRole('button', { name: 'Create an app', exact: true }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: /Hello World →/ }).click();
    await expect(page.getByLabel('App name')).toBeVisible();
    await page.screenshot({ path: `/tmp/propanes-design-modal-${theme}.png` });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await page.getByRole('tab', { name: '3. Open a real STEP file' }).first().click();
  await expect(page.getByRole('tabpanel').first()).toContainText('occt-import-js');
  const apps = await (await context.request.get(base + '/api/v1/admin/applications', { headers: { Authorization: 'Bearer ' + token } })).json();
  for (const route of ['/settings/agents', '/settings/preferences', ...(apps.length ? [`/app/${apps[0].id}/tickets`, `/app/${apps[0].id}/settings`, `/app/${apps[0].id}/sessions`] : [])]) {
    await page.goto(base + '/admin/#' + route);
    await expect(page.locator('.control-bar')).toBeVisible();
    const heading = { agents: 'Agents', preferences: 'Preferences', settings: 'Settings', sessions: 'Sessions' }[route.split('/').at(-1)];
    if (heading) await expect(page.getByRole('heading', { name: new RegExp(heading, 'i') }).first()).toBeVisible();
    await page.screenshot({ path: `/tmp/propanes-design-${route.split('/').at(-1)}.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + '/admin/#/settings/getting-started');
  await expect(page.getByRole('heading', { name: 'Small start. Real possibilities.' }).first()).toBeVisible();
  await page.screenshot({ path: '/tmp/propanes-design-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole('button', { name: 'Create an app', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const box = await page.getByRole('dialog').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '/tmp/propanes-design-modal-mobile.png' });
  expect(errors).toEqual([]);
  console.log('PASS: light/dark workspace, modal/keyboard, tutorial, settings/tickets/sessions routes, mobile bounds; no page errors');
} finally { await browser.close(); }
