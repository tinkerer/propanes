// SSH gateway — native-terminal access to agent sessions WITHOUT sshd on any
// pod and without handing users infrastructure (kubectl/Azure) credentials.
//
// A single in-process SSH server authenticates propanes users (password, or an
// admin JWT pasted as the password) and bridges the SSH channel onto the same
// admin-attach plumbing the web terminal uses (attachAdmin/forwardToService in
// agent-sessions.ts), so it works identically for sessions hosted locally, on
// remote launcher pods, and on sprites. Session visibility is scoped with
// visibleToMember — users can only attach to sessions in their own workspace.
//
//   ssh -p 2222 <user>@<gateway> attach <sessionId>   # attach one session
//   ssh -p 2222 <user>@<gateway>                      # list your sessions
//
// Disabled unless SSH_GATEWAY_PORT is set. Expose it with a TCP LoadBalancer /
// port-forward — see ops/ssh-gateway-service.yaml.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
// ssh2 is CommonJS — named ESM imports fail at runtime; go through the default.
import ssh2 from 'ssh2';
const { Server: SshServer } = ssh2;
import { eq, desc, and, inArray } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { verifyPassword, verifyToken } from './auth.js';
import { resolveAdminUser, visibleToMember, type AdminUser } from './admin-auth.js';
import { attachAdmin, detachAdmin, forwardToService } from './agent-sessions.js';
import type { WebSocket as WsWebSocket } from 'ws';

const PORT = Number(process.env.SSH_GATEWAY_PORT || 0);

function hostKeyPath(): string {
  if (process.env.SSH_GATEWAY_HOST_KEY) return process.env.SSH_GATEWAY_HOST_KEY;
  const dataDir = process.env.DB_PATH ? dirname(process.env.DB_PATH) : '.';
  return join(dataDir, 'ssh_host_rsa_key');
}

// Persist the host key next to the DB so clients don't get MITM warnings on
// every pod restart.
function loadOrCreateHostKey(): Buffer {
  const path = hostKeyPath();
  if (existsSync(path)) return readFileSync(path);
  // RSA/PKCS#1 — the one PEM format ssh2's key parser accepts universally
  // (its parser does not read PKCS#8 ed25519).
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, pem, { mode: 0o600 });
    console.log(`[ssh-gateway] Generated host key at ${path}`);
  } catch (err) {
    console.warn('[ssh-gateway] Could not persist host key (using ephemeral):', err instanceof Error ? err.message : err);
  }
  return Buffer.from(pem);
}

async function authenticate(username: string, password: string): Promise<AdminUser | null> {
  // 1. DB user with their normal password
  const user = db.select().from(schema.users).where(eq(schema.users.username, username)).get();
  if (user && user.status === 'active' && verifyPassword(password, user.passwordHash)) {
    return {
      id: user.id,
      username: user.username,
      role: user.role as 'admin' | 'member',
      orgId: user.orgId ?? null,
      launcherId: user.launcherId ?? null,
    };
  }
  // 2. Env admin (same fallback as /auth/login)
  const envUser = process.env.ADMIN_USER || 'admin';
  const envPass = process.env.ADMIN_PASS || 'admin';
  if (!user && username === envUser && password === envPass) {
    return { id: 'env-admin', username, role: 'admin', orgId: null, launcherId: null };
  }
  // 3. An admin JWT pasted as the password (username must match the token's)
  const resolved = resolveAdminUser(await verifyToken(password));
  if (resolved && resolved.username === username) return resolved;
  return null;
}

function listSessionLines(user: AdminUser): string[] {
  const rows = db
    .select({
      id: schema.agentSessions.id,
      status: schema.agentSessions.status,
      ownerUserId: schema.agentSessions.ownerUserId,
      orgId: schema.agentSessions.orgId,
      createdAt: schema.agentSessions.createdAt,
      title: schema.agentSessions.title,
    })
    .from(schema.agentSessions)
    .where(and(inArray(schema.agentSessions.status, ['pending', 'running'])))
    .orderBy(desc(schema.agentSessions.createdAt))
    .limit(50)
    .all()
    .filter((s) => visibleToMember(s, user));
  if (rows.length === 0) return ['No running sessions.'];
  const lines = ['Running sessions:', ''];
  for (const s of rows) {
    lines.push(`  ${s.id}  ${(s.status || '').padEnd(8)} ${s.title || ''}`);
  }
  lines.push('', 'Attach with:  ssh -t <user>@<gateway> attach <sessionId>');
  return lines;
}

// Minimal stand-in for the browser WebSocket that attachAdmin() normally
// receives — translates the JSON admin-attach protocol to raw SSH bytes.
type BridgeChannel = {
  write: (data: string | Buffer) => void;
  end: () => void;
};

