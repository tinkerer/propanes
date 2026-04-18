#!/usr/bin/env node
/**
 * Bell detection test: spawns N terminal sessions via the admin API,
 * then runs a script in each that emits \a (bell) to simulate
 * Claude Code waiting-for-input prompts.
 *
 * Usage:
 *   node pw-bell-test.mjs [count=3]
 *
 * Each session cycles between "working" (output) and "waiting" (bell).
 * Use this to verify the blinking green dots in the admin UI.
 *
 * Press Ctrl+C to kill all test sessions.
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const BASE = 'http://localhost:3001/api/v1';
const TMUX_SOCKET = 'prompt-widget';
const count = parseInt(process.argv[2] || '3', 10);

const sessionIds = [];

function tmux(...args) {
  return execSync(`tmux -L ${TMUX_SOCKET} ${args.join(' ')}`, { encoding: 'utf8' }).trim();
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return res.json();
}

async function cleanup() {
  console.log('\nKilling test sessions...');
  for (const id of sessionIds) {
    try {
      await api(`/admin/agent-sessions/${id}/kill`, { method: 'POST' });
      console.log(`  ✓ killed ${id.slice(-8)}`);
    } catch {}
  }
  // Clean up temp script
  try { unlinkSync(scriptPath); } catch {}
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Write the bell script to a temp file so we can source it from tmux
const scriptPath = join(tmpdir(), 'pw-bell-test.sh');
writeFileSync(scriptPath, `#!/bin/bash
clear
echo "Bell test session - cycles between working and waiting"
echo ""
while true; do
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "⏺ Working on task..."
  echo "  Reading files, analyzing code..."
  sleep 2
  echo "  Making changes to src/component.tsx"
  echo "  ✓ Edit applied"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " Bash command"
  echo ""
  echo "   npm test"
  echo ""
  echo " Do you want to proceed?"
  echo " ❯ 1. Yes"
  echo "   2. Yes, and don't ask again"
  echo "   3. No"
  echo ""
  echo " Esc to cancel · Tab to amend"
  printf "\\a"
  echo "[BELL SENT - should be blinking now]"
  sleep 10
  echo ""
  echo "[Resuming work - should stop blinking soon]"
  # Emit enough visible output to clear the waiting state (need >2000 visible bytes)
  for i in $(seq 1 80); do echo "  ... processing output line $i of 80, generating visible text to clear waiting state ..."; done
  sleep 1
done
`);
execSync(`chmod +x ${scriptPath}`);

console.log(`Spawning ${count} test terminal sessions...\n`);

for (let i = 0; i < count; i++) {
  const result = await api('/admin/terminal', {
    method: 'POST',
    body: JSON.stringify({}),
  });

  if (result.sessionId) {
    sessionIds.push(result.sessionId);
    console.log(`  ✓ Session ${i + 1}: ${result.sessionId.slice(-8)} (${result.sessionId})`);
  } else {
    console.error(`  ✗ Session ${i + 1} failed:`, result);
  }
}

// Stagger the starts so they don't all blink in sync
console.log('\nInjecting bell scripts (staggered)...');
for (let i = 0; i < sessionIds.length; i++) {
  const id = sessionIds[i];
  const delay = i * 3; // stagger by 3 seconds
  try {
    await new Promise(r => setTimeout(r, 2000));
    const cmd = delay > 0 ? `sleep ${delay} && bash ${scriptPath}` : `bash ${scriptPath}`;
    execSync(`tmux -L ${TMUX_SOCKET} send-keys -t pw-${id} '${cmd}' Enter`);
    console.log(`  ✓ ${id.slice(-8)}: starts in ${delay}s`);
  } catch (err) {
    console.error(`  ✗ ${id.slice(-8)}: ${err.message}`);
  }
}

console.log(`
${sessionIds.length} sessions running. They will cycle:
  - ~4s of "working" output (no blink)
  - bell + 10s of "waiting" (should blink green)
  - 30 lines of output to clear waiting state

Open http://localhost:3001/admin/ to see the blinking dots.
Press Ctrl+C to kill all test sessions.
`);

// Monitor sessions
setInterval(async () => {
  const lines = [];
  for (const id of sessionIds) {
    try {
      const res = await fetch(`http://localhost:3002/status/${id}`);
      const data = await res.json();
      lines.push(`${id.slice(-8)}: waiting=${data.waitingForInput}`);
    } catch {
      lines.push(`${id.slice(-8)}: not active`);
    }
  }
  console.log(`[${new Date().toLocaleTimeString()}] ${lines.join(' | ')}`);
}, 5000);
