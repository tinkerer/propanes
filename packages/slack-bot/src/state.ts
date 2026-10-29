/** Durable listener state: thread↔session mappings, per-user agent preferences,
 * delivery checkpoints and recently seen Slack event ids. One JSON document,
 * written atomically (tmp + rename) so a crash never leaves a torn file. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ModelOption } from './models';
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
  kind?: 'terminal';
  key: string;
  teamId: string;
  channel: string;
  /** Slack thread root; null for a flat DM conversation. */
  threadTs: string | null;
  sessionId: string;
  feedbackId: string;
  /** ProPanes application the thread's sessions run in (records from before
   * app selection fall back to the configured default). */
  appId?: string;
  appName?: string;
  /** Remote launcher the thread's sessions run on (`[infra:…]`); unset = this server.
   * Continuations inherit it server-side (resume falls back to the parent's launcher). */
  launcherId?: string;
  infraName?: string;
  runtime: Runtime;
  model?: string;
  /** Resume profile for sessions moved in from ProPanes (keeps their own
   * permissions); unset = the listener's interactive-yolo profile. */
  permissionProfile?: string;
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
  /** Conversations addressed to the bot before an agent session exists. */
  engagedThreads: Record<string, true>;
  runtimePrefs: Record<string, Runtime>;
  /** Workspace + user + provider defaults; providers remain independent. */
  modelPrefs: Record<string, string>;
  modelMenus: Record<string, { options: ModelOption[]; expiresAt: number }>;
  /** Numbered `[sessions]` listings awaiting a number reply (thread + user). */
  sessionMenus: Record<string, { sessionIds: string[]; expiresAt: number }>;
  seenEvents: string[];
  /** Operator threads a linked user started with `[operator]` (thread key → ProPanes user id). */
  delegatedThreads?: Record<string, string>;
  /** When this user was sent their setup guide (linked users' state only). */
  welcomedAt?: string;
}

export function emptyState(): BotState {
  return { version: 1, threads: {}, engagedThreads: {}, runtimePrefs: {}, modelPrefs: {}, modelMenus: {}, sessionMenus: {}, seenEvents: [] };
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
    this.state = { ...emptyState(), ...store.load() };
  }

  snapshot(): BotState { return this.state; }

  isEngagedThread(key: string): boolean { return this.state.engagedThreads[key] === true; }
  engageThread(key: string): void {
    if (this.state.threads[key] || this.isEngagedThread(key)) return;
    this.state.engagedThreads[key] = true;
    this.store.save(this.state);
  }

  getThread(key: string): ThreadRecord | undefined { return this.state.threads[key]; }
  putThread(record: ThreadRecord): void {
    record.updatedAt = new Date().toISOString();
    if (record.delivery.delivered.length > DELIVERED_CAP) {
      record.delivery.delivered = record.delivery.delivered.slice(-DELIVERED_CAP);
    }
    this.state.threads[record.key] = record;
    delete this.state.engagedThreads[record.key];
    this.store.save(this.state);
  }
  threads(): ThreadRecord[] { return Object.values(this.state.threads); }

  delegateOf(key: string): string | undefined { return this.state.delegatedThreads?.[key]; }
  delegate(key: string, userId: string): void {
    (this.state.delegatedThreads ??= {})[key] = userId;
    this.store.save(this.state);
  }

  welcomedAt(): string | undefined { return this.state.welcomedAt; }
  markWelcomed(at: string): void {
    this.state.welcomedAt = at;
    this.store.save(this.state);
  }

  getRuntimePref(teamId: string, userId: string): Runtime | undefined {
    return this.state.runtimePrefs[`${teamId}:${userId}`];
  }
  setRuntimePref(teamId: string, userId: string, runtime: Runtime): void {
    this.state.runtimePrefs[`${teamId}:${userId}`] = runtime;
    this.store.save(this.state);
  }

  getModelPref(teamId: string, userId: string | undefined, provider: string): string | undefined {
    return userId ? this.state.modelPrefs[JSON.stringify([teamId, userId, provider])] : undefined;
  }
  setModelPref(teamId: string, userId: string, provider: string, model: string): void {
    this.state.modelPrefs[JSON.stringify([teamId, userId, provider])] = model;
    this.store.save(this.state);
  }
  private menuKey(thread: string, userId: string): string { return JSON.stringify([thread, userId]); }
  getModelMenu(thread: string, userId: string) { return this.state.modelMenus[this.menuKey(thread, userId)]; }
  setModelMenu(thread: string, userId: string, options: ModelOption[], expiresAt: number): void {
    this.state.modelMenus[this.menuKey(thread, userId)] = { options, expiresAt };
    this.store.save(this.state);
  }
  clearModelMenu(thread: string, userId: string): void {
    delete this.state.modelMenus[this.menuKey(thread, userId)];
    this.store.save(this.state);
  }

  getSessionMenu(thread: string, userId: string) { return this.state.sessionMenus[this.menuKey(thread, userId)]; }
  setSessionMenu(thread: string, userId: string, sessionIds: string[], expiresAt: number): void {
    this.state.sessionMenus[this.menuKey(thread, userId)] = { sessionIds, expiresAt };
    this.store.save(this.state);
  }
  clearSessionMenu(thread: string, userId: string): void {
    if (!this.state.sessionMenus[this.menuKey(thread, userId)]) return;
    delete this.state.sessionMenus[this.menuKey(thread, userId)];
    this.store.save(this.state);
  }
  /** The newest thread record, for messages that have no Slack conversation of their own. */
  latestThread(): ThreadRecord | undefined {
    return this.threads().reduce<ThreadRecord | undefined>((best, t) => (!best || t.updatedAt > best.updatedAt ? t : best), undefined);
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