function makeBridge(sessionId: string, channel: BridgeChannel, onClose: () => void) {
  let lastOutputSeq = 0;
  let inputSeq = 0;
  let sawHistory = false;
  let closed = false;

  const fakeWs = {
    readyState: 1,
    OPEN: 1,
    send(raw: string) {
      if (closed) return;
      let msg: any;
      try { msg = JSON.parse(raw); } catch { return; }
      switch (msg.type) {
        case 'history':
          if (typeof msg.lastInputAckSeq === 'number' && msg.lastInputAckSeq > inputSeq) {
            inputSeq = msg.lastInputAckSeq;
          }
          if (msg.data) {
            // History is a full snapshot; replace the screen on re-sends.
            channel.write((sawHistory ? '\x1bc' : '') + msg.data);
            sawHistory = true;
          }
          break;
        case 'sequenced_output': {
          const seq: number = msg.seq;
          if (seq <= lastOutputSeq) break;
          lastOutputSeq = seq;
          const content = msg.content || {};
          if (content.kind === 'output' && content.data) {
            channel.write(content.data);
          } else if (content.kind === 'error' && content.data) {
            channel.write(`\r\n\x1b[31m${content.data}\x1b[0m\r\n`);
          } else if (content.kind === 'exit') {
            channel.write(`\r\n\x1b[33m--- Session exited (code: ${content.exitCode ?? 'unknown'}) ---\x1b[0m\r\n`);
            close();
          }
          forwardToService(fakeWs as unknown as WsWebSocket, JSON.stringify({ type: 'output_ack', sessionId, ackSeq: seq }));
          break;
        }
        case 'output':
          if (msg.data) channel.write(msg.data);
          break;
        case 'exit':
          channel.write(`\r\n\x1b[33m--- Session exited (code: ${msg.exitCode ?? 'unknown'}) ---\x1b[0m\r\n`);
          close();
          break;
      }
    },
    close(_code?: number, reason?: string) {
      if (reason) {
        try { channel.write(`\r\n\x1b[33m${reason}\x1b[0m\r\n`); } catch {}
      }
      close();
    },
  };

  function close() {
    if (closed) return;
    closed = true;
    detachAdmin(sessionId, fakeWs as unknown as WsWebSocket);
    try { channel.end(); } catch {}
    onClose();
  }

  return {
    fakeWs: fakeWs as unknown as WsWebSocket,
    sendInput(data: string) {
      inputSeq++;
      forwardToService(fakeWs as unknown as WsWebSocket, JSON.stringify({
        type: 'sequenced_input',
        sessionId,
        seq: inputSeq,
        content: { kind: 'input', data },
        timestamp: new Date().toISOString(),
      }));
    },
    sendResize(cols: number, rows: number) {
      if (!cols || !rows) return;
      inputSeq++;
      forwardToService(fakeWs as unknown as WsWebSocket, JSON.stringify({
        type: 'sequenced_input',
        sessionId,
        seq: inputSeq,
        content: { kind: 'resize', cols, rows },
        timestamp: new Date().toISOString(),
      }));
    },
    close,
  };
}

export function startSshGateway(): void {
  if (!PORT) return;

  const server = new SshServer({ hostKeys: [loadOrCreateHostKey()] }, (client) => {
    let user: AdminUser | null = null;

    client.on('authentication', (ctx) => {
      if (ctx.method !== 'password') {
        return ctx.reject(['password']);
      }
      authenticate(ctx.username, ctx.password)
        .then((resolved) => {
          if (resolved) {
            user = resolved;
            ctx.accept();
          } else {
            ctx.reject(['password']);
          }
        })
        .catch(() => ctx.reject(['password']));
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        let ptySize: { cols: number; rows: number } | null = null;
        let bridge: ReturnType<typeof makeBridge> | null = null;

        session.on('pty', (accept2, _reject, info) => {
          ptySize = { cols: info.cols || 80, rows: info.rows || 24 };
          accept2?.();
        });

        session.on('window-change', (accept2, _reject, info) => {
          ptySize = { cols: info.cols || 80, rows: info.rows || 24 };
          bridge?.sendResize(ptySize.cols, ptySize.rows);
          accept2?.();
        });

        const startAttach = (channel: any, sessionId: string) => {
          if (!user) { channel.end(); return; }
          const row = db
            .select({ ownerUserId: schema.agentSessions.ownerUserId, orgId: schema.agentSessions.orgId })
            .from(schema.agentSessions)
            .where(eq(schema.agentSessions.id, sessionId))
            .get();
          if (!row || !visibleToMember(row, user)) {
            channel.write(`Session not found: ${sessionId}\r\n`);
            channel.exit(1);
            channel.end();
            return;
          }
          bridge = makeBridge(sessionId, channel, () => {
            try { channel.exit(0); } catch {}
          });
          const attached = attachAdmin(sessionId, bridge.fakeWs);
          if (!attached) {
            channel.write(`Session not found: ${sessionId}\r\n`);
            channel.exit(1);
            channel.end();
            return;
          }
          console.log(`[ssh-gateway] ${user.username} attached to ${sessionId}`);
          if (ptySize) bridge.sendResize(ptySize.cols, ptySize.rows);
          channel.on('data', (data: Buffer) => bridge?.sendInput(data.toString('utf8')));
          channel.on('close', () => bridge?.close());
        };

        const showList = (channel: any) => {
          if (!user) { channel.end(); return; }
          channel.write(listSessionLines(user).join('\r\n') + '\r\n');
          channel.exit(0);
          channel.end();
        };

        session.on('exec', (accept2, _reject, info) => {
          const channel = accept2();
          const cmd = (info.command || '').trim();
          const m = cmd.match(/^(?:attach\s+)?(?:pw-)?([a-zA-Z0-9_-]+)$/);
          if (cmd === 'ls' || cmd === 'list' || cmd === 'sessions' || !cmd) {
            showList(channel);
          } else if (m && m[1] !== 'ls' && m[1] !== 'list' && m[1] !== 'sessions') {
            startAttach(channel, m[1]);
          } else {
            channel.write(`Unknown command. Usage: attach <sessionId> | list\r\n`);
            channel.exit(1);
            channel.end();
          }
        });

        session.on('shell', (accept2) => {
          const channel = accept2();
          showList(channel);
        });
      });
    });

    client.on('error', (err) => {
      // Auth failures and port scans land here; keep the log quiet but present.
      console.log('[ssh-gateway] client error:', err.message);
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[ssh-gateway] Listening on :${PORT}`);
  });
  server.on('error', (err: Error) => {
    console.error('[ssh-gateway] server error:', err.message);
  });
}
