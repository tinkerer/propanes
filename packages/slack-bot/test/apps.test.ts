import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ambiguousAppText, defaultApp, listAppsText, resolveApp, unknownAppText } from '../src/apps';
import { apps } from './helpers';

test('exact name, id or project directory name wins; one partial hit is accepted', () => {
  assert.deepEqual(resolveApp(apps, 'Atlas'), { kind: 'one', app: apps[1] });
  assert.deepEqual(resolveApp(apps, 'store front'), { kind: 'one', app: apps[2] });
  assert.deepEqual(resolveApp(apps, 'app-sc'), { kind: 'one', app: apps[2] });
  assert.deepEqual(resolveApp(apps, 'propanes'), { kind: 'one', app: apps[0] }, 'directory name');
  assert.deepEqual(resolveApp(apps, 'reports'), { kind: 'one', app: apps[3] }, 'exact beats the longer partial');
  assert.deepEqual(resolveApp(apps, 'staging'), { kind: 'one', app: apps[4] });
  assert.deepEqual(resolveApp(apps, 'atl'), { kind: 'one', app: apps[1] });
});

test('several partial hits are listed, never picked from; no hit says so', () => {
  const m = resolveApp(apps, 'rep');
  assert.equal(m.kind, 'many');
  assert.deepEqual((m as any).apps.map((a: any) => a.name), ['Reports', 'Reports Staging']);
  assert.deepEqual(resolveApp(apps, 'nope'), { kind: 'none' });
  assert.deepEqual(resolveApp(apps, '  '), { kind: 'none' });
  assert.match(ambiguousAppText('rep', (m as any).apps), /matches 2 applications[\s\S]*Reports Staging[\s\S]*Nothing was started/);
  assert.match(unknownAppText('nope', apps, 'app-atlas'), /No application matches `app:nope`[\s\S]*\*Atlas\*.*_\(default\)_/);
});

test('the default application is resolved by name, then by the legacy id', () => {
  assert.equal(defaultApp(apps, 'atlas', 'app-1').id, 'app-atlas');
  assert.equal(defaultApp(apps, 'rep', 'app-1').id, 'app-1', 'an ambiguous default falls back');
  assert.equal(defaultApp(apps, undefined, 'app-1').id, 'app-1');
  assert.deepEqual(defaultApp([], 'atlas', 'app-1'), { id: 'app-1', name: 'app-1' });
  const text = listAppsText(apps, 'app-atlas');
  assert.match(text, /\*Applications\* \(5\)/);
  assert.match(text, /\*Atlas\* — `atlas` _\(default\)_ → `\[app:atlas\]`/);
});

test('app typos resolve conservatively and duplicate names offer exact IDs', () => {
  const typo = resolveApp(apps, 'storfront');
  assert.equal(typo.kind, 'one');
  if (typo.kind === 'one') assert.equal(typo.app.id, 'app-sc');
  const duplicate = resolveApp([...apps, { id: 'app-sc-2', name: 'Storefront' }], 'storefront');
  assert.equal(duplicate.kind, 'many');
  if (duplicate.kind === 'many') assert.match(ambiguousAppText('storefront', duplicate.apps), /app:app-sc\][\s\S]*app:app-sc-2\]/);
});
