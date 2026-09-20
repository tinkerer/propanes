// Read-only check: never send keystrokes to a session's terminal.
import { chromium, expect } from '@playwright/test';
const base = process.env.PROPANES_REVIEW_URL || 'http://localhost:3101';
const browser = await chromium.launch();
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 900, height: 650 } });
    const auth = await context.request.post(base + '/api/v1/auth/login', { data: {
      username: process.env.REVIEW_USER || 'admin', password: process.env.REVIEW_PASSWORD || 'admin',
    } });
    expect(auth.ok()).toBeTruthy();
    const { token } = await auth.json();
    const sessions = await (await context.request.get(base + '/api/v1/admin/agent-sessions', { headers: { Authorization: 'Bearer ' + token } })).json();
    const session = sessions.find(s => s.feedbackTitle && s.feedbackId);
    expect(session, 'Review instance needs an existing session with a ticket title').toBeTruthy();
    await context.addInitScript(({ token, theme }) => {
      localStorage.setItem('pw-admin-token', token);
      localStorage.setItem('pw-theme', JSON.stringify(theme));
    }, { token, theme });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/admin/#/session/' + session.id);
    const toolbar = page.getByRole('region', { name: 'Session controls' });
    await expect(toolbar.locator('.session-feedback-link')).toBeVisible();
    await expect(page.locator('.xterm-scrollable-element').first()).toHaveCSS('background-color', 'rgb(23, 23, 23)');
    const preferences = await context.newPage();
    await preferences.goto(base + '/admin/#/settings/preferences');
    await expect(preferences.getByLabel('PTY background')).toHaveValue('dark-grey');
    await preferences.getByLabel('PTY background').selectOption('black');
    await expect(page.locator('.xterm-scrollable-element').first()).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    await preferences.reload();
    await expect(preferences.getByLabel('PTY background')).toHaveValue('black');
    await preferences.getByLabel('PTY background').selectOption('graphite');
    await expect(page.locator('.xterm-scrollable-element').first()).toHaveCSS('background-color', 'rgb(41, 41, 41)');
    await preferences.getByLabel('PTY background').selectOption('dark-grey');
    await expect(page.locator('.xterm-scrollable-element').first()).toHaveCSS('background-color', 'rgb(23, 23, 23)');
    await preferences.close();
    for (const width of [900, 390]) {
      await page.setViewportSize({ width, height: 650 });
      const contrasts = await toolbar.evaluate(el => {
        const lum = value => {
          const rgb = value.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
          return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
        };
        const bg = getComputedStyle(el).backgroundColor;
        return [...el.querySelectorAll('button')].map(button => {
          const style = getComputedStyle(button);
          const background = style.backgroundColor === 'rgba(0, 0, 0, 0)' ? bg : style.backgroundColor;
          const values = [lum(background), lum(style.color)].sort((a, b) => a - b);
          return (values[1] + .05) / (values[0] + .05);
        });
      });
      for (const ratio of contrasts) expect(ratio).toBeGreaterThanOrEqual(4.5);
      expect(await toolbar.evaluate(el => el.scrollWidth <= el.clientWidth)).toBeTruthy();
      await page.screenshot({ path: `/tmp/propanes-session-toolbar-${theme}-${width}.png` });
    }
    const actions = page.getByRole('button', { name: 'Session actions', exact: true });
    await actions.focus();
    await actions.press('Enter');
    await expect(actions).toHaveAttribute('aria-expanded', 'true');
    expect(errors).toEqual([]);
    await context.close();
  }
  console.log('PASS: toolbar light/dark, desktop/mobile, contrast, keyboard actions; PTY default, live cross-tab preferences and persistence; no terminal input');
} finally { await browser.close(); }
