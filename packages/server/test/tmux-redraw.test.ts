import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { isTmuxAvailable, reattachTmux, killTmuxSession, refreshTmuxClient } from '../src/tmux-pty.js';

test('tmux refresh restores static text after idle animation deltas without resizing', {
  skip: !isTmuxAvailable() && 'tmux is required for this integration test',
  timeout: 10_000,
}, async () => {
  const sessionId = `redraw-test-${process.pid}`;
  execFileSync('tmux', ['-u', '-L', 'propanes', 'new-session', '-d',
    '-s', `pw-${sessionId}`, '-x', '80', '-y', '24',
    String.raw`printf '\033[2J\033[HSTATIC CONVERSATION\033[5;1HREADY PROMPT'; while :; do printf '\033[10;1H.'; sleep 0.1; done`,
  ]);
  let terminal: ReturnType<typeof reattachTmux> | undefined;
  try {
    terminal = reattachTmux({ sessionId, cols: 80, rows: 24 });
    let output = '';
    let lastFullPaint = Date.now();
    terminal.onData((data) => {
      output += data;
      if (data.includes('STATIC CONVERSATION')) lastFullPaint = Date.now();
    });
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (!predicate() && Date.now() < deadline) await delay(25);
      assert.ok(predicate(), 'expected terminal output before timeout');
    };
    await waitFor(() => output.includes('READY PROMPT'));
    // tmux may repaint again while negotiating terminal capabilities on attach.
    await waitFor(() => Date.now() - lastFullPaint >= 600);
    output = '';
    await waitFor(() => output.includes('.'));
    assert.ok(!output.includes('STATIC CONVERSATION'), 'idle updates omit static content');

    output = '';
    assert.ok(await refreshTmuxClient(terminal));
    await waitFor(() => output.includes('STATIC CONVERSATION') && output.includes('READY PROMPT'));
    assert.equal(terminal.cols, 80);
    assert.equal(terminal.rows, 24);
    assert.equal(execFileSync('tmux', ['-L', 'propanes', 'display-message', '-p',
      '-t', `pw-${sessionId}`, '#{pane_width}x#{pane_height}',
    ], { encoding: 'utf8' }).trim(), '80x24');
  } finally {
    terminal?.kill();
    killTmuxSession(sessionId);
  }
});

test('tmux refresh tolerates a client that has already exited', async () => {
  assert.equal(await refreshTmuxClient({ pid: -1 }), false);
  assert.equal(await refreshTmuxClient({ pid: process.pid }), false);
});
