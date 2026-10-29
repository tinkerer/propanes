import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPrUrls, mergePrUrlList, canonicalizePrUrls, dropShadowedPrUrls } from '../src/pr-detect.js';

const OK = 'https://github.com/examplecorp/widgets/pull/1356';

test('a cursor-forward for an unchanged cell never yields a URL missing that character', () => {
  // Renderer skipped the unchanged "o": the stream reads `examplec` CUF `rp`.
  const raw = 'see https://github.com/examplec\x1b[Crp/widgets/pull/1356\x1b[C(branch)';
  assert.deepEqual(extractPrUrls(raw), []);
  // The same line painted in full later is still found, and a wrapped URL
  // split by a newline/CUP repaint still joins.
  assert.deepEqual(extractPrUrls(`x ${OK}\x1b[C(branch)`), [OK]);
  assert.deepEqual(extractPrUrls('https://github.com/examplecorp/widgets/pu\r\n\x1b[25;3Hll/1356 ok'), [OK]);
  assert.deepEqual(extractPrUrls('https://github.com/examplecorp/\x1b[3Cwidgets/pull/1356'), []);
});

test('dropShadowedPrUrls removes character-dropped and truncated variants of a present URL', () => {
  const damaged = [
    'https://github.com/examplecrp/widgets/pull/1356',
    'https://github.com/exampecorp/widgets/pull/1356',
    'https://github.com/examplecorp/widgets/pull/1',
    OK,
    'https://github.com/examplecorp/widgets/pull/1357',
  ];
  assert.deepEqual(dropShadowedPrUrls(damaged), [OK, 'https://github.com/examplecorp/widgets/pull/1357']);
  // Without the intact URL present nothing can be proven damaged.
  assert.deepEqual(dropShadowedPrUrls(['https://github.com/examplecrp/widgets/pull/1356']), ['https://github.com/examplecrp/widgets/pull/1356']);
  assert.deepEqual(dropShadowedPrUrls([]), []);
});

test('merging the intact URL scrubs a damaged one already stored', () => {
  const stored = JSON.stringify(['https://github.com/examplecrp/widgets/pull/1356']);
  assert.equal(mergePrUrlList(stored, [OK]), JSON.stringify([OK]));
  assert.equal(canonicalizePrUrls(JSON.stringify([OK])), null);
  assert.equal(canonicalizePrUrls(null), null);
  assert.equal(canonicalizePrUrls(JSON.stringify([OK, 'https://github.com/examplecorp/widgets/pull/13'])), JSON.stringify([OK]));
});
