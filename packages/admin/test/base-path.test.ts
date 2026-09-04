import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveAdminMount } from '../src/lib/base-path.js';
import { browsableAppId } from '../src/lib/app-id.js';

test('recognizes reverse-proxied admin mounts', () => {
  assert.deepEqual(resolveAdminMount('/admin/'), { basePath: '', mounted: false });
  assert.deepEqual(resolveAdminMount('/propanes/admin/'), { basePath: '/propanes', mounted: true });
  assert.deepEqual(resolveAdminMount('/propanes/admin/index.html'), { basePath: '/propanes', mounted: true });
});

test('does not treat vanity workspace paths as admin mounts', () => {
  assert.deepEqual(resolveAdminMount('/amir'), { basePath: '', mounted: false });
  assert.deepEqual(resolveAdminMount('/'), { basePath: '', mounted: false });
});

test('does not browse files for the synthetic CoS workspace', () => {
  assert.equal(browsableAppId('__cos__'), null);
  assert.equal(browsableAppId(null), null);
  assert.equal(browsableAppId('real-app'), 'real-app');
});
