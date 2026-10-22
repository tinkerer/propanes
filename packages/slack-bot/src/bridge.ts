/** Slack thread ⇄ ProPanes session bridge.
 *
 * A thread drives one conversation. New requests dispatch a session through the
 * admin dispatch API; replies in the thread use the structured view's own
 * operations — send-keys while the session is live, an explicit resume once it
 * has stopped — and never a blanket kill-and-resume. Output is read from the
 * structured transcript poll, rendered per the thread's mode, and delivered
 * by a per-thread watcher that checkpoints its cursor after every post. */
import { AgentUnavailableError, configuredDefaultRuntime, endpointRuntime, resolveAgentEndpoint, runtimeLabel, type AgentEndpointInfo } from './agents';
import { extractFinalCosReply } from './cos-reply';
import { coalesce, escapeMrkdwn, renderEvent, summarizeToolInput, toMrkdwn } from './format';
import { extractImageRefs, filenameFor, IMAGE_MAX_BYTES, IMAGE_MIMES, type ImageRef } from './images';
import { isStopKeyword, parseCommand, type OutputMode, type ParsedCommand, type Runtime } from './options';
import { isLive, PropanesApiError, TERMINAL_STATUSES, type JsonlDelta, type PropanesClient, type SessionInfo } from './propanes';
import { slackErrorCode, type SlackPoster } from './slack';
import { freshCheckpoint, threadKey, type StateRepo, type ThreadRecord } from './state';
import { TranscriptFollower } from './transcript';

/** The subset of Slack's file object the bridge looks at. */
export interface SlackFileInfo {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}

export interface IncomingSlackMessage {
  /** Slack's event_id when available; retries re-deliver the same id. */
  eventId?: string;
  teamId: string;
  channel: string;
  channelType: 'channel' | 'group' | 'im' | 'mpim';
  user?: string;
  botId?: string;
  subtype?: string;
  ts: string;
  threadTs?: string;
  text: string;
  mentionsBot: boolean;
  /** Attachments on the message (Slack delivers these with subtype `file_share`). */
  files?: SlackFileInfo[];
}

/** Message subtypes that still carry a human request. Everything else (edits,
 * deletions, joins, bot posts…) is noise. */
const HUMAN_SUBTYPES = new Set(['file_share', 'thread_broadcast']);

export interface BridgeConfig {
  appId: string;
  publicUrl: string;
  botUserId?: string;
  agentEndpointOverride?: string;
  /** Poll interval while a turn is in progress. */
  pollMs: number;
  /** Poll interval once the session is idle (admin-side activity still reaches Slack). */
  idlePollMs: number;
  /** Stop watching an idle session after this long; the next Slack reply re-arms it. */
  idleStopMs: number;
  /** Transcript lines requested on the first poll (also enables image elision). */
  transcriptTail: number;
}

export interface BridgeDeps {
  propanes: PropanesClient;
  slack: SlackPoster;
  state: StateRepo;
  config: BridgeConfig;
  log: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const PERMISSION_PROFILE = 'interactive-yolo';
const MAX_CONSECUTIVE_POLL_FAILURES = 30;
/** Idle polls before a turn is considered finished (inputState flaps per keystroke). */
const IDLE_POLLS_TO_FINISH = 2;
/** A turn with no assistant text at all still finishes after this many idle polls. */
const IDLE_POLLS_NO_TEXT = 15;

export function slackInstructions(mode: OutputMode): string {
  const lines = [
    '[SLACK THREAD]',
    'This request came from a Slack thread. The operator reads your replies there and cannot see your terminal.',
    'Begin with one short line restating what you will do.',
  ];
  if (mode === 'quiet') {
    lines.push('Only the content of the LAST complete <cos-reply>…</cos-reply> block you write is shown to the operator, once you finish. Write it exactly once, at the very end, as a concise self-contained answer. Do not wrap acknowledgements or progress notes in those tags.');
  } else {
    lines.push('Every plain-text message you write is forwarded to the thread (tool calls and tool output are not), so narrate progress briefly.');
    lines.push('Put your final user-facing answer inside <cos-reply>…</cos-reply>; keep it concise and self-contained.');
  }
  lines.push('[/SLACK THREAD]');
  return lines.join('\n');
}

export function safeMessage(err: unknown): string {
  if (err instanceof PropanesApiError || err instanceof AgentUnavailableError) return err.message;
  if (err instanceof Error) {
    return (err.message || err.name).replace(/\b(xox[a-z]-|Bearer\s+)\S+/gi, '[redacted]').slice(0, 200);
  }
  return 'unexpected error';
}

export class SlackBridge {
  private locks = new Map<string, Promise<unknown>>();
  private watchers = new Map<string, Promise<void>>();
  private followers = new Map<string, { sessionId: string; follower: TranscriptFollower }>();
  private stopped = false;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly d: BridgeDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = d.now ?? (() => Date.now());
  }

