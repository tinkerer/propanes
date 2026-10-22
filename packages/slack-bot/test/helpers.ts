/** Mocked Slack + ProPanes for bridge tests: no network, no real sessions. */
import { SlackBridge, type BridgeConfig, type IncomingSlackMessage } from '../src/bridge';
import type { AgentEndpointInfo } from '../src/agents';
import { SlackFileAccessError, type DownloadedFile, type SlackFileDownloader, type SlackFileInfo } from '../src/attachments';
import type { JsonlDelta, PropanesClient, SessionInfo } from '../src/propanes';
import type { SlackPoster, UploadArgs, PostArgs } from '../src/slack';
import { MemoryStateStore, StateRepo, type StateStore } from '../src/state';

export const APP = 'app-1';
export const PUBLIC = 'https://propanes.example.test';

export const agents: AgentEndpointInfo[] = [
  { id: 'a-default', name: 'Claude Code (headless)', runtime: 'claude', permissionProfile: 'interactive-require', mode: 'headless', isDefault: true, appId: APP },
  { id: 'a-yolo', name: 'yolo', runtime: 'claude', permissionProfile: 'interactive-yolo', mode: 'interactive' },
  { id: 'c-yolo', name: 'codex-yolo', runtime: 'codex', permissionProfile: 'interactive-yolo', mode: 'interactive' },
];

export interface FakeSession extends SessionInfo { lines: string[]; }

