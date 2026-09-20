// Real UI with an intercepted PTY socket: no keystrokes or resizes reach a live shell.
import { chromium, expect } from '@playwright/test';
const base = process.env.PROPANES_REVIEW_URL || 'http://localhost:3101';
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const auth = await context.request.post(base + '/api/v1/auth/login', { data: { username: 'admin', password: 'admin' } });
  expect(auth.ok()).toBeTruthy();
  const { token } = await auth.json();
  const sessions = await (await context.request.get(base + '/api/v1/admin/agent-sessions', { headers: { Authorization: 'Bearer ' + token } })).json();
  const session = sessions.find(s => s.permissionProfile === 'plain');
  expect(session).toBeTruthy();
  await context.addInitScript(token => {
    localStorage.setItem('pw-admin-token', token);
    // Headless Chromium may report every tab focused. Exercise focus policy
    // deterministically without ever connecting the socket to the real PTY.
    window.reviewFocused = true;
    document.hasFocus = () => window.reviewFocused;
  }, token);
  const sent = [];
  await context.routeWebSocket('**/ws/agent-session?*', ws => {
    ws.onMessage(data => sent.push(JSON.parse(data.toString())));
    ws.send(JSON.stringify({ type: 'history', data: '\r\nStable prompt > ', cols: 80, rows: 24 }));
  });
  const page = await context.newPage();
  await page.goto(base + '/admin/#/session/' + session.id);
  await expect(page.locator('.xterm').first()).toBeVisible();
  const resizes = () => sent.filter(m => m.content?.kind === 'resize');
  await expect.poll(() => resizes().length).toBeGreaterThan(0);
  await page.waitForTimeout(1000);
  const settled = resizes().length;
  await page.waitForTimeout(1200);
  expect(resizes().length, 'idle terminal must not continuously resize').toBe(settled);
  await page.evaluate(() => { window.reviewFocused = false; window.dispatchEvent(new Event('blur')); });
  await page.setViewportSize({ width: 850, height: 650 });
  await page.waitForTimeout(500);
  expect(resizes().length, 'unfocused document must not resize the PTY').toBe(settled);
  await page.evaluate(() => { window.reviewFocused = true; window.dispatchEvent(new Event('focus')); });
  await expect.poll(() => resizes().length).toBe(settled + 1);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
  await page.waitForTimeout(500);
  expect(resizes().length, 'duplicate focus must not repaint the PTY').toBe(settled + 1);
  expect(sent.filter(m => m.type === 'sequenced_input' && m.content?.kind !== 'resize')).toEqual([]);
  await page.screenshot({ path: '/tmp/propanes-pty-stability.png' });
  console.log('PASS: idle resize dedupe, background resize suppression, one size sync on focus return, no terminal input (socket intercepted)');
} finally { await browser.close(); }