  sessionUrl(sessionId: string): string {
    return `${this.d.config.publicUrl.replace(/\/$/, '')}/admin/#/session/${sessionId}`;
  }
  link(sessionId: string): string {
    return `<${this.sessionUrl(sessionId)}|\`${sessionId}\`>`;
  }

  /** Wait for every running watcher (tests / shutdown). */
  async drain(): Promise<void> {
    while (this.watchers.size || this.locks.size) {
      await Promise.allSettled([...this.watchers.values(), ...this.locks.values()]);
    }
  }

  // ---------------------------------------------------------------- inbound

  async handleEvent(ev: IncomingSlackMessage): Promise<void> {
    if (ev.botId || (ev.subtype && !HUMAN_SUBTYPES.has(ev.subtype))) return; // bot echoes, edits, deletions, joins…
    if (!this.d.state.markEvent(ev.eventId ?? `${ev.channel}:${ev.ts}`)) return; // retry / duplicate delivery
    const isDm = ev.channelType === 'im';
    const threadTs = ev.threadTs ?? (isDm ? null : ev.ts);
    const key = threadKey(ev.teamId, ev.channel, threadTs);
    // Everything for one thread runs under its lock, so a reply that lands
    // while the thread's first session is still being created is queued
    // behind it instead of being mistaken for unrelated chatter.
    await this.withLock(key, async () => {
      const record = this.d.state.getThread(key);
      if (!isDm && !ev.mentionsBot && !record) return; // ordinary chatter in an unrelated thread

      const cmd = parseCommand(ev.text, this.d.config.botUserId);
      const hasOptions = cmd.runtime !== undefined || cmd.mode !== undefined || cmd.images !== undefined;
      const attachments = ev.files?.length ?? 0;
      const reply = (text: string) => this.d.slack.postMessage({ channel: ev.channel, thread_ts: threadTs ?? undefined, text });
      if (!cmd.error && cmd.command === 'prompt' && !cmd.text && !hasOptions) {
        // An attachment-only message must not vanish silently.
        if (attachments) await reply(attachmentsNotForwardedNote(attachments));
        return;
      }

      if (cmd.error) {
        await reply(`⚠️ ${cmd.error}`);
        return;
      }
      await this.react(ev);
      if (cmd.command === 'help') { await reply(helpText()); return; }
      if (cmd.command === 'status') { await reply(await this.statusText(record)); return; }
      await this.handlePrompt(ev, key, threadTs, cmd, reply);
      if (attachments) await reply(attachmentsNotForwardedNote(attachments));
    });
  }

  /** The bot's own user id, learned from auth.test after construction. */
  setBotUserId(id: string | undefined): void {
    this.d.config.botUserId = id;
  }

  /** Stop re-arming watchers (shutdown); state already on disk re-arms on the next start. */
  stop(): void {
    this.stopped = true;
  }

