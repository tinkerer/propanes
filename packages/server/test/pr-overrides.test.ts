import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPrOverride,
  effectivePrUrls,
  githubRepoFromRemote,
  normalizePrInput,
} from '../src/pr-overrides.ts';

const A = 'https://github.com/workbenchai/workbench/pull/1468';
const B = 'https://github.com/workbenchai/workbench/pull/1476';

test('normalizePrInput reads URLs, owner/repo#n and bare numbers', () => {
  assert.equal(normalizePrInput(`${B}/files?w=1`, null), B);
  assert.equal(normalizePrInput(' workbenchai/workbench#1476 ', null), B);
  assert.equal(normalizePrInput('#1476', 'workbenchai/workbench'), B);
  assert.equal(normalizePrInput('PR 1476', 'workbenchai/workbench'), B);
  assert.equal(normalizePrInput('1476', null), null);
  assert.equal(normalizePrInput('https://example.com/x/y/pull/1', 'a/b'), null);
  assert.equal(normalizePrInput('not a pr', 'a/b'), null);
});

test('githubRepoFromRemote handles https and ssh remotes', () => {
  assert.equal(githubRepoFromRemote('https://github.com/tinkerer/propanes.git\n'), 'tinkerer/propanes');
  assert.equal(githubRepoFromRemote('git@github.com:workbenchai/workbench.git'), 'workbenchai/workbench');
  assert.equal(githubRepoFromRemote('https://gitlab.com/a/b.git'), null);
});

test('manual adds survive and removals hide detected URLs', () => {
  let o = applyPrOverride([A], [], [], { add: B });
  assert.deepEqual(o, { added: [B], hidden: [] });
  assert.deepEqual(effectivePrUrls(JSON.stringify([A]), JSON.stringify(o.added), null), [A, B]);

  o = applyPrOverride([A], o.added, o.hidden, { remove: A });
  assert.deepEqual(o, { added: [B], hidden: [A] });
  // Re-detection of A (pr_urls rewritten by the session-service) stays hidden.
  assert.deepEqual(effectivePrUrls(JSON.stringify([A]), JSON.stringify(o.added), JSON.stringify(o.hidden)), [B]);

  // Adding a hidden detected URL back un-hides it without duplicating it.
  o = applyPrOverride([A], o.added, o.hidden, { add: A });
  assert.deepEqual(o, { added: [B], hidden: [] });

  o = applyPrOverride([A], o.added, o.hidden, { remove: B });
  assert.deepEqual(o, { added: [], hidden: [] });
});
