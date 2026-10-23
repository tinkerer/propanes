import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTarget } from '../src/targets';

const targets = [
  { id: 'app-1', name: 'Propanes Admin' },
  { id: 'app-2', name: 'Storefront' },
];

test('resolves exact IDs and normalized names before partial or fuzzy matches', () => {
  assert.equal(resolveTarget('app', 'APP-1', targets).id, 'app-1');
  assert.equal(resolveTarget('app', 'propanes-admin', targets).id, 'app-1');
  assert.equal(resolveTarget('app', 'admin', targets).id, 'app-1');
  assert.equal(resolveTarget('app', 'storfront', targets).id, 'app-2');
  assert.equal(resolveTarget('infra', 'macbok', [{ id: 'mac-1', name: 'Amir MacBook' }]).id, 'mac-1');
  assert.equal(resolveTarget('infra', 'host-name', [{ id: 'x', name: 'Laptop', hostname: 'host-name.local' }]).id, 'x');
  assert.equal(resolveTarget('app', 'Storefront', [...targets, { id: 'extra', name: 'Storefront Dev' }]).id, 'app-2');
});

test('ambiguous partial and fuzzy names list exact selectors without guessing', () => {
  const similar = [...targets, { id: 'app-3', name: 'Storefront Dev' }];
  assert.throws(() => resolveTarget('app', 'store', similar), /Ambiguous app.*\[app:app-2\].*\[app:app-3\]/);
  assert.throws(() => resolveTarget('app', 'tests', [{ id: 'a', name: 'testa' }, { id: 'b', name: 'testb' }]), /Ambiguous/);
  assert.throws(() => resolveTarget('app', 'Storefront', [...targets, { id: 'duplicate', name: 'Storefront' }]), /Ambiguous/);
});

test('unknown names, punctuation and empty registries produce useful errors', () => {
  assert.throws(() => resolveTarget('app', 'unrelated', targets), /No app matches.*Available choices/);
  assert.throws(() => resolveTarget('app', '---', targets), /No app matches/);
  assert.throws(() => resolveTarget('infra', 'macbook', []), /No targets are available/);
});