  private withLock<T>(key: string, op: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(op);
    this.locks.set(key, next);
    next.finally(() => { if (this.locks.get(key) === next) this.locks.delete(key); }).catch(() => undefined);
    return next;
  }

  private async react(ev: IncomingSlackMessage): Promise<void> {
    try {
      await this.d.slack.addReaction({ channel: ev.channel, timestamp: ev.ts, name: 'eyes' });
    } catch (error) {
      const code = slackErrorCode(error);
      if (code !== 'already_reacted') this.d.log(`Could not add eyes reaction (${code}); continuing with threaded reply.`);
    }
  }

  private async handlePrompt(ev: IncomingSlackMessage, key: string, threadTs: string | null, cmd: ParsedCommand, reply: (t: string) => Promise<unknown>): Promise<void> {
    const record = this.d.state.getThread(key);
    const hasOptions = cmd.runtime !== undefined || cmd.mode !== undefined || cmd.images !== undefined;
    try {
      if (isStopKeyword(cmd.text) && !hasOptions) return await this.stopSession(record, reply);
      if (!record) return await this.startSession(ev, key, threadTs, cmd, reply);
      return await this.continueThread(ev, record, cmd, reply);
    } catch (err) {
      this.d.log(`Request handling failed: ${err instanceof Error ? err.name : 'error'}`);
      await reply(`⚠️ Something went wrong: ${escapeMrkdwn(safeMessage(err))}`);
    }
  }

  // ---------------------------------------------------------------- commands

  private async startSession(ev: IncomingSlackMessage, key: string, threadTs: string | null, cmd: ParsedCommand, reply: (t: string) => Promise<unknown>): Promise<void> {
    if (!cmd.text) {
      await reply('Tell me what to do, e.g. `@amirobot review PR 2013`. Send `[help]` for options.');
      return;
    }
    const { appId } = this.d.config;
    const agents = await this.d.propanes.listAgents(appId);
    const remembered = ev.user ? this.d.state.getRuntimePref(ev.teamId, ev.user) : undefined;
    const runtime: Runtime = cmd.runtime ?? remembered ?? configuredDefaultRuntime(agents, appId);
    let endpoint: AgentEndpointInfo;
    try {
      endpoint = resolveAgentEndpoint(agents, runtime, appId, this.d.config.agentEndpointOverride);
    } catch (err) {
      if (err instanceof AgentUnavailableError) {
        await reply(`⚠️ ${escapeMrkdwn(err.message)}. Not substituting another agent — pick one that is configured or ask an admin to add it.`);
        return;
      }
      throw err;
    }
    const mode: OutputMode = cmd.mode ?? 'default';
    const images = !!cmd.images;
    const feedback = await this.d.propanes.createFeedback({
      title: `Slack: ${cmd.text.slice(0, 80)}`,
      description: cmd.text,
      appId,
      tags: ['slack', 'amirobot'],
    });
    const { sessionId } = await this.d.propanes.dispatch({
      feedbackId: feedback.id,
      agentEndpointId: endpoint.id,
      instructions: slackInstructions(mode),
      permissionProfile: PERMISSION_PROFILE,
    });
    const nowIso = new Date(this.now()).toISOString();
    const record: ThreadRecord = {
      key, teamId: ev.teamId, channel: ev.channel, threadTs,
      sessionId, feedbackId: feedback.id, runtime, agentEndpointId: endpoint.id, agentName: endpoint.name || endpoint.id,
      mode, images,
      history: [{ sessionId, runtime, agentName: endpoint.name || endpoint.id, createdAt: nowIso }],
      delivery: freshCheckpoint(this.now()), watching: true, createdAt: nowIso, updatedAt: nowIso,
    };
    this.d.state.putThread(record);
    if (ev.user) this.d.state.setRuntimePref(ev.teamId, ev.user, runtime);
    await reply(this.initialReply(record));
    this.watch(key);
  }

