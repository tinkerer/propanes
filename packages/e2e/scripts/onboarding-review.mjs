// Run against a dedicated local review deployment, never a shared database.
// PROPANES_REVIEW_URL=http://localhost:3101 node scripts/onboarding-review.mjs
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const base = process.env.PROPANES_REVIEW_URL || 'http://localhost:3101';
const projectParent = process.env.PROPANES_REVIEW_PROJECTS || '/tmp/propanes-onboarding-projects';
const previewPort = process.env.PROPANES_REVIEW_PORT || '5180';
await mkdir(projectParent, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  const auth = await context.request.post(base + '/api/v1/auth/login', { data: { username: process.env.REVIEW_USER || 'admin', password: process.env.REVIEW_PASSWORD || 'admin' } });
  expect(auth.ok()).toBeTruthy();
  const { token } = await auth.json();
  await context.addInitScript(token => {
    localStorage.setItem('pw-admin-token', token);
    localStorage.setItem('pw-hints-enabled', 'false');
  }, token);
  const headers = { Authorization: 'Bearer ' + token };
  await page.goto(base + '/admin/#/settings/getting-started');
  await expect(page.getByRole('heading', { name: 'Small start. Real possibilities.' }).first()).toBeVisible();
  await page.screenshot({ path: '/tmp/propanes-guide-desktop.png' });
  await page.getByRole('button', { name: 'Create an app', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({ path: '/tmp/propanes-create.png' });
  await page.route('**/applications/onboard-assist', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Review: agent unavailable' }) }));
  await page.getByText('Let an agent help with setup', { exact: true }).click();
  await page.getByLabel('Describe your project').fill('Create a small app');
  await page.getByRole('button', { name: 'Start setup assistant' }).click();
  await expect(page.getByRole('alert')).toContainText('Review: agent unavailable');
  await expect(page.getByLabel('Describe your project')).toHaveValue('Create a small app');
  await page.unroute('**/applications/onboard-assist');
  await page.getByRole('button', { name: /Hello World →/ }).click();
  await expect(page.getByRole('button', { name: 'Create Hello World', exact: true })).toBeDisabled();
  await page.getByPlaceholder('/Users/you/projects').fill(projectParent);
  const projectName = 'hello-world-' + Date.now();
  await page.getByLabel('Project folder', { exact: true }).fill(projectName);
  await page.getByLabel('Preview port', { exact: true }).fill(previewPort);
  const created = page.waitForResponse(r => r.url().endsWith('/applications/scaffold') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create Hello World', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const app = await response.json();
  const saved = await (await context.request.get(base + '/api/v1/admin/applications/' + app.id, { headers })).json();
  expect(saved.hooks).toEqual([]);
  expect(saved.serverUrl).toBe('http://localhost:' + previewPort);
  const duplicate = await context.request.post(base + '/api/v1/admin/applications/scaffold', { headers, data: { name: 'Duplicate', parentDir: projectParent, projectName } });
  expect(duplicate.status()).toBe(400);
  const invalid = await context.request.post(base + '/api/v1/admin/applications/scaffold', { headers, data: { name: 'Invalid', parentDir: projectParent, projectName: '../escape', port: -1 } });
  expect(invalid.status()).toBe(400);
  console.log('CREATED', JSON.stringify({ id: app.id, projectDir: app.projectDir, appUrl: app.appUrl }));
  await expect(page.getByRole('heading', { name: 'Your Hello World is ready' })).toBeVisible();
  await page.screenshot({ path: '/tmp/propanes-created.png' });
  await page.getByRole('button', { name: 'Start dev server', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Terminal opened — check startup output', exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: 'Continue the guide →' }).click();
  await page.getByRole('tab', { name: '3. Open a real STEP file' }).first().click();
  await expect(page.getByRole('tabpanel').first()).toContainText('occt-import-js');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: '/tmp/propanes-guide-' + theme + '.png' });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + '/admin/#/settings/getting-started');
  await expect(page.getByRole('heading', { name: 'Small start. Real possibilities.' }).first()).toBeVisible();
  await page.screenshot({ path: '/tmp/propanes-guide-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.goto(base + '/admin/#/app/' + app.id + '/settings');
  await expect(page.locator('input').first()).toBeVisible();
  console.log('PAGE_ERRORS', JSON.stringify(errors));
  expect(errors).toEqual([]);
  console.log('PASS: create, validation, duplicate protection, assistant error recovery, start control, app settings, tutorial, light/dark, mobile');
} finally { await browser.close(); }
