import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStateStore, MemoryStateStore, StateRepo, freshCheckpoint, threadKey, type ThreadRecord } from '../src/state';

function record(key: string): ThreadRecord {
  return {
    key, teamId: 'T', channel: 'C', threadTs: '1.0', sessionId: 'S', feedbackId: 'F', runtime: 'claude', agentEndpointId: 'A', agentName: 'yolo',
    mode: 'default', images: false, history: [], delivery: freshCheckpoint(0), watching: true, createdAt: 'now', updatedAt: 'now',
  };
}

test('file store persists threads, preferences and seen events across restarts atomically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amirobot-'));
  const path = join(dir, 'state.json');
  const repo = new StateRepo(new FileStateStore(path));
  repo.putThread(record(threadKey('T', 'C', '1.0')));
  repo.setRuntimePref('T', 'U', 'codex');
  assert.equal(repo.markEvent('Ev1'), true);
  assert.equal(repo.markEvent('Ev1'), false);

  const again = new StateRepo(new FileStateStore(path));
  assert.equal(again.getThread('T:C:1.0')?.sessionId, 'S');
  assert.equal(again.getRuntimePref('T', 'U'), 'codex');
  assert.equal(again.markEvent('Ev1'), false, 'duplicate after restart is still rejected');
  assert.deepEqual(readdirSync(dir), ['state.json'], 'no temp files left behind');
  assert.equal(JSON.parse(readFileSync(path, 'utf-8')).version, 1);
});

test('delivered keys are capped so the checkpoint stays small', () => {
  const repo = new StateRepo(new MemoryStateStore());
  const r = record('k');
  r.delivery.delivered = Array.from({ length: 1000 }, (_, i) => `k${i}`);
  repo.putThread(r);
  assert.equal(repo.getThread('k')!.delivery.delivered.length, 400);
  assert.equal(repo.getThread('k')!.delivery.delivered[0], 'k600');
});

test('flat DMs and channel threads get distinct keys', () => {
  assert.equal(threadKey('T', 'D1', null), 'T:D1:dm');
  assert.equal(threadKey('T', 'C1', '2.0'), 'T:C1:2.0');
});
