import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// PROPANES_BASE_PATH tells the server the path prefix a reverse proxy mounts it
// at, so the admin shell can tell the SPA rather than making it infer one from
// its own URL. The inference only works for the /admin/ shell; the service root
// and per-user shells have no '/admin' marker, so without this they resolve a
// prefix of '' and every request escapes the mount.
const tempDir = mkdtempSync(join(tmpdir(), 'propanes-base-path-test-'));
process.env.DB_PATH = join(tempDir, 'test.db');
process.env.NODE_ENV = 'test';
process.env.PROPANES_BASE_PATH = '/propanes/';  // trailing slash: must normalise

// serveAdminIndex reads admin/dist/index.html relative to cwd. Stand up a
// stub so the shell-rewriting paths are exercised instead of the 500 branch.
const adminDist = join(tempDir, 'admin', 'dist');
mkdirSync(adminDist, { recursive: true });
writeFileSync(
  join(adminDist, 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"></head>' +
    '<body><script type="module" src="/admin/assets/main.js"></script></body></html>'
);
const prevCwd = process.cwd();
mkdirSync(join(tempDir, 'server'), { recursive: true });
process.chdir(join(tempDir, 'server'));

const { runMigrations, sqlite } = await import('../src/db/index.ts');
const { app, BASE_PATH } = await import('../src/app.ts');

runMigrations();

test.after(() => {
  process.chdir(prevCwd);
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test('BASE_PATH normalises to a leading slash with no trailing slash', () => {
  assert.equal(BASE_PATH, '/propanes');
});

test('the service root shell carries the prefix the SPA needs', async () => {
  const res = await app.request('/');
  assert.equal(res.status, 200);
  const html = await res.text();
  // Without the injection the SPA would infer '' here (no '/admin' marker in
  // the path) and every API call would escape the mount.
  assert.match(html, /window\.__PROPANES_BASE_PATH__="\/propanes"/);
  // Asset URLs must be prefixed too: relative ones would resolve outside
  // /admin/ when the shell is served at the root.
  assert.match(html, /src="\/propanes\/admin\/assets\/main\.js"/);
  assert.doesNotMatch(html, /src="\/admin\//);
});

test('per-user shells get the prefix as well', async () => {
  const res = await app.request('/maksym');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /window\.__PROPANES_BASE_PATH__="\/propanes"/);
  assert.match(html, /src="\/propanes\/admin\/assets\/main\.js"/);
});

test('the /admin/ shell keeps relative assets and still declares the prefix', async () => {
  const res = await app.request('/admin/');
  assert.equal(res.status, 200);
  const html = await res.text();
  // Served one segment deep, relative URLs reach the assets under any prefix.
  assert.match(html, /src="\.\/assets\/main\.js"/);
  // The SPA still needs the prefix for its API/WebSocket calls.
  assert.match(html, /window\.__PROPANES_BASE_PATH__="\/propanes"/);
});

test('routes stay mounted at the root (the proxy strips the prefix)', async () => {
  assert.equal((await app.request('/api/v1/health')).status, 200);
});
