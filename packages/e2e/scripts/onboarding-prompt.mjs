// Sends one tutorial prompt through the real widget. Agent execution is opt-in.
// node scripts/onboarding-prompt.mjs 1  (then 2, 3, 4 after reviewing each result)
import { chromium, expect } from '@playwright/test';
const prompts = [
  'Change the heading to “My first app” and add a click counter. Keep Vite hot reload and the ProPanes widget working.',
  'Turn this app into a 3D viewer using Three.js. Start with a demo box, orbit controls, a responsive canvas, and a Reset view button. Use only slate, blue, orange, red, yellow, black, and white colors. Keep the ProPanes widget and Vite hot reload. Do not add STEP import yet.',
  'Add real .step and .stp file import using occt-import-js. Load its WASM locally and parse in a Web Worker so the UI stays responsive. Convert the returned meshes to Three.js geometry, fit the camera to the model, and show loading and error states. Include a small real STEP sample with its source and license and a Load sample button. Do not substitute a demo shape for an imported file. Preserve the widget, hot reload, and existing port 5178. Use only slate, blue, orange, red, yellow, black, and white colors.',
  'Improve the STEP viewer with drag-and-drop, a parts list with visibility controls, model bounds labeled with their units, fit-to-model, and reset view. Dispose replaced geometries and materials. Reject unsupported or oversized files with clear messages, preserve the current model on failure, and handle worker errors. Keep the widget usable on desktop and mobile. Preserve the Vite port and use only slate, blue, orange, red, yellow, black, and white colors. Verify npm run build.',
];
const step = Number(process.argv[2] || 1);
if (!prompts[step - 1]) throw new Error('Choose step 1–4');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const base = process.env.PROPANES_REVIEW_URL || 'http://localhost:3101';
  const auth = await (await page.request.post(base + '/api/v1/auth/login', { data: { username: process.env.REVIEW_USER || 'admin', password: process.env.REVIEW_PASSWORD || 'admin' } })).json();
  await page.addInitScript(token => localStorage.setItem('pw-admin-token', token), auth.token);
  await page.goto(process.env.PROPANES_REVIEW_PREVIEW || 'http://localhost:5178');
  await page.locator('.pw-trigger').click();
  await page.locator('#pw-chat-input').fill(prompts[step - 1] + '\n\nImplement directly in this application directory only. Do not touch the ProPanes source or other projects. Do not stop or restart the running dev server. Do not spawn other agents. Keep this experiment local: do not create remote repositories, push, or open PRs. Run the build and focused checks, then finish with the changed files and checks. Browser verification will also be performed by the reviewer.');
  await page.locator('.pw-send-dropdown-toggle').click();
  const agentSelect = page.locator('.pw-send-menu-target-select').nth(1);
  await expect(agentSelect.locator('option')).not.toHaveCount(1);
  const option = await agentSelect.locator('option').filter({ hasText: 'Onboarding Claude' }).getAttribute('value');
  await agentSelect.selectOption(option);
  const response = page.waitForResponse(r => r.url().endsWith('/api/v1/feedback') && r.request().method() === 'POST', { timeout: 30000 });
  await page.locator('.pw-send-menu-send-btn').click();
  const result = await response;
  console.log('DISPATCH', step, result.status(), await result.text());
  await page.screenshot({ path: '/tmp/propanes-prompt-' + step + '.png' });
  if (step === 1) {
    // Keep this page open: a heading update proves live reload, not navigation.
    await expect(page.locator('h1')).toContainText('My first app', { timeout: 120000 });
    console.log('PASS: heading updated on the existing page through Vite live reload');
  }
} finally { await browser.close(); }
