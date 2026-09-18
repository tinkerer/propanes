// Browser checks for the separately generated tutorial app.
import { chromium, expect } from '@playwright/test';
import { join } from 'node:path';

const base = process.env.PROPANES_REVIEW_PREVIEW || 'http://localhost:5178';
const project = process.env.STEP_VIEWER_PROJECT || '/Users/amir/work/github.com/propanes-step-viewer';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(base);
  await page.getByRole('button', { name: 'Load sample', exact: true }).click();
  await expect(page.locator('#model-info')).toContainText(/screw.step.*triangles.*mm/, { timeout: 30000 });
  await expect(page.locator('#parts-summary')).toContainText('1 of 1 visible');
  await page.locator('#parts-list input[type=checkbox]').first().uncheck();
  await expect(page.locator('#parts-summary')).toContainText('0 of 1 visible');
  await page.getByRole('button', { name: 'Show all', exact: true }).click();
  await page.getByRole('button', { name: 'Fit to model', exact: true }).click();
  await page.getByRole('button', { name: 'Reset view', exact: true }).click();
  await page.screenshot({ path: '/tmp/propanes-step-viewer-desktop.png' });
  await page.locator('#file-input').setInputFiles({ name: 'broken.step', mimeType: 'application/octet-stream', buffer: Buffer.from('invalid STEP') });
  await expect(page.locator('#error')).toBeVisible();
  await expect(page.locator('#model-info')).toContainText('screw.step');
  await page.locator('#file-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.locator('#error')).toContainText(/step|stp/i);
  const oversized = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(65 * 1024 * 1024)], 'oversized.step'));
    return data;
  });
  await page.locator('#viewport').dispatchEvent('drop', { dataTransfer: oversized });
  await oversized.dispose();
  await expect(page.locator('#error')).toContainText(/limit|large/i);
  await expect(page.locator('#model-info')).toContainText('screw.step');
  await page.locator('#file-input').setInputFiles(join(project, 'node_modules/occt-import-js/test/testfiles/simple-basic-cube/cube.stp'));
  await expect(page.locator('#model-info')).toContainText('cube.stp', { timeout: 30000 });
  await expect(page.locator('#model-info')).not.toContainText('screw.step');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open ProPanes prompt widget', exact: true }).click();
  await expect(page.getByLabel('Describe a change')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: '/tmp/propanes-step-viewer-mobile.png' });
  expect(errors).toEqual([]);
  console.log('PASS: real STEP sample, parts visibility, fit/reset, invalid and oversized files preserve model, second model, mobile widget; no page errors');
} finally { await browser.close(); }