  private initialReply(record: ThreadRecord): string {
    const lines = [
      `🚀 Session started: ${this.link(record.sessionId)}`,
      `*agent* ${runtimeLabel(record.runtime)} (${escapeMrkdwn(record.agentName)}) · *output* ${record.mode} · *images* ${record.images ? 'on' : 'off'}`,
    ];
    if (record.mode === 'quiet') lines.push('_Quiet mode: I will post only the final answer here when the session finishes._');
    lines.push('Reply in this thread to continue the conversation · `stop` cancels · `[status]` · `[help]`');
    return lines.join('\n');
  }

  private async continueThread(ev: IncomingSlackMessage, record: ThreadRecord, cmd: ParsedCommand, reply: (t: string) => Promise<unknown>): Promise<void> {
    let changed = false;
    if (cmd.mode && cmd.mode !== record.mode) { record.mode = cmd.mode; changed = true; }
    if (cmd.images !== undefined && cmd.images !== record.images) { record.images = cmd.images; changed = true; }
    if (changed) this.d.state.putThread(record);
    const switching = cmd.runtime !== undefined && cmd.runtime !== record.runtime;

    if (!cmd.text) {
      if (changed || switching) {
        const note = `Updated this thread: *output* ${record.mode} · *images* ${record.images ? 'on' : 'off'}.`;
        await reply(switching ? `${note} Add a message to continue with ${runtimeLabel(cmd.runtime)}.` : note);
      } else {
        await reply('Nothing to send. Reply with a message to continue, `stop` to cancel, `[status]` or `[help]`.');
      }
      return;
    }
    if (switching) return this.switchRuntime(ev, record, cmd.runtime!, cmd.text, reply);

    let session = await this.currentSession(record);
    if (isLive(session.status)) {
      // Same operation as the structured view's input bar: keys straight to the live process.
      const result = await this.d.propanes.sendKeys(record.sessionId, promptForSendKeys(cmd.text, record.mode));
      if (result.ok) {
        this.openTurn(record);
        this.d.state.putThread(record);
        this.watch(record.key);
        return;
      }
      // A send that failed because the process just exited falls through to an
      // explicit resume; any other failure is reported, never silently restarted.
      session = await this.currentSession(record);
      if (isLive(session.status)) {
        await reply(`⚠️ Could not deliver your message to ${this.link(record.sessionId)}: ${escapeMrkdwn(result.error || 'send-keys failed')}`);
        return;
      }
    }
    await this.resumeInto(record, cmd.text, undefined, reply, `Session ${this.link(record.sessionId)} had ${session.status === 'completed' ? 'finished' : `ended (${session.status})`}`);
  }

  /** Explicit runtime change inside a thread: the thread keeps its history and
   * the previous session's link; the new runtime starts as a continuation
   * (child session) of the current one, carrying the thread's task context. */
  private async switchRuntime(ev: IncomingSlackMessage, record: ThreadRecord, runtime: Runtime, text: string, reply: (t: string) => Promise<unknown>): Promise<void> {
    const agents = await this.d.propanes.listAgents(this.d.config.appId);
    try {
      resolveAgentEndpoint(agents, runtime, this.d.config.appId);
    } catch (err) {
      if (err instanceof AgentUnavailableError) {
        await reply(`⚠️ ${escapeMrkdwn(err.message)}. Staying on ${runtimeLabel(record.runtime)}; your message was not sent.`);
        return;
      }
      throw err;
    }
    const session = await this.currentSession(record);
    let reason = `Switching this thread from ${runtimeLabel(record.runtime)} to ${runtimeLabel(runtime)}`;
    if (isLive(session.status)) {
      // Mirrors the admin's "Resume as…": an explicit profile/runtime change stops the live run first.
      await this.d.propanes.kill(record.sessionId).catch(() => undefined);
      await this.awaitStopped(record.sessionId);
      reason += ` (stopped the running ${runtimeLabel(record.runtime)} session)`;
    }
    const ok = await this.resumeInto(record, text, runtime, reply, reason);
    if (ok && ev.user) this.d.state.setRuntimePref(ev.teamId, ev.user, runtime);
  }

