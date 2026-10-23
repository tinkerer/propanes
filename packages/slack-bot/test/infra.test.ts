import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listInfraText, offlineInfraText, resolveInfra } from '../src/infra';
import { World } from './helpers';

const list = new World().infra;

test('exact name, machine, hostname or launcher id wins; a single partial hit is accepted; local aliases resolve to the server', () => {
  assert.equal((resolveInfra(list, 'dev-laptop') as any).target.launcherId, 'laptop-1');
  assert.equal((resolveInfra(list, 'laptop') as any).target.launcherId, 'laptop-1');
  assert.equal((resolveInfra(list, 'dev-laptop.local') as any).target.launcherId, 'laptop-1');
  assert.equal((resolveInfra(list, 'laptop-1') as any).target.launcherId, 'laptop-1');
  assert.equal((resolveInfra(list, 'gpu-box-a') as any).target.launcherId, 'gpu-1', 'exact beats the sibling partial');
  for (const q of ['local', 'server', 'here', 'shared-vm']) {
    const m = resolveInfra(list, q);
    assert.equal(m.kind, 'one', q);
    assert.equal((m as any).target.launcherId, 'local', q);
  }
});

test('ambiguous, offline and unknown targets are reported, never guessed or silently run locally', () => {
  const many = resolveInfra(list, 'gpu');
  assert.equal(many.kind, 'many');
  assert.deepEqual((many as any).targets.map((t: any) => t.name), ['gpu-box-a', 'gpu-box-b']);
  const off = resolveInfra(list, 'build');
  assert.equal(off.kind, 'offline');
  assert.match(offlineInfraText((off as any).target, list), /\*build-vm\* is offline[\s\S]*Nothing was started/);
  assert.deepEqual(resolveInfra(list, 'nope'), { kind: 'none' });
  assert.deepEqual(resolveInfra(list, ''), { kind: 'none' });
});

test('the list shows the server first, state, load and the option to type', () => {
  const t = listInfraText(list);
  assert.match(t, /\*Connected infrastructure\* \(5\)/);
  assert.match(t, /• \*shared-vm\* — this server · online _\(default\)_ → `\[infra:local\]`/);
  assert.match(t, /• \*dev-laptop\* \(dev-laptop\.local\) — machine · online · 3\/5 sessions → `\[infra:dev-laptop\]`/);
  assert.match(t, /• \*build-vm\* — machine · offline → `\[infra:build-vm\]`/);
});
