import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchTargets } from '../src/targets';

const targets = [
  { id: 'app-1', name: 'Propanes Admin' },
  { id: 'app-2', name: 'Storefront' },
];

const matches = (query: string, rows = targets) => matchTargets(rows, query, t => t.id, t => [t.name]);

test('exact IDs and names beat partial and fuzzy matches', () => {
  assert.equal(matches('APP-1')[0].id, 'app-1');
  assert.equal(matches('propanes-admin')[0].id, 'app-1');
  assert.equal(matches('admin')[0].id, 'app-1');
  assert.equal(matches('storfront')[0].id, 'app-2');
  assert.equal(matches('macobok', [{ id: 'mac-1', name: 'MacBook' }])[0].id, 'mac-1');
  assert.equal(matches('macbok', [{ id: 'mac-1', name: 'Amir MacBook' }])[0].id, 'mac-1');
  assert.equal(matches('Storefront', [...targets, { id: 'extra', name: 'Storefront Dev' }])[0].id, 'app-2');
});

test('all ambiguous partial, fuzzy and duplicate exact names are retained', () => {
  assert.equal(matches('store', [...targets, { id: 'app-3', name: 'Storefront Dev' }]).length, 2);
  assert.equal(matches('tests', [{ id: 'a', name: 'testa' }, { id: 'b', name: 'testb' }]).length, 2);
  assert.equal(matches('Storefront', [...targets, { id: 'duplicate', name: 'Storefront' }]).length, 2);
});

test('unknown names, punctuation and empty registries have no matches', () => {
  assert.deepEqual(matches('unrelated'), []);
  assert.deepEqual(matches('---'), []);
  assert.deepEqual(matches('macbook', []), []);
});
