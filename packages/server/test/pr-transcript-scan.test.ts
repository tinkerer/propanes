import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  newTranscriptCursor,
  prUrlsFromTranscriptText,
  scanTranscriptForPrUrls,
} from '../src/pr-transcript-scan.js';
import { mergePrUrlList, mergePrUrls } from '../src/pr-detect.js';

const PR = (n: number) => `https://github.com/workbenchai/workbench/pull/${n}`;

function assistant(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
}
function toolUse(command: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
  });
}
function toolResult(content: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content }] },
  });
}

test('finds the PR URL inside a collapsed tool result that never hit the screen', () => {
  const text = [
    toolUse('gh pr view 1353 --json state,url'),
    toolResult(JSON.stringify({ state: 'OPEN', url: PR(1353) })),
  ].join('\n') + '\n';
  assert.deepEqual(prUrlsFromTranscriptText(text), [PR(1353)]);
});

test('takes Claude Code pr-link records verbatim, including non-github.com hosts', () => {
  const link = (prUrl: string) => JSON.stringify({ type: 'pr-link', sessionId: 's', prNumber: 5, prUrl, prRepository: 'o/r', timestamp: 't' });
  const text = [
    link(PR(1353)),
    link(PR(1353)),
    link('https://ghe.example.com/o/r/pull/77'),
    link('https://ghe.example.com/o/r/pull/not-a-pr'),
    JSON.stringify({ type: 'pr-link', prUrl: 42 }),
  ].join('\n') + '\n';
  assert.deepEqual(prUrlsFromTranscriptText(text), [PR(1353), 'https://ghe.example.com/o/r/pull/77']);
});

test('ignores listings in tool results but not PRs the agent itself references', () => {
  const listing = JSON.stringify([1, 2, 3, 4, 5].map((n) => ({ number: n, url: PR(n) })));
  const text = [
    toolUse('gh pr list --json number,url'),
    toolResult(listing),
    assistant(`Opened ${PR(42)} and rebased it on ${PR(41)}, ${PR(40)}, ${PR(39)}.`),
    toolResult(`${PR(7)}\n${PR(8)}`),
  ].join('\n') + '\n';
  assert.deepEqual(prUrlsFromTranscriptText(text).sort(), [PR(39), PR(40), PR(41), PR(42), PR(7), PR(8)].sort());
});

test('handles escaped slashes and non-JSON lines', () => {
  const escaped = '{"type":"user","message":{"content":"see https:\\/\\/github.com\\/o\\/r\\/pull\\/12"}}';
  assert.deepEqual(prUrlsFromTranscriptText(escaped + '\nnot json https://github.com/o/r/pull/13\n'), [
    'https://github.com/o/r/pull/12',
    'https://github.com/o/r/pull/13',
  ]);
});

test('scans a transcript incrementally and restarts after rotation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'propanes-pr-scan-'));
  try {
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, toolResult(`created ${PR(100)}`) + '\n');
    const cursor = newTranscriptCursor();

    assert.deepEqual(scanTranscriptForPrUrls(file, cursor), [PR(100)]);
    assert.equal(cursor.path, file);
    assert.ok(cursor.offset > 0);

    // Nothing new → nothing reported, offset unchanged.
    const offset = cursor.offset;
    assert.deepEqual(scanTranscriptForPrUrls(file, cursor), []);
    assert.equal(cursor.offset, offset);

    // A half-written line is held back until its newline lands...
    appendFileSync(file, assistant(`follow-up on ${PR(101)}`));
    assert.deepEqual(scanTranscriptForPrUrls(file, cursor), []);
    assert.equal(cursor.offset, offset);
    // ...unless this is the final scan of an ended session.
    assert.deepEqual(scanTranscriptForPrUrls(file, cursor, true), [PR(101)]);

    // A rotated (shorter) file is rescanned from the start.
    writeFileSync(file, assistant(`now on ${PR(102)}`) + '\n');
    assert.deepEqual(scanTranscriptForPrUrls(file, cursor), [PR(102)]);

    // A different transcript path (after /clear) resets the cursor.
    const other = join(dir, 'other.jsonl');
    writeFileSync(other, assistant(`cleared, on ${PR(103)}`) + '\n');
    assert.deepEqual(scanTranscriptForPrUrls(other, cursor), [PR(103)]);
    assert.equal(cursor.path, other);

    assert.deepEqual(scanTranscriptForPrUrls(null, cursor), []);
    assert.deepEqual(scanTranscriptForPrUrls(join(dir, 'missing.jsonl'), cursor), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mergePrUrlList adds only new URLs and reports no change otherwise', () => {
  assert.equal(mergePrUrlList(null, []), null);
  assert.equal(mergePrUrlList(JSON.stringify([PR(1)]), [PR(1)]), null);
  assert.equal(mergePrUrlList(JSON.stringify([PR(1)]), [PR(2), PR(1)]), JSON.stringify([PR(1), PR(2)]));
  assert.equal(mergePrUrlList('not json', [PR(3)]), JSON.stringify([PR(3)]));
  // The PTY path still goes through the same merge.
  assert.equal(mergePrUrls(null, `see ${PR(9)} now`), JSON.stringify([PR(9)]));
});
