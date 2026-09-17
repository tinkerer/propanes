import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prSearchText } from '../src/components/PrBadges.js';

test('PR search indexes badge labels, numbers, repositories, and URLs', () => {
  const urls = ['https://github.com/Acme/dashboard/pull/123', 'https://github.com/Acme/api/pull/456'];
  for (const input of [urls, JSON.stringify(urls)]) {
    const text = prSearchText(input);
    for (const query of ['123', '#123', 'PR #123', 'PR 123', '#456', 'Acme/api', urls[1]]) {
      assert.ok(text.includes(query.toLowerCase()), `Should find ${query}`);
    }
    assert.equal(text.includes('#999'), false);
  }
});

test('missing or malformed PR metadata does not break session search', () => {
  for (const input of [undefined, null, '', 'invalid JSON', '{}', 123, [null, 42, 'https://example.com']]) {
    assert.equal(prSearchText(input), '');
  }
});