  private async resumeInto(record: ThreadRecord, text: string, runtime: Runtime | undefined, reply: (t: string) => Promise<unknown>, reason: string): Promise<boolean> {
    const parentId = record.sessionId;
    try {
      const { sessionId } = await this.d.propanes.resume(parentId, {
        additionalPrompt: promptForResume(text, record.mode),
        ...(runtime ? { runtime } : {}),
      });
      const nextRuntime = runtime ?? record.runtime;
      const agentName = runtime && runtime !== record.runtime ? `${record.agentName} → ${runtime}` : record.agentName;
      record.sessionId = sessionId;
      record.runtime = nextRuntime;
      record.agentName = agentName;
      record.history.push({ sessionId, runtime: nextRuntime, agentName, createdAt: new Date(this.now()).toISOString() });
      record.delivery = freshCheckpoint(this.now());
      record.watching = true;
      this.followers.delete(record.key);
      this.d.state.putThread(record);
      await reply(`${reason} — continuing in ${this.link(sessionId)} (${runtimeLabel(nextRuntime)}, ${record.mode}). Previous session: ${this.link(parentId)}.`);
      this.watch(record.key);
      return true;
    } catch (err) {
      await reply(`⚠️ Could not resume ${this.link(parentId)}: ${escapeMrkdwn(safeMessage(err))}`);
      return false;
    }
  }

  private async stopSession(record: ThreadRecord | undefined, reply: (t: string) => Promise<unknown>): Promise<void> {
    if (!record) {
      await reply('Nothing is running in this thread.');
      return;
    }
    const session = await this.currentSession(record);
    if (!isLive(session.status)) {
      await reply(`Session ${this.link(record.sessionId)} is not running (${session.status}).`);
      return;
    }
    await this.d.propanes.kill(record.sessionId);
    record.delivery.turnOpen = false;
    record.delivery.turnTexts = [];
    this.d.state.putThread(record);
    await reply(`🛑 Stopped session ${this.link(record.sessionId)}. Reply here to resume it with a new message.`);
  }

  async statusText(record: ThreadRecord | undefined): Promise<string> {
    if (!record) return 'No session is associated with this thread. Mention me with a request to start one.';
    let session: SessionInfo | null = null;
    try { session = await this.currentSession(record); } catch { /* reported below */ }
    const state = !session ? 'unknown (ProPanes unreachable)'
      : TERMINAL_STATUSES.has(session.status) ? session.status
      : session.inputState === 'waiting' ? 'running — waiting for your input'
      : session.inputState === 'idle' ? 'running — idle (turn finished)'
      : `${session.status} — working`;
    const lines = [
      `*session* ${this.link(record.sessionId)} · *agent* ${runtimeLabel(record.runtime)} (${escapeMrkdwn(record.agentName)})`,
      `*output* ${record.mode} · *images* ${record.images ? 'on' : 'off'} · *state* ${escapeMrkdwn(state)}`,
    ];
    if (record.history.length > 1) {
      lines.push(`*history* ${record.history.slice(0, -1).map((h) => `${this.link(h.sessionId)} (${runtimeLabel(h.runtime)})`).join(' → ')}`);
    }
    return lines.join('\n');
  }

  private async currentSession(record: ThreadRecord): Promise<SessionInfo> {
    let rows: SessionInfo[] = [];
    try { rows = await this.d.propanes.listSessions(record.feedbackId); } catch { /* fall back to the single row */ }
    return rows.find((r) => r.id === record.sessionId) ?? await this.d.propanes.getSession(record.sessionId);
  }