let uuidCounter = 0;
const uuid = () => `u-${++uuidCounter}`;
/** Re-stamp a fixture line (keys above default to 2026-10-22T00:00:00Z). */
export const stamped = (jsonLine: string, iso: string) => jsonLine.replace('"timestamp":"2026-10-22T00:00:00Z"', `"timestamp":"${iso}"`);
export const line = {
  assistant: (text: string) => JSON.stringify({ type: 'assistant', uuid: uuid(), timestamp: '2026-10-22T00:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
  toolUse: (name: string, input: Record<string, unknown>, id: string) => JSON.stringify({ type: 'assistant', uuid: uuid(), timestamp: '2026-10-22T00:00:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }),
  toolResult: (toolUseId: string, content: unknown) => JSON.stringify({ type: 'user', uuid: uuid(), timestamp: '2026-10-22T00:00:00Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } }),
  user: (text: string) => JSON.stringify({ type: 'user', uuid: uuid(), timestamp: '2026-10-22T00:00:00Z', message: { role: 'user', content: text } }),
};

export class World {
  sessions = new Map<string, FakeSession>();
  calls: string[] = [];
  images = new Map<string, { bytes: Buffer; mime: string }>();
  agents = agents.slice();
  private n = 0;

  newSession(feedbackId: string, runtime: string, parent?: string): FakeSession {
    const id = `S${++this.n}`;
    const s: FakeSession = { id, status: 'running', inputState: 'active', feedbackId, runtime, permissionProfile: 'interactive-yolo', lines: [] };
    this.sessions.set(id, s);
    if (parent) this.calls.push(`child:${parent}->${id}`);
    return s;
  }
  session(id: string): FakeSession { return this.sessions.get(id)!; }
  latest(): FakeSession { return this.sessions.get(`S${this.n}`)!; }

  /** Slack file id → bytes, or an error to throw. */
  slackFiles = new Map<string, DownloadedFile | Error>();
  downloader: SlackFileDownloader = {
    download: async (file: SlackFileInfo) => {
      const hit = this.slackFiles.get(file.id);
      if (!hit) throw new SlackFileAccessError('not_found', 'file not found');
      if (hit instanceof Error) throw hit;
      this.calls.push(`download:${file.id}`);
      return hit;
    },
  };

  propanes: PropanesClient = {
    me: async () => ({ user: { id: 'env-admin', username: 'admin', role: 'admin' } }),
    listAgents: async () => this.agents,
    createFeedback: async (input) => {
      this.calls.push(`feedback:${input.title}${input.screenshots?.length ? `:screenshots=${input.screenshots.map((s) => s.name).join(',')}` : ''}`);
      return { id: `F${this.n + 1}` };
    },
    uploadScreenshots: async (sessionId, images) => {
      this.calls.push(`upload-screenshots:${sessionId ?? 'none'}:${images.map((i) => i.name).join(',')}`);
      return { screenshots: images.map((i, n) => ({ id: `SC${n + 1}`, filename: i.name, path: `/tmp/sc-${i.name}` })) };
    },
    uploadFiles: async (sessionId, files) => {
      this.calls.push(`upload-files:${sessionId ?? 'none'}:${files.map((i) => i.name).join(',')}`);
      return { files: files.map((i, n) => ({ id: `UP${n + 1}`, filename: `up-${i.name}`, originalName: i.name, path: `/tmp/up-${i.name}` })) };
    },
    dispatch: async (input) => {
      const agent = this.agents.find((a) => a.id === input.agentEndpointId)!;
      this.calls.push(`dispatch:${input.agentEndpointId}:${input.permissionProfile}`);
      this.calls.push(`instructions:${input.instructions}`);
      return { sessionId: this.newSession(input.feedbackId, agent.runtime || 'claude').id };
    },
    getSession: async (id) => {
      const s = this.sessions.get(id);
      if (!s) throw new Error('not found');
      const { lines: _l, ...row } = s;
      return row;
    },
    listSessions: async (feedbackId) => [...this.sessions.values()].filter((s) => s.feedbackId === feedbackId).map(({ lines: _l, ...row }) => row),
    sendKeys: async (id, keys) => {
      this.calls.push(`send-keys:${id}:${keys}`);
      const s = this.sessions.get(id);
      return s && (s.status === 'running' || s.status === 'pending') ? { ok: true } : { ok: false, error: 'Session not running' };
    },
    resume: async (id, input) => {
      const parent = this.sessions.get(id)!;
      if (parent.status === 'running') throw new Error('Session is still active');
      this.calls.push(`resume:${id}:${input.runtime ?? 'inherit'}:${input.additionalPrompt}`);
      this.calls.push(`resume-profile:${id}:${input.permissionProfile ?? 'inherit'}`);
      return { sessionId: this.newSession(parent.feedbackId!, input.runtime ?? parent.runtime!, id).id };
    },
    kill: async (id) => { this.calls.push(`kill:${id}`); this.sessions.get(id)!.status = 'killed'; },
    jsonlDelta: async (id, cursor, _tail): Promise<JsonlDelta> => {
      const s = this.sessions.get(id)!;
      const from = cursor === 'init' ? 0 : parseInt(cursor.slice(2), 10);
      if (!s.lines.length) return { cursor, reset: false, order: [], files: [], pending: true };
      const chunk = s.lines.slice(from);
      return { cursor: `c:${s.lines.length}`, reset: cursor === 'init', order: ['main.jsonl'], files: chunk.length ? [{ key: 'main.jsonl', lines: chunk.join('\n') }] : [] };
    },
    fetchImage: async (path) => {
      const img = this.images.get(path);
      if (!img) throw new Error(`Propanes ${path} → 404`);
      this.calls.push(`fetch-image:${path}`);
      return img;
    },
  };
}

export class FakeSlack implements SlackPoster {
  posts: PostArgs[] = [];
  reactions: { channel: string; timestamp: string; name: string }[] = [];
  uploads: UploadArgs[] = [];
  order: string[] = [];
  uploadError: unknown = null;
  async postMessage(args: PostArgs) { this.posts.push(args); this.order.push(`post:${args.text.slice(0, 30)}`); return { ok: true }; }
  async addReaction(args: { channel: string; timestamp: string; name: string }) { this.reactions.push(args); this.order.push(`react:${args.name}`); return { ok: true }; }
  async uploadFile(args: UploadArgs) { if (this.uploadError) throw this.uploadError; this.uploads.push(args); this.order.push(`upload:${args.filename}`); return { ok: true }; }
  texts(): string[] { return this.posts.map((p) => p.text); }
}

export interface Fixture { world: World; slack: FakeSlack; store: StateStore; bridge: SlackBridge; steps: Array<() => void>; clock: { now: number }; }

export function fixture(opts: { store?: StateStore; config?: Partial<BridgeConfig>; noDownloader?: boolean } = {}): Fixture {
  const world = new World();
  const slack = new FakeSlack();
  const store = opts.store ?? new MemoryStateStore();
  const steps: Array<() => void> = [];
  const clock = { now: 1_000_000 };
  const bridge = new SlackBridge({
    propanes: world.propanes,
    slack,
    files: opts.noDownloader ? undefined : world.downloader,
    state: new StateRepo(store),
    config: { appId: APP, publicUrl: PUBLIC, botUserId: 'UBOT', pollMs: 1, idlePollMs: 1, idleStopMs: 60_000, transcriptTail: 2000, ...opts.config },
    log: () => undefined,
    // Each watcher sleep runs the next scripted world change; a script that
    // never ends the session would spin, so the default step kills it.
    sleep: async () => {
      await new Promise<void>((r) => setImmediate(r));
      const step = steps.shift();
      if (step) step();
      else for (const s of world.sessions.values()) if (s.status === 'running') s.status = 'completed';
    },
    now: () => clock.now,
  });
  return { world, slack, store, bridge, steps, clock };
}

export function mention(text: string, over: Partial<IncomingSlackMessage> = {}): IncomingSlackMessage {
  return { eventId: `Ev${Math.random()}`, teamId: 'T1', channel: 'C1', channelType: 'channel', user: 'U1', ts: '100.000', text: `<@UBOT> ${text}`, mentionsBot: true, ...over };
}

export function threadReply(text: string, over: Partial<IncomingSlackMessage> = {}): IncomingSlackMessage {
  return { eventId: `Ev${Math.random()}`, teamId: 'T1', channel: 'C1', channelType: 'channel', user: 'U1', ts: `${200 + Math.random()}`, threadTs: '100.000', text, mentionsBot: false, ...over };
}

export const sessionUrl = (id: string) => `${PUBLIC}/admin/#/session/${id}`;
