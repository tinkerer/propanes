import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCompanionUrl } from '../src/lib/companion-url.js';

const ORIGIN = 'https://admin.example.test';

test('keeps absolute http(s) URLs', () => {
  assert.equal(normalizeCompanionUrl(' https://a.test/x.md ', ORIGIN), 'https://a.test/x.md');
  assert.equal(normalizeCompanionUrl('HTTP://a.test', ORIGIN), 'HTTP://a.test');
});

test('resolves root-relative paths against the admin origin', () => {
  assert.equal(normalizeCompanionUrl('/files/tmp/notes.md', ORIGIN), `${ORIGIN}/files/tmp/notes.md`);
  assert.equal(normalizeCompanionUrl('/x', `${ORIGIN}/`), `${ORIGIN}/x`);
});

test('protocol-relative URLs inherit the admin scheme', () => {
  assert.equal(normalizeCompanionUrl('//cdn.test/a.js', ORIGIN), 'https://cdn.test/a.js');
});

test('bare hosts get http://', () => {
  assert.equal(normalizeCompanionUrl('localhost:5173/app', ORIGIN), 'http://localhost:5173/app');
});

test('blank input normalizes to empty', () => {
  assert.equal(normalizeCompanionUrl('   ', ORIGIN), '');
});
