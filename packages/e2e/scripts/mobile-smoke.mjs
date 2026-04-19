import { chromium, devices } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const USERNAME = process.env.ADMIN_USER || 'admin';
const PASSWORD = process.env.ADMIN_PASS || 'w0rkb3nch';

async function getToken() {
  const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (res.ok) {
    const j = await res.json();
    return j.token;
  }
  console.error('Login failed', await res.text());
  return null;
}

(async () => {
  // Use chromium with iPhone 14 viewport — we can't use webkit because it's not installed
  const iPhone14 = devices['iPhone 14'];
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: iPhone14.viewport,
    userAgent: iPhone14.userAgent,
    deviceScaleFactor: iPhone14.deviceScaleFactor,
    isMobile: iPhone14.isMobile,
    hasTouch: iPhone14.hasTouch,
  });
  const page = await ctx.newPage();

  // Capture console messages
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[browser error]', msg.text());
  });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));

  // Login via admin token storage — we need to get a token first
  await page.goto(`${BASE_URL}/admin/`, { waitUntil: 'domcontentloaded' });

  // Check if already authenticated
  const existingToken = await page.evaluate(() => localStorage.getItem('pw-admin-token'));
  if (!existingToken) {
    const token = await getToken();
    if (token) {
      await page.evaluate((t) => localStorage.setItem('pw-admin-token', t), token);
    }
  }

  await page.goto(`${BASE_URL}/admin/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const token = await page.evaluate(() => localStorage.getItem('pw-admin-token'));
  const apps = await (await fetch(`${BASE_URL}/api/v1/admin/applications`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  const appId = apps[0]?.id;
  console.log('[info] appId', appId);

  const results = {};

  async function snap(name, route) {
    // Full reload to be sure the SPA picks up the new hash route
    await page.goto(`${BASE_URL}/admin/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((r) => { window.location.hash = r; }, route);
    await page.waitForTimeout(1600);
    const actualRoute = await page.evaluate(() => location.hash);
    console.log(`[nav:${name}] target=${route} actual=${actualRoute}`);
    const info = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      mobile: matchMedia('(max-width: 768px)').matches,
      bodyClass: document.body.className,
      hasMobileNav: !!document.querySelector('.mobile-nav'),
      mobileNavVisible: (() => {
        const n = document.querySelector('.mobile-nav');
        if (!n) return null;
        const s = getComputedStyle(n);
        return { display: s.display, position: s.position };
      })(),
      horizontalOverflow: {
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      },
      dispatchBar: (() => {
        const d = document.querySelector('.dispatch-bar.dispatch-bar-styled');
        if (!d) return null;
        const s = getComputedStyle(d);
        const r = d.getBoundingClientRect();
        return { position: s.position, bottom: s.bottom, width: r.width };
      })(),
    }));
    await page.screenshot({ path: `/tmp/mobile-${name}.png`, fullPage: false });
    console.log(`[snap:${name}]`, JSON.stringify(info));
    results[name] = info;
  }

  await snap('feedback-list', `/app/${appId}/feedback`);
  await snap('sessions', `/app/${appId}/sessions`);
  await snap('live', `/app/${appId}/live`);

  // Need a feedback id
  const fbList = await (await fetch(`${BASE_URL}/api/v1/admin/feedback?appId=${appId}&limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  const fbId = fbList.items?.[0]?.id;
  if (fbId) {
    await snap('feedback-detail', `/app/${appId}/feedback/${fbId}`);
  }

  await snap('settings', `/app/${appId}/settings`);

  console.log('\n[summary]', JSON.stringify(results, null, 2));

  await browser.close();
})();
