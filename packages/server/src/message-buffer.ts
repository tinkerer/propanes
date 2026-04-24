import { MAX_PENDING_MESSAGES, MESSAGE_TTL_MS } from '@propanes/shared';
import { sqlite } from './db/index.js';

interface PendingEntry {
  seq: number;
  content: string;
  createdAt: number;
}

// Sqlite writes on the PTY hot path can race with other writers (main server
// flushes, drizzle updates) and return SQLITE_BUSY even with busy_timeout=5000.
// Letting the exception propagate kills the session-service from inside
// node-pty's synchronous onData dispatch, which takes down every live
// AgentTerminal. The in-memory queue is authoritative for replay during a
// single process lifetime; the sqlite mirror only matters across restarts, so
// dropping a row on SQLITE_BUSY is strictly better than crashing.
function safeRun(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
      console.warn(`[message-buffer] ${label}: ${code} — dropping durable mirror (in-memory buffer intact)`);
    } else {
      console.error(`[message-buffer] ${label} failed:`, err);
    }
  }
}

export class MessageBuffer {
  private pending = new Map<string, PendingEntry[]>();
  private pruneTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.loadFromDb();
    this.pruneTimer = setInterval(() => this.prune(), 60_000);
  }

  private bufferKey(sessionId: string, direction: string): string {
    return `${sessionId}:${direction}`;
  }

  append(sessionId: string, direction: 'output' | 'input', seq: number, content: string): void {
    const key = this.bufferKey(sessionId, direction);
    let queue = this.pending.get(key);
    if (!queue) {
      queue = [];
      this.pending.set(key, queue);
    }

    // Drop oldest if at capacity
    while (queue.length >= MAX_PENDING_MESSAGES) {
      const dropped = queue.shift()!;
      this.deleteFromDb(sessionId, direction, dropped.seq);
    }

    const now = Date.now();
    queue.push({ seq, content, createdAt: now });

    safeRun('append', () => {
      sqlite
        .prepare(
          `INSERT INTO pending_messages (session_id, direction, seq_num, content, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(sessionId, direction, seq, content, new Date(now).toISOString());
    });
  }

  ack(sessionId: string, direction: 'output' | 'input', ackSeq: number): void {
    const key = this.bufferKey(sessionId, direction);
    const queue = this.pending.get(key);
    if (queue) {
      const before = queue.length;
      const remaining = queue.filter((e) => e.seq > ackSeq);
      if (remaining.length !== before) {
        if (remaining.length === 0) {
          this.pending.delete(key);
        } else {
          this.pending.set(key, remaining);
        }
      }
    }

    safeRun('ack', () => {
      sqlite
        .prepare(
          `DELETE FROM pending_messages WHERE session_id = ? AND direction = ? AND seq_num <= ?`,
        )
        .run(sessionId, direction, ackSeq);
    });
  }

  getUnacked(
    sessionId: string,
    direction: 'output' | 'input',
    fromSeq: number,
  ): Array<{ seq: number; content: string }> {
    const key = this.bufferKey(sessionId, direction);
    const queue = this.pending.get(key);
    if (!queue) return [];

    const now = Date.now();
    return queue
      .filter((e) => e.seq >= fromSeq && now - e.createdAt < MESSAGE_TTL_MS)
      .map((e) => ({ seq: e.seq, content: e.content }));
  }

  clearSession(sessionId: string): void {
    for (const dir of ['output', 'input'] as const) {
      this.pending.delete(this.bufferKey(sessionId, dir));
    }
    safeRun('clearSession', () => {
      sqlite.prepare(`DELETE FROM pending_messages WHERE session_id = ?`).run(sessionId);
    });
  }

  private prune(): void {
    const now = Date.now();
    const cutoff = new Date(now - MESSAGE_TTL_MS).toISOString();

    for (const [key, queue] of this.pending) {
      const remaining = queue.filter((e) => now - e.createdAt < MESSAGE_TTL_MS);
      if (remaining.length === 0) {
        this.pending.delete(key);
      } else if (remaining.length !== queue.length) {
        this.pending.set(key, remaining);
      }
    }

    safeRun('prune', () => {
      sqlite.prepare(`DELETE FROM pending_messages WHERE created_at < ?`).run(cutoff);
    });
  }

  private deleteFromDb(sessionId: string, direction: string, seq: number): void {
    safeRun('deleteFromDb', () => {
      sqlite
        .prepare(
          `DELETE FROM pending_messages WHERE session_id = ? AND direction = ? AND seq_num = ?`,
        )
        .run(sessionId, direction, seq);
    });
  }

  private loadFromDb(): void {
    const rows = sqlite
      .prepare(`SELECT session_id, direction, seq_num, content, created_at FROM pending_messages ORDER BY seq_num ASC`)
      .all() as Array<{
      session_id: string;
      direction: string;
      seq_num: number;
      content: string;
      created_at: string;
    }>;

    for (const row of rows) {
      const key = this.bufferKey(row.session_id, row.direction);
      let queue = this.pending.get(key);
      if (!queue) {
        queue = [];
        this.pending.set(key, queue);
      }
      queue.push({
        seq: row.seq_num,
        content: row.content,
        createdAt: new Date(row.created_at).getTime(),
      });
    }
  }

  destroy(): void {
    clearInterval(this.pruneTimer);
  }
}
