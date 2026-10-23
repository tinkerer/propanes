import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { isTmuxAvailable, killTmuxSession, sendKeysToTmux, SEND_KEYS_ENTER_DELAY_MS } from '../src/tmux-pty.js';

const TMUX = ['-u', '-L', 'propanes'];
const skip = !isTmuxAvailable() && 'tmux is required for this integration test';

// `cat -v` prints the bytes the pane program receives, with escapes as ^[.
function startPane(sessionId: string, enableBracketedPaste: boolean): void {
  const setup = enableBracketedPaste ? String.raw`printf '\033[?2004h'; ` : '';
  execFileSync('tmux', [...TMUX, 'new-session', '-d', '-s', `pw-${sessionId}`, '-x', '120', '-y', '24', `${setup}cat -v`]);
}

async function paneOutput(sessionId: string, predicate: (text: string) => boolean): Promise<string> {
  const deadline = Date.now() + 3000;
  let text = '';
  while (Date.now() < deadline) {
    text = execFileSync('tmux', [...TMUX, 'capture-pane', '-p', '-t', `pw-${sessionId}`], { encoding: 'utf8' });
    if (predicate(text)) break;
    await delay(25);
  }
  return text;
}

test('send-keys delivers text as a bracketed paste when the program asked for it, then Enter', { skip, timeout: 10_000 }, async () => {
  const sessionId = `send-keys-paste-${process.pid}`;
  startPane(sessionId, true);
  try {
    await delay(300);
    const sentAt = Date.now();
    assert.ok(sendKeysToTmux(sessionId, '2169 merged, please -v get this done', true));
    // cat echoes the line only once Enter arrives, so a second copy means Enter landed.
    const text = await paneOutput(sessionId, (t) => t.split('2169 merged').length > 2);
    assert.ok(Date.now() - sentAt >= SEND_KEYS_ENTER_DELAY_MS, 'Enter waits for the paste window to close');
    assert.match(text, /\^\[\[200~2169 merged, please -v get this done\^\[\[201~/);
  } finally {
    killTmuxSession(sessionId);
  }
});

test('send-keys types plain characters into a program without bracketed paste', { skip, timeout: 10_000 }, async () => {
  const sessionId = `send-keys-plain-${process.pid}`;
  startPane(sessionId, false);
  try {
    await delay(300);
    assert.ok(sendKeysToTmux(sessionId, 'plain prompt', true));
    const text = await paneOutput(sessionId, (t) => t.split('plain prompt').length > 2);
    assert.ok(!text.includes('200~'), 'no paste markers for a program that did not enable them');
  } finally {
    killTmuxSession(sessionId);
  }
});

test('send-keys sends control characters as keystrokes, not as pasted text', { skip, timeout: 10_000 }, async () => {
  const sessionId = `send-keys-ctrl-${process.pid}`;
  startPane(sessionId, true);
  try {
    await delay(300);
    assert.ok(sendKeysToTmux(sessionId, '\x1b', false));
    const text = await paneOutput(sessionId, (t) => t.includes('^['));
    assert.ok(text.includes('^['), 'escape reached the program');
    assert.ok(!text.includes('200~'), 'a keystroke is never wrapped in paste markers');
  } finally {
    killTmuxSession(sessionId);
  }
});

test('send-keys reports a missing pane', () => {
  assert.equal(sendKeysToTmux(`send-keys-missing-${process.pid}`, 'hello', false), false);
});
