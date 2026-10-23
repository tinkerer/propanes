/** Durable listener state: thread↔session mappings, per-user agent preferences,
 * delivery checkpoints and recently seen Slack event ids. One JSON document,
 * written atomically (tmp + rename) so a crash never leaves a torn file. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OutputMode, Runtime } from './options';

export type SessionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'cancelled' | string;

export interface DeliveryCheckpoint {
  /** Opaque transcript cursor from the last fully delivered poll ('init' = none yet). */
  cursor: string;
  /** Keys of recently delivered transcript events; guards at-least-once overlap. */
  delivered: string[];
  /** A prompt was sent and its answer has not been reported as finished. */
  turnOpen: boolean;
  /** Assistant text seen during the open turn (quiet mode's final-answer source). */
  turnTexts: string[];
  lastStatus: SessionStatus | null;
  lastInputState: string | null;
  idlePolls: number;
  waitingNotified: boolean;
  /** Dedupe keys of images already uploaded to the thread. */
  uploadedImages: string[];
  scopeWarned: boolean;
  lastActivityAt: number;
  /** Transcript events stamped before this epoch-ms are never posted: a fresh
   * session's first poll may still resolve to another session's transcript,
   * and a resumed session continues the transcript the thread already saw. */
  since?: number;
  /** Prompts this listener sent to the session (Slack text, send-keys text,
   * resume prompts), newest last. A transcript user turn matching none of
   * them was typed outside Slack and is announced in the thread. */
  sentPrompts?: string[];
}

export interface SessionLink { sessionId: string; runtime: Runtime; agentName: string; createdAt: string; }

export interface ThreadRecord {
  key: string;
  teamId: string;
  channel: string;
  /** Slack thread root; null for a flat DM conversation. */
  threadTs: string | null;
  sessionId: string;
  feedbackId: string;
  runtime: Runtime;
  agentEndpointId: string;
  agentName: string;
  mode: OutputMode;
  images: boolean;
  /** Every session this thread has driven, oldest first (continuations append). */
  history: SessionLink[];
  delivery: DeliveryCheckpoint;
  watching: boolean;
  /** The thread was already told the bot cannot read Slack files (missing scope). */
  filesReadWarned?: boolean;
  /** The current session was stopped on purpose (idle timeout or `stop`) and
   * the next reply resumes it; cleared once a continuation starts. */
  paused?: { at: string; reason: 'idle' | 'stop'; sessionId: string };
  createdAt: string;
  updatedAt: string;
}

export interface BotState {
  version: 1;
  threads: Record<string, ThreadRecord>;
  runtimePrefs: Record<string, Runtime>;
  seenEvents: string[];
}

export function emptyState(): BotState {
  return { version: 1, threads: {}, runtimePrefs: {}, seenEvents: [] };
}

export function freshCheckpoint(now = Date.now(), since?: number): DeliveryCheckpoint {
  return {
    cursor: 'init', delivered: [], turnOpen: true, turnTexts: [], lastStatus: null, lastInputState: null,
    idlePolls: 0, waitingNotified: false, uploadedImages: [], scopeWarned: false, lastActivityAt: now,
    ...(since !== undefined ? { since } : {}),
  };
}

export interface StateStore {
  load(): BotState;
  save(state: BotState): void;
}

export class MemoryStateStore implements StateStore {
  constructor(private state: BotState = emptyState()) {}
  load(): BotState { return JSON.parse(JSON.stringify(this.state)); }
  save(state: BotState): void { this.state = JSON.parse(JSON.stringify(state)); }
}

export class FileStateStore implements StateStore {
  constructor(private readonly path: string) {}
  load(): BotState {
    if (!existsSync(this.path)) return emptyState();
    const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<BotState>;
    return { ...emptyState(), ...parsed, version: 1 };
  }
  save(state: BotState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = join(dirname(this.path), `.${Date.now()}-${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

const SEEN_EVENT_CAP = 2000;
const DELIVERED_CAP = 400;

export function threadKey(teamId: string, channel: string, threadTs: string | null): string {
  return `${teamId}:${channel}:${threadTs ?? 'dm'}`;
}

/** In-memory copy of the state with write-through persistence. */
export class StateRepo {
  private state: BotState;
  constructor(private readonly store: StateStore) {
    this.state = store.load();
  }

  snapshot(): BotState { return this.state; }

  getThread(key: string): ThreadRecord | undefined { return this.state.threads[key]; }
  putThread(record: ThreadRecord): void {
    record.updatedAt = new Date().toISOString();
    if (record.delivery.delivered.length > DELIVERED_CAP) {
      record.delivery.delivered = record.delivery.delivered.slice(-DELIVERED_CAP);
    }
    this.state.threads[record.key] = record;
    this.store.save(this.state);
  }
  threads(): ThreadRecord[] { return Object.values(this.state.threads); }

  getRuntimePref(teamId: string, userId: string): Runtime | undefined {
    return this.state.runtimePrefs[`${teamId}:${userId}`];
  }
  setRuntimePref(teamId: string, userId: string, runtime: Runtime): void {
    this.state.runtimePrefs[`${teamId}:${userId}`] = runtime;
    this.store.save(this.state);
  }

  /** Returns false when the event was already processed (Slack retry / duplicate delivery). */
  markEvent(id: string): boolean {
    if (this.state.seenEvents.includes(id)) return false;
    this.state.seenEvents.push(id);
    if (this.state.seenEvents.length > SEEN_EVENT_CAP) this.state.seenEvents = this.state.seenEvents.slice(-SEEN_EVENT_CAP);
    this.store.save(this.state);
    return true;
  }
}