  private async awaitStopped(sessionId: string): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const s = await this.d.propanes.getSession(sessionId).catch(() => null);
      if (!s || !isLive(s.status)) return;
      await this.sleep(500);
    }
  }

  private openTurn(record: ThreadRecord): void {
    record.delivery.turnOpen = true;
    record.delivery.turnTexts = [];
    record.delivery.idlePolls = 0;
    record.delivery.waitingNotified = false;
    record.delivery.lastActivityAt = this.now();
    record.watching = true;
  }

  // ---------------------------------------------------------------- delivery

  /** Re-arm watchers after a listener restart. */
  recover(): number {
    let n = 0;
    for (const record of this.d.state.threads()) {
      if (!record.watching) continue;
      this.watch(record.key);
      n++;
    }
    return n;
  }

  watch(key: string): void {
    if (this.stopped || this.watchers.has(key)) return;
    const run = this.deliverLoop(key)
      .catch((err) => this.d.log(`Watcher for ${key} crashed: ${err instanceof Error ? err.name : 'error'}`))
      .finally(() => {
        this.watchers.delete(key);
        // A resume that landed while the loop was finishing re-arms it.
        const record = this.d.state.getThread(key);
        if (record?.watching) this.watch(key);
      });
    this.watchers.set(key, run);
  }

  private followerFor(record: ThreadRecord): TranscriptFollower {
    const cur = this.followers.get(record.key);
    if (cur && cur.sessionId === record.sessionId) return cur.follower;
    const follower = new TranscriptFollower(record.runtime);
    this.followers.set(record.key, { sessionId: record.sessionId, follower });
    return follower;
  }

  private post(record: ThreadRecord, text: string): Promise<unknown> {
    return this.d.slack.postMessage({ channel: record.channel, thread_ts: record.threadTs ?? undefined, text });
  }

  private async deliverLoop(key: string): Promise<void> {
    let failures = 0;
    for (;;) {
      const record = this.d.state.getThread(key);
      if (this.stopped || !record || !record.watching) return;
      const sessionId = record.sessionId;
      const follower = this.followerFor(record);

      let session: SessionInfo;
      let delta: JsonlDelta;
      try {
        session = await this.currentSession(record);
        delta = await this.d.propanes.jsonlDelta(sessionId, record.delivery.cursor, this.d.config.transcriptTail);
        failures = 0;
      } catch (err) {
        failures++;
        this.d.log(`Poll failed for ${sessionId} (${err instanceof Error ? err.name : 'error'}), attempt ${failures}`);
        if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          await this.post(record, `⚠️ Lost contact with ProPanes while following ${this.link(sessionId)}; stopped watching. Reply here to re-attach.`);
          record.watching = false;
          this.d.state.putThread(record);
          return;
        }
        await this.sleep(this.d.config.pollMs);
        continue;
      }
      // The thread moved to a continuation while we were polling; start over on it.
      if (record.sessionId !== sessionId) continue;

      const events = follower.ingest(delta).filter((e) => !record.delivery.delivered.includes(e.key));
      if (events.length) {
        await this.deliverEvents(record, follower, events);
        record.delivery.lastActivityAt = this.now();
        record.delivery.delivered.push(...events.map((e) => e.key));
      }
      if (!delta.pending) record.delivery.cursor = delta.cursor;

      const status = session.status;
      const input = session.inputState ?? null;
      const terminal = TERMINAL_STATUSES.has(status);

      if (input === 'waiting' && status === 'running') {
        if (!record.delivery.waitingNotified) {
          record.delivery.waitingNotified = true;
          const pending = follower.lastToolUse ? `: ${escapeMrkdwn(`${follower.lastToolUse.toolName || 'tool'} ${summarizeToolInput(follower.lastToolUse.toolName, follower.lastToolUse.toolInput)}`.trim())}` : '';
          await this.post(record, `⏸️ Session ${this.link(sessionId)} is waiting for your input${pending}. Reply here to answer (e.g. \`y\`, \`1\`), or open the session.`);
        }
      } else {
        record.delivery.waitingNotified = false;
      }

      record.delivery.idlePolls = status === 'running' && input === 'idle' ? record.delivery.idlePolls + 1 : 0;
      const idleEnough = record.delivery.idlePolls >= IDLE_POLLS_TO_FINISH
        && follower.lastMainRole !== 'tool_use'
        && (record.delivery.turnTexts.length > 0 || record.delivery.idlePolls >= IDLE_POLLS_NO_TEXT);
      if (record.delivery.turnOpen && (terminal || idleEnough)) {
        await this.finishTurn(record, session);
      }
      record.delivery.lastStatus = status;
      record.delivery.lastInputState = input;
      if (terminal) {
        if (record.sessionId === sessionId) record.watching = false;
        this.d.state.putThread(record);
        continue; // the top of the loop exits unless a continuation re-armed the thread
      }
      if (!record.delivery.turnOpen && this.now() - record.delivery.lastActivityAt > this.d.config.idleStopMs) {
        record.watching = false;
        this.d.state.putThread(record);
        this.d.log(`Stopped watching idle session ${sessionId}`);
        return;
      }
      this.d.state.putThread(record);
      await this.sleep(record.delivery.turnOpen ? this.d.config.pollMs : this.d.config.idlePollMs);
    }
  }

  private async deliverEvents(record: ThreadRecord, follower: TranscriptFollower, events: { key: string; msg: import('./transcript').ParsedMessage }[]): Promise<void> {
    let pieces: string[] = [];
    const flush = async () => {
      for (const text of coalesce(pieces)) await this.post(record, text);
      pieces = [];
    };
    for (const { msg } of events) {
      if (msg.role === 'assistant' && !msg.subagentId && msg.content.trim()) record.delivery.turnTexts.push(msg.content);
      const rendered = renderEvent(msg, record.mode);
      if (rendered) pieces.push(rendered);
      if (record.images) {
        const refs = extractImageRefs(msg, follower.toolUses);
        if (refs.length) {
          await flush();
          for (const ref of refs) await this.uploadImage(record, ref);
        }
      }
    }
    await flush();
  }

  private async uploadImage(record: ThreadRecord, ref: ImageRef): Promise<void> {
    const label = escapeMrkdwn(ref.label);
    if (record.delivery.uploadedImages.includes(ref.id)) {
      if (record.mode === 'verbose') await this.post(record, `🖼️ _${label} — same image as already posted above_`);
      return;
    }
    let bytes: Buffer;
    let mime: string;
    if (ref.source.kind === 'data') {
      ({ bytes, mime } = ref.source);
    } else {
      try {
        ({ bytes, mime } = await this.d.propanes.fetchImage(ref.source.path));
      } catch (err) {
        await this.post(record, `🖼️ ⚠️ Could not fetch an image the agent viewed (${label}): ${escapeMrkdwn(safeMessage(err))}`);
        return;
      }
    }
    mime = mime.split(';')[0].trim().toLowerCase();
    if (!IMAGE_MIMES.has(mime)) {
      await this.post(record, `🖼️ ⚠️ Skipped ${label}: unsupported image type ${escapeMrkdwn(mime)}.`);
      return;
    }
    if (bytes.length > IMAGE_MAX_BYTES) {
      await this.post(record, `🖼️ ⚠️ Skipped ${label}: ${(bytes.length / 1048576).toFixed(1)} MB exceeds the ${IMAGE_MAX_BYTES / 1048576} MB upload limit.`);
      return;
    }
    try {
      await this.d.slack.uploadFile({
        channel: record.channel,
        thread_ts: record.threadTs ?? undefined,
        filename: filenameFor(ref.label, mime, record.delivery.uploadedImages.length + 1),
        title: ref.label.slice(0, 120),
        bytes,
        comment: `🖼️ ${ref.label.slice(0, 200)}`,
      });
      record.delivery.uploadedImages.push(ref.id);
    } catch (err) {
      const code = slackErrorCode(err);
      if (code === 'missing_scope' || code === 'not_allowed_token_type') {
        if (!record.delivery.scopeWarned) {
          record.delivery.scopeWarned = true;
          await this.post(record, '⚠️ Image upload needs the Slack `files:write` scope. Add it to the app and reinstall it (see packages/slack-bot/README.md); images are skipped until then.');
        }
      } else {
        await this.post(record, `🖼️ ⚠️ Image upload failed (${escapeMrkdwn(code)}) for ${label}.`);
      }
    }
  }

  private async finishTurn(record: ThreadRecord, session: SessionInfo): Promise<void> {
    record.delivery.turnOpen = false;
    const link = this.link(record.sessionId);
    const terminal = TERMINAL_STATUSES.has(session.status);
    if (record.mode === 'quiet') {
      const final = extractFinalCosReply(record.delivery.turnTexts);
      if (final) {
        await this.post(record, `${toMrkdwn(final)}\n\n_Session: ${link}_`);
      } else if (terminal) {
        await this.post(record, `${session.status === 'completed' ? 'ℹ️' : '⚠️'} Session ${link} ${session.status} without a final \`<cos-reply>\` answer. Open the session for details, or reply here to continue.`);
      } else {
        await this.post(record, `ℹ️ Session ${link} finished its turn without a final \`<cos-reply>\` answer. Open the session for details, or reply here to continue.`);
      }
    } else if (terminal) {
      await this.post(record, `${session.status === 'completed' ? '✅' : '⚠️'} Session ${link} ${session.status}.`);
    }
    record.delivery.turnTexts = [];
  }
}

