import { test as base, expect, type Page } from '@playwright/test';

export interface E2EEnv {
  appId: string;
  apiKey: string;
  adminUser: string;
  adminPass: string;
  feedbackIds: string[];
}

function readEnv(): E2EEnv {
  const appId = process.env.E2E_APP_ID;
  const apiKey = process.env.E2E_API_KEY;
  const adminUser = process.env.E2E_ADMIN_USER;
  const adminPass = process.env.E2E_ADMIN_PASS;
  const feedbackIds = (process.env.E2E_FEEDBACK_IDS || '').split(',').filter(Boolean);
  if (!appId || !apiKey || !adminUser || !adminPass) {
    throw new Error(
      'Missing E2E_* env vars. Run via `npm run test:e2e` so the orchestrator can seed them.'
    );
  }
  return { appId, apiKey, adminUser, adminPass, feedbackIds };
}

export const test = base.extend<{ env: E2EEnv; loggedInPage: Page }>({
  env: async ({}, use) => {
    await use(readEnv());
  },
  loggedInPage: async ({ page, env, baseURL }, use) => {
    const target = baseURL || 'http://localhost:3001';
    const res = await page.request.post(`${target}/api/v1/auth/login`, {
      data: { username: env.adminUser, password: env.adminPass },
    });
    if (!res.ok()) {
      throw new Error(`auth pre-seed failed: ${res.status()} ${await res.text()}`);
    }
    const { token } = await res.json();

    // Seed localStorage *before* the SPA bundle evaluates. The admin reads
    // `isAuthenticated` from localStorage at module-init time (state.ts), so
    // setting it after a goto is too late.
    await page.context().addInitScript((t: string) => {
      try { localStorage.setItem('pw-admin-token', t); } catch {}
    }, token);
    await page.goto(`/admin/#/app/${env.appId}/feedback`);
    await use(page);
  },
});

export { expect };

export async function dismissWidget(page: Page) {
  // The widget is embedded on every admin page. Hide it so it doesn't bleed
  // into baseline screenshots — visual regression should target admin chrome,
  // not the third-party-style overlay.
  await page.addStyleTag({
    content: 'propanes-host { display: none !important; }',
  });
}
