import test from 'node:test';
import assert from 'node:assert/strict';
import { mapMessagePaths, mapPath, parsePathMap } from '../src/launcher-paths.ts';

test('empty or malformed map entries are ignored', () => {
  assert.deepEqual(parsePathMap(undefined), []);
  assert.deepEqual(parsePathMap('nope,=x,/a='), []);
});

test('maps on path-segment boundaries, longest prefix first', () => {
  const map = parsePathMap('/home/agent=/Users/amir, /home/agent/work/propanes/=/Users/amir/src/propanes');
  assert.equal(mapPath('/home/agent', map), '/Users/amir');
  assert.equal(mapPath('/home/agent/notes', map), '/Users/amir/notes');
  assert.equal(mapPath('/home/agent/work/propanes/packages', map), '/Users/amir/src/propanes/packages');
  assert.equal(mapPath('/home/agentx/foo', map), '/home/agentx/foo');
  assert.equal(mapPath('~', map), '~');
});

test('rewrites cwd, projectDir and artifactPaths in a message', () => {
  const map = parsePathMap('/srv/app=/Users/amir/app');
  const msg = mapMessagePaths({
    type: 'export_session_files',
    cwd: '/srv/app',
    projectDir: '/srv/app/sub',
    artifactPaths: ['/srv/app/a.txt', '/tmp/b.txt'],
    prompt: 'look at /srv/app',
  }, map);
  assert.equal(msg.cwd, '/Users/amir/app');
  assert.equal(msg.projectDir, '/Users/amir/app/sub');
  assert.deepEqual(msg.artifactPaths, ['/Users/amir/app/a.txt', '/tmp/b.txt']);
  assert.equal(msg.prompt, 'look at /srv/app');
});