export function attachmentsNotForwardedNote(count: number): string {
  return `📎 ${count} attachment${count === 1 ? '' : 's'} not forwarded: Slack attachments are not passed to the session yet. Your text was delivered; share a link or paste the content for now.`;
}

const QUIET_SUFFIX = ' (Reply via Slack: finish with your answer inside <cos-reply></cos-reply>.)';

/** Keys for a live TTY: the structured view sends single-line input, so a
 * multi-line Slack message is sent as one line to avoid an early submit. */
export function promptForSendKeys(text: string, mode: OutputMode): string {
  const oneLine = text.replace(/\r?\n+/g, ' ⏎ ').trim();
  return mode === 'quiet' ? oneLine + QUIET_SUFFIX : oneLine;
}

export function promptForResume(text: string, mode: OutputMode): string {
  return mode === 'quiet' ? `${text.trim()}\n\n${slackInstructions('quiet')}` : text.trim();
}

export function helpText(): string {
  return [
    '*amirobot — Slack ⇄ ProPanes sessions*',
    'Mention me with a request to start an agent session; every reply in the thread is sent to that session (no mention needed). Leading `[options]` are case-insensitive and may be comma-separated.',
    '',
    '*Commands*',
    '• `@amirobot review PR 2013` — new session with your remembered agent (ProPanes default the first time)',
    '• `@amirobot [claude] …` / `[codex] …` — pick the agent; inside a thread this continues the task on the other agent',
    '• `@amirobot [help]` — this message · `[status]` — the thread\'s session, agent, state and link',
    '• reply `stop` (or `cancel`) — stop the thread\'s running session; a later reply resumes it',
    '',
    '*Output modes* (remembered per thread)',
    '• default — all assistant text (progress and answer); no tool calls or tool output',
    '• `[verbose]` — the full structured view: assistant text, tool calls and tool results, in order',
    '• `[quiet]` — only the session link now and the final `<cos-reply>` answer when the turn finishes',
    '• `[images]` — also upload every image the agent views (combinable, e.g. `[quiet, images]`)',
    '',
    '*Examples*',
    '• `@amirobot [codex, verbose] investigate the failing e2e test`',
    '• `@amirobot [quiet, images] screenshot the dashboard and describe it`',
    '• in a thread: `[verbose]` switches that thread to verbose for later replies',
  ].join('\n');
}
