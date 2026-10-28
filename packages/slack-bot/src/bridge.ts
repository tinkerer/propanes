/** Slack thread ⇄ ProPanes session bridge.
 *
 * A thread drives one conversation. New requests dispatch a session through the
 * admin dispatch API; replies in the thread use the structured view's own
 * operations — send-keys while the session is live, an explicit resume once it
 * has stopped — and never a blanket kill-and-resume. Output is read from the
 * structured transcript poll, rendered per the thread's mode, and delivered
 * by a per-thread watcher that checkpoints its cursor after every post. */
import { AgentUnavailableError, configuredDefaultRuntime, resolveAgentEndpoint, runtimeLabel, type AgentEndpointInfo } from './agents';
import { ambiguousAppText, defaultApp, listAppsText, resolveApp, unknownAppText, type AppInfo } from './apps';
import { attachmentBlock, classifyAttachment, displayName, SlackFileAccessError, type DownloadedFile, type ForwardedAttachment, type SlackFileDownloader, type SlackFileInfo } from './attachments';
import { matchModels, type ModelOption } from './models';
import { createModelCatalog, type ModelCatalogSource } from './model-discovery';
import { extractFinalCosReply, stripCosReplyTags } from './cos-reply';
import { coalesce, chunkText, escapeMrkdwn, feedbackTitle, renderEvent, summarizeToolInput, toMrkdwn } from './format';
import { ambiguousInfraText, canOpenTerminal, listInfraMessages, localAsTarget, LOCAL_LAUNCHER_ID, offlineInfraText, resolveInfra, unknownInfraText, type InfraTarget } from './infra';
import { extractImageRefs, filenameFor, IMAGE_MAX_BYTES, IMAGE_MIMES, type ImageRef } from './images';
import { isStopKeyword, parseCommand, type OutputMode, type ParsedCommand, type Runtime } from './options';
import { isLive, PropanesApiError, TERMINAL_STATUSES, type JsonlDelta, type PropanesClient, type SessionInfo, type SlackHandoffRequest } from './propanes';
import { BOT_NAME } from './name';
import { slackErrorCode, type SlackPoster } from './slack';
import type { InfraTerminalAction } from './infra-actions';
import { listedSessions, sessionListing } from './session-listing';
import { isOutsideInput, rememberSentPrompt, renderOutsideInput } from './outside-input';
import { freshCheckpoint, threadKey, type StateRepo, type ThreadRecord } from './state';

export type { SlackFileInfo } from './attachments';
import { TranscriptFollower } from './transcript';

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

/** False for bot echoes, edits, deletions, joins… — everything but a human request. */
export function isHumanMessage(ev: Pick<IncomingSlackMessage, 'botId' | 'subtype'>): boolean {
  return !ev.botId && !(ev.subtype && !HUMAN_SUBTYPES.has(ev.subtype));
}

/** The conversation a message belongs to: its thread, a new thread rooted at
 * a top-level channel message, or the flat DM. */
export function eventThreadKey(ev: Pick<IncomingSlackMessage, 'teamId' | 'channel' | 'channelType' | 'ts' | 'threadTs'>): string {
  return threadKey(ev.teamId, ev.channel, ev.threadTs ?? (ev.channelType === 'im' ? null : ev.ts));
}

export interface BridgeConfig {
  models?: ModelOption[];
  /** Legacy default application id (fallback when `defaultApp` does not resolve). */
  appId: string;
  /** Default application by name or id (`PROPANES_DEFAULT_APP`); `[app:<name>]` overrides per thread. */
  defaultApp?: string;
  publicUrl: string;
  botUserId?: string;
  agentEndpointOverride?: string;
  /** Poll interval while a turn is in progress. */
  pollMs: number;
  /** Poll interval once the session is idle (admin-side activity still reaches Slack). */
  idlePollMs: number;
  /** Stop the session (and its watcher) after this long without activity; the
   * next Slack reply resumes it with the agent's native resume. */
  idleStopMs: number;
  /** Transcript lines requested on the first poll (also enables image elision). */
  transcriptTail: number;
  /** Slack channel or user id that admin "Continue in Slack" requests open
   * their thread in; unset = the conversation of the most recent thread. */
  handoffChannel?: string;
  /** The Slack workspace (auth.test team_id), for threads opened without an incoming event. */
  teamId?: string;
}

/** Attachments downloaded from Slack for one request. */
export interface StagedAttachments {
  images: DownloadedFile[];
  files: DownloadedFile[];
}

export interface BridgeDeps {
  models?: ModelCatalogSource;
  propanes: PropanesClient;
  slack: SlackPoster;
  /** Reads Slack files with the bot token; absent = attachments are not forwarded. */
  files?: SlackFileDownloader;
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
/** Nothing stamped earlier than this before a dispatch can belong to the new
 * session (its transcript may not exist yet and the server may answer with a
 * neighbour's); the slack covers clock skew with remote launchers. */
const FRESH_SESSION_GRACE_MS = 60_000;
/** A continuation appends to the transcript the thread already followed; only
 * what is written after the resume request is news. */
const RESUME_GRACE_MS = 10_000;
/** A `[sessions]` listing accepts a number reply for this long. */
const SESSION_MENU_TTL_MS = 10 * 60_000;

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

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
  private readonly models: ModelCatalogSource;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly d: BridgeDeps) {
    this.models = d.models ?? createModelCatalog({ extra: d.config.models });
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
    if (!isHumanMessage(ev)) return;
    if (!this.d.state.markEvent(ev.eventId ?? `${ev.channel}:${ev.ts}`)) return; // retry / duplicate delivery
    const isDm = ev.channelType === 'im';
    const threadTs = ev.threadTs ?? (isDm ? null : ev.ts);
    const key = threadKey(ev.teamId, ev.channel, threadTs);
    // Everything for one thread runs under its lock, so a reply that lands
    // while the thread's first session is still being created is queued
    // behind it instead of being mistaken for unrelated chatter.
    await this.withLock(key, async () => {
      const record = this.d.state.getThread(key);
      if (!isDm && !ev.mentionsBot && !record && !this.d.state.isEngagedThread(key)) return; // ordinary chatter in an unrelated thread

      const cmd = parseCommand(ev.text, this.d.config.botUserId);
      const hasOptions = cmd.runtime !== undefined || cmd.mode !== undefined || cmd.images !== undefined || cmd.app !== undefined || cmd.infra !== undefined || cmd.terminal !== undefined || cmd.session !== undefined;
      const attachments = ev.files?.length ?? 0;
      const reply = (text: string) => this.d.slack.postMessage({ channel: ev.channel, thread_ts: threadTs ?? undefined, text });
      if (!cmd.error && cmd.command === 'prompt' && !cmd.text && !hasOptions && !attachments) return;

      // Remember addressed conversations even when we only send help, an
      // option error or a request for a task. Follow-ups need no new mention.
      if (!isDm && ev.mentionsBot) this.d.state.engageThread(key);
      if (cmd.error) {
        await reply(`⚠️ ${cmd.error}`);
        return;
      }
      await this.react(ev);
      if (cmd.command === 'models') {
        if (attachments) { await reply('Use model commands without attachments.'); return; }
        await this.handleModels(ev, key, cmd.modelQuery, reply);
        return;
      }
      if (ev.user) {
        const menu = this.d.state.getModelMenu(key, ev.user);
        if (menu && cmd.command === 'prompt' && !hasOptions && !attachments && /^\d+$/.test(cmd.text)) {
          if (menu.expiresAt <= this.now()) {
            this.d.state.clearModelMenu(key, ev.user);
            await reply('That model menu expired. Send `[models]` for a fresh list.');
          } else {
            const model = menu.options[Number(cmd.text) - 1];
            if (model) await this.selectModel(ev, key, model, reply);
            else await reply(`Choose a number from 1 to ${menu.options.length}, or send \`[models]\` again.`);
          }
          return;
        }
        // A normal reply ends menu selection, preserving numeric agent answers.
        if (menu) this.d.state.clearModelMenu(key, ev.user);
        const sessionMenu = this.d.state.getSessionMenu(key, ev.user);
        if (sessionMenu && cmd.command === 'prompt' && !hasOptions && !attachments && /^\d+$/.test(cmd.text)) {
          if (sessionMenu.expiresAt <= this.now()) {
            this.d.state.clearSessionMenu(key, ev.user);
            await reply('That session list expired. Send `[sessions]` for a fresh list.');
          } else {
            const sessionId = sessionMenu.sessionIds[Number(cmd.text) - 1];
            if (!sessionId) await reply(`Choose a number from 1 to ${sessionMenu.sessionIds.length}, or send \`[sessions]\` again.`);
            else {
              this.d.state.clearSessionMenu(key, ev.user);
              await this.continueInSlack(ev, sessionId, reply);
            }
          }
          return;
        }
        if (sessionMenu) this.d.state.clearSessionMenu(key, ev.user);
      }
      if (cmd.command === 'help') { await reply(helpText(await this.defaultAppName())); return; }
      if (cmd.command === 'status') { await reply(await this.statusText(record)); return; }
      if (cmd.command === 'list-sessions' || cmd.command === 'list-terminals') {
        await this.listActiveSessions(ev, key, cmd, reply);
        return;
      }
      if (cmd.command === 'list-infra') {
        try {
          const messages = listInfraMessages(await this.d.propanes.listDispatchTargets());
          for (const message of messages) await this.d.slack.postMessage({ channel: ev.channel, thread_ts: threadTs ?? undefined, ...message });
        } catch (err) {
          await reply(`⚠️ Could not list infrastructure: ${escapeMrkdwn(safeMessage(err))}`);
        }
        return;
      }
      if (cmd.command === 'list-apps') {
        const apps = await this.d.propanes.listApplications();
        await reply(listAppsText(apps, this.defaultApp(apps).id));
        return;
      }
      if (cmd.terminal && attachments) { await reply('A terminal request cannot include attachments. Use `[terminal]` with optional app/infra selectors.'); return; }
      const staged = attachments ? await this.downloadAttachments(ev, record, reply) : { images: [], files: [] };
      // An attachment-only message is a request to look at the attachment.
      if (!cmd.text && (staged.images.length || staged.files.length)) cmd.text = 'See the attached file(s).';
      if (!cmd.text && !hasOptions) return; // nothing usable arrived (every attachment was rejected)
      await this.handlePrompt(ev, key, threadTs, cmd, reply, staged);
    });
  }

  private defaultModel(teamId: string, userId: string | undefined, runtime: Runtime): string | undefined {
    const provider = this.models.providerForRuntime(runtime);
    return provider ? this.d.state.getModelPref(teamId, userId, provider) : undefined;
  }

  private async handleModels(ev: IncomingSlackMessage, key: string, query: string | undefined, reply: (t: string) => Promise<unknown>): Promise<void> {
    if (!ev.user) { await reply('A Slack user is required to save a model preference.'); return; }
    this.d.state.clearModelMenu(key, ev.user);
    this.d.state.clearSessionMenu(key, ev.user);
    const { models, warnings } = await this.models.list();
    for (const warning of warnings) await reply(`⚠️ ${escapeMrkdwn(warning)}`);
    const matches = query === undefined ? models : matchModels(models, query);
    if (query !== undefined && matches.length === 1) {
      await this.selectModel(ev, key, matches[0], reply);
      return;
    }
    if (!matches.length) {
      if (query === undefined) { await reply('No models could be discovered. Check the provider CLI sign-in and try `[models]` again.'); return; }
      await reply(`No model matches \`${escapeMrkdwn(query ?? '')}\`. Send \`[models]\` for available models.`);
      return;
    }
    this.d.state.setModelMenu(key, ev.user, matches, this.now() + 10 * 60_000);
    const lines = matches.map((m, i) => {
      const selected = this.d.state.getModelPref(ev.teamId, ev.user, m.provider) === m.id ? ' (your default)' : '';
      return `${i + 1}. ${escapeMrkdwn(m.label)} — ${escapeMrkdwn(m.provider)} (\`${escapeMrkdwn(m.id)}\`)${selected}`;
    });
    const menu = [query ? 'Several models match; choose one:' : '*Available models*', ...lines,
      `Reply with a number (e.g. 1 to select ${escapeMrkdwn(matches[0].label)}) within 10 minutes, or use \`[models:opus]\`, \`[models:sonnet]\` or \`[models:astra]\`.`,
      'Choices are saved for you in this workspace, separately for each provider.'].join('\n');
    for (const part of chunkText(menu)) await reply(part);
  }

  private async selectModel(ev: IncomingSlackMessage, key: string, model: ModelOption, reply: (t: string) => Promise<unknown>): Promise<void> {
    this.d.state.setModelPref(ev.teamId, ev.user!, model.provider, model.id);
    this.d.state.setRuntimePref(ev.teamId, ev.user!, model.runtime);
    this.d.state.clearModelMenu(key, ev.user!);
    await reply(`Selected *${escapeMrkdwn(model.label)}* (\`${escapeMrkdwn(model.id)}\`) as your *${escapeMrkdwn(model.provider)}* default. New ${runtimeLabel(model.runtime)} sessions and your next message in a ${runtimeLabel(model.runtime)} thread will use it (resuming the conversation if needed).`);
  }

  /** Slack cannot nest threads. A new bot message in the channel/DM is the
   * root for every additional session; keep creation and early replies locked. */
  private async newThread(ev: Pick<IncomingSlackMessage, 'teamId' | 'channel'>, title: string,
    sourceReply: (text: string) => Promise<unknown>,
    start: (key: string, ts: string, reply: (text: string) => Promise<unknown>) => Promise<void>): Promise<string | undefined> {
    const result = await this.d.slack.postMessage({ channel: ev.channel, text: title }) as { ok?: boolean; ts?: string };
    if (!result?.ts || result.ok === false) throw new Error('Slack did not return a new thread timestamp; no session was started');
    const ts = result.ts;
    const key = threadKey(ev.teamId, ev.channel, ts);
    const reply = (text: string) => this.d.slack.postMessage({ channel: ev.channel, thread_ts: ts, text });
    // The timestamp comes from Slack, so early human replies queue on this key.
    await this.withLock(key, async () => {
      this.d.state.engageThread(key);
      try { await start(key, ts, reply); }
      catch (err) { await reply(`⚠️ ${escapeMrkdwn(safeMessage(err))}`); }
    });
    try {
      const link = await this.d.slack.permalink(ev.channel, ts);
      await sourceReply(`New thread: <${link}|${title}>`);
      return link;
    } catch {
      await sourceReply(`Opened a new thread in this conversation: ${title}.`);
      return undefined;
    }
  }

  private async branchSession(ev: IncomingSlackMessage, record: ThreadRecord | undefined, cmd: ParsedCommand,
    reply: (text: string) => Promise<unknown>, staged: StagedAttachments): Promise<unknown> {
    if (!record || record.kind === 'terminal') {
      if (!cmd.text) { await reply('Add a task after `[session]` to start a new conversation.'); return; }
      return this.newThread(ev, `Session: ${escapeMrkdwn(cmd.text.slice(0, 120))}`, reply,
        (key, ts, post) => this.startSession(ev, key, ts, { ...cmd, session: undefined }, post, staged));
    }
    if ((cmd.runtime && cmd.runtime !== record.runtime) || cmd.app !== undefined || cmd.infra !== undefined) {
      await reply('A native fork inherits its agent, app and machine. Use `[session]` with an optional task/output mode.');
      return;
    }
    const mode = cmd.mode ?? record.mode;
    return this.newThread(ev, `Session branch: ${escapeMrkdwn(cmd.text.slice(0, 100) || record.sessionId)}`, reply,
      async (key, ts, post) => {
        const files = await this.stageForSession(undefined, staged, post);
        const task = [cmd.text, files.length ? attachmentBlock(files, false) : ''].filter(Boolean).join('\n\n');
        const prompt = task ? `${task}\n\n${slackInstructions(mode)}` : '';
        const forkStartedAt = this.now();
        const { sessionId } = await this.d.propanes.fork(record.sessionId, { additionalPrompt: prompt });
        const now = this.now();
        const nowIso = new Date(now).toISOString();
        const branch: ThreadRecord = {
          ...record, key, threadTs: ts, sessionId, mode, images: cmd.images ?? record.images,
          history: [{ sessionId, runtime: record.runtime, agentName: record.agentName, createdAt: nowIso }],
          paused: undefined, delivery: freshCheckpoint(now, forkStartedAt),
          watching: true, createdAt: nowIso, updatedAt: nowIso,
        };
        branch.delivery.turnOpen = !!prompt;
        branch.delivery.sentPrompts = prompt ? rememberSentPrompt(undefined, prompt) : [];
        this.d.state.putThread(branch);
        await post(`Branched from ${this.link(record.sessionId)}.\n${this.initialReply(branch, files.length)}`);
        this.watch(key);
      });
  }

  /** Move an existing ProPanes session — started anywhere — into a new Slack
   * thread: later replies there drive it like a Slack-started session
   * (send-keys while live, native resume once stopped). Only output written
   * after the move is posted; the latest assistant message is shown for context. */
  async continueInSlack(target: Pick<IncomingSlackMessage, 'teamId' | 'channel'>, sessionId: string,
    sourceReply: (text: string) => Promise<unknown>): Promise<{ ok: boolean; message: string; permalink?: string }> {
    const existing = this.d.state.threads().find(t => t.kind !== 'terminal' && t.sessionId === sessionId);
    if (existing) {
      let permalink: string | undefined;
      try { permalink = existing.threadTs ? await this.d.slack.permalink(existing.channel, existing.threadTs) : undefined; } catch { /* plain text below */ }
      const message = `Session ${sessionId} already continues in a Slack thread`;
      await sourceReply(`${this.link(sessionId)} already continues in ${permalink ? `<${permalink}|this thread>` : 'another Slack conversation'}; reply there.`);
      return { ok: true, message, permalink };
    }
    let session: SessionInfo;
    try {
      session = await this.d.propanes.getSession(sessionId);
    } catch (err) {
      const message = `Could not load session ${sessionId}: ${safeMessage(err)}`;
      await sourceReply(`⚠️ ${escapeMrkdwn(message)}`);
      return { ok: false, message };
    }
    if (session.permissionProfile === 'plain' || session.status === 'deleted') {
      const message = session.status === 'deleted' ? 'That session was archived' : 'Plain terminals cannot be continued in Slack';
      await sourceReply(`⚠️ ${message}. Nothing was moved.`);
      return { ok: false, message };
    }
    const apps = await this.d.propanes.listApplications().catch(() => [] as AppInfo[]);
    const app = apps.find(a => a.id === session.appId);
    const runtime: Runtime = session.runtime === 'codex' ? 'codex' : 'claude';
    let agentName = `${runtimeLabel(runtime)} session`;
    if (session.agentEndpointId) {
      const agents = await this.d.propanes.listAgents(session.appId || this.d.config.appId).catch(() => [] as AgentEndpointInfo[]);
      agentName = agents.find(a => a.id === session.agentEndpointId)?.name || agentName;
    }
    const title = (session.title || session.feedbackTitle || sessionId).replace(/\s+/g, ' ').trim().slice(0, 100);
    let result: { ok: boolean; message: string } = { ok: false, message: 'The Slack thread could not be prepared' };
    const permalink = await this.newThread(target, `Continuing session: ${escapeMrkdwn(title)}`, sourceReply, async (key, ts, post) => {
      const now = this.now();
      const nowIso = new Date(now).toISOString();
      const live = isLive(session.status);
      const record: ThreadRecord = {
        key, teamId: target.teamId, channel: target.channel, threadTs: ts,
        sessionId, feedbackId: session.feedbackId || '',
        ...(session.appId ? { appId: session.appId, appName: app?.name ?? session.appId } : {}),
        ...(session.launcherId ? { launcherId: session.launcherId, infraName: session.machineName || session.launcherName || session.launcherId } : {}),
        runtime, agentEndpointId: session.agentEndpointId || '', agentName,
        permissionProfile: session.permissionProfile || undefined,
        mode: 'default', images: false,
        history: [{ sessionId, runtime, agentName, createdAt: nowIso }],
        delivery: freshCheckpoint(now, now), watching: live, createdAt: nowIso, updatedAt: nowIso,
      };
      record.delivery.turnOpen = false;
      record.delivery.sentPrompts = [];
      // Read the transcript so far without posting it: the watcher continues
      // from this cursor with the same parser state.
      const follower = new TranscriptFollower(runtime);
      let lastReply: string | undefined;
      try {
        const delta = await this.d.propanes.jsonlDelta(sessionId, 'init', this.d.config.transcriptTail);
        const events = follower.ingest(delta);
        if (!delta.pending) record.delivery.cursor = delta.cursor;
        record.delivery.delivered = events.map(e => e.key);
        lastReply = events.filter(e => e.msg.role === 'assistant' && !e.msg.subagentId && e.msg.content.trim()).pop()?.msg.content;
      } catch (err) {
        this.d.log(`Could not read the transcript of ${sessionId} (${err instanceof Error ? err.name : 'error'}); following new output only`);
      }
      this.followers.set(key, { sessionId, follower });
      this.d.state.putThread(record);
      const state = !live ? `${session.status} — your next reply resumes it with its conversation restored`
        : session.inputState === 'waiting' ? 'running — waiting for input'
        : session.inputState === 'idle' ? 'running — idle' : 'running — working';
      const lines = [
        `🔀 Continuing ${this.link(sessionId)} in Slack`,
        `*app* ${escapeMrkdwn(this.appLabel(record))}${this.infraLabel(record)} · *agent* ${runtimeLabel(runtime)} (${escapeMrkdwn(agentName)}) · *state* ${escapeMrkdwn(state)}`,
      ];
      if (lastReply) lines.push(`*Latest reply*\n${toMrkdwn(truncateText(stripCosReplyTags(lastReply), 1500))}`);
      lines.push('Reply in this thread to continue the conversation · `stop` cancels · `[status]` · `[help]`');
      for (const part of coalesce([lines.join('\n')])) await post(part);
      if (live) this.watch(key);
      result = { ok: true, message: `Session ${sessionId} continues in Slack` };
    });
    return permalink ? { ...result, permalink } : result;
  }

  /** Admin "Continue in Slack" requests, claimed from the server queue. */
  async handleHandoff(req: SlackHandoffRequest): Promise<void> {
    const report = (r: { ok: boolean; message: string; permalink?: string }) =>
      this.d.propanes.reportHandoff(req.id, r).catch(err => this.d.log(`Could not report handoff ${req.id}: ${err instanceof Error ? err.name : 'error'}`));
    const latest = this.d.state.latestThread();
    let channel = this.d.config.handoffChannel || latest?.channel;
    if (!channel) {
      await report({ ok: false, message: `${BOT_NAME} has no Slack conversation to post in yet: set AMIROBOT_HANDOFF_CHANNEL or mention the bot once` });
      return;
    }
    const teamId = latest?.teamId ?? this.d.config.teamId ?? 'team';
    // A user id means "their DM with the bot". Replies there arrive under the
    // DM's own channel id, which Slack returns for the first post.
    if (/^[UW]/.test(channel)) {
      try {
        const intro = await this.d.slack.postMessage({ channel, text: 'Moving a session here from ProPanes…' }) as { channel?: string };
        if (intro?.channel) channel = intro.channel;
      } catch (err) {
        await report({ ok: false, message: `Could not message you in Slack: ${safeMessage(err)}` });
        return;
      }
    }
    // The source "conversation" is the server's toast, not Slack.
    const notes: string[] = [];
    try {
      const result = await this.continueInSlack({ teamId, channel }, req.sessionId, async (text) => { notes.push(text); });
      await report(result);
    } catch (err) {
      await report({ ok: false, message: safeMessage(err) });
    }
  }

  /** Button clicks use exact launcher IDs and the same per-thread lock as messages. */
  async handleInfraTerminalAction(action: InfraTerminalAction): Promise<void> {
    if (!this.d.state.markEvent(action.eventId)) return;
    const key = threadKey(action.teamId, action.channel, action.threadTs);
    const reply = (text: string) => this.d.slack.postMessage({ channel: action.channel, thread_ts: action.threadTs ?? undefined, text });
    await this.withLock(key, async () => {
      try {
        const list = await this.d.propanes.listDispatchTargets();
        const target = [localAsTarget(list.localTarget), ...list.targets].find(t => t.launcherId === action.launcherId);
        if (!target || !canOpenTerminal(target)) {
          await reply('That terminal target is unavailable. Send `[infra]` for the current list. Nothing was started.');
          return;
        }
        const ev = { teamId: action.teamId, channel: action.channel, user: action.user };
        const resolved = { app: await this.defaultAppInfo(), infra: target.launcherId === LOCAL_LAUNCHER_ID ? undefined : target };
        const cmd: ParsedCommand = { command: 'prompt', terminal: true, text: '' };
        await this.startTerminal(ev, key, action.threadTs, cmd, reply, resolved);
      } catch (err) {
        await reply(`⚠️ Could not open terminal: ${escapeMrkdwn(safeMessage(err))}`);
      }
    });
  }

  /** Whether this bridge drives (or was addressed in) the conversation. */
  owns(key: string): boolean {
    return !!this.d.state.getThread(key) || this.d.state.isEngagedThread(key);
  }

  /** The bot's own user id, learned from auth.test after construction. */
  setBotUserId(id: string | undefined): void {
    this.d.config.botUserId = id;
  }

  setTeamId(id: string | undefined): void {
    this.d.config.teamId = id;
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

  private async handlePrompt(ev: IncomingSlackMessage, key: string, threadTs: string | null, cmd: ParsedCommand, reply: (t: string) => Promise<unknown>, staged: StagedAttachments): Promise<void> {
    const record = this.d.state.getThread(key);
    const hasOptions = cmd.runtime !== undefined || cmd.mode !== undefined || cmd.images !== undefined || cmd.app !== undefined || cmd.infra !== undefined || cmd.terminal !== undefined || cmd.session !== undefined;
    try {
      if (isStopKeyword(cmd.text) && !hasOptions) return await this.stopSession(record, reply);
      if (cmd.session) { await this.branchSession(ev, record, cmd, reply, staged); return; }
      if (cmd.terminal) {
        return await this.startTerminal(ev, key, threadTs, cmd, reply);
      }
      if (!record && ev.threadTs && cmd.text) {
        await this.newThread(ev, `Session: ${escapeMrkdwn(cmd.text.slice(0, 120))}`, reply,
          (nextKey, ts, post) => this.startSession(ev, nextKey, ts, cmd, post, staged));
        return;
      }
      if (record?.kind === 'terminal') return await this.continueTerminal(record, cmd, staged, reply);
      if (!record) return await this.startSession(ev, key, threadTs, cmd, reply, staged);
      return await this.continueThread(ev, record, cmd, reply, staged);
    } catch (err) {
      this.d.log(`Request handling failed: ${err instanceof Error ? err.name : 'error'}`);
      await reply(`⚠️ Something went wrong: ${escapeMrkdwn(safeMessage(err))}`);
    }
  }

  // ---------------------------------------------------------------- attachments

  /** Download the message's attachments from Slack. Every rejected or failed
   * file is reported in the thread; nothing is ever invented for them. */
  private async downloadAttachments(ev: IncomingSlackMessage, record: ThreadRecord | undefined, reply: (t: string) => Promise<unknown>): Promise<StagedAttachments> {
    const staged: StagedAttachments = { images: [], files: [] };
    const files = ev.files ?? [];
    if (!this.d.files) {
      await reply(attachmentsNotForwardedNote(files.length));
      return staged;
    }
    const notes: string[] = [];
    let scopeMissing = false;
    for (const file of files) {
      const name = escapeMrkdwn(displayName(file));
      const cls = classifyAttachment(file);
      if (cls.kind === 'skip') {
        notes.push(`skipped ${name}: ${cls.reason}`);
        continue;
      }
      try {
        const downloaded = await this.d.files.download(file);
        (cls.kind === 'image' ? staged.images : staged.files).push(downloaded);
      } catch (err) {
        if (err instanceof SlackFileAccessError && err.code === 'missing_scope') {
          scopeMissing = true;
        } else {
          notes.push(`could not download ${name}: ${escapeMrkdwn(safeMessage(err))}`);
        }
      }
    }
    if (scopeMissing) {
      if (!record?.filesReadWarned) {
        await reply('⚠️ I cannot read Slack attachments: the app needs the `files:read` scope (add it and reinstall the app, see packages/slack-bot/README.md). Your text is still delivered; attachments are skipped until then.');
        if (record) { record.filesReadWarned = true; this.d.state.putThread(record); }
      }
    }
    if (notes.length) await reply(`📎 ${notes.join('; ')}`);
    return staged;
  }

  /** Stage downloaded files for a session through the routes the admin
   * composer uses, returning what the prompt may reference. */
  private async stageForSession(record: ThreadRecord | undefined, staged: StagedAttachments, reply: (t: string) => Promise<unknown>): Promise<ForwardedAttachment[]> {
    const out: ForwardedAttachment[] = [];
    const base = this.d.config.publicUrl.replace(/\/$/, '');
    const sessionId = record?.sessionId;
    if (staged.images.length) {
      try {
        const up = await this.d.propanes.uploadScreenshots(sessionId, staged.images, record ? this.threadAppId(record) : (await this.defaultAppInfo()).id);
        up.screenshots.forEach((s, i) => out.push({ kind: 'image', name: staged.images[i]?.name ?? s.filename, path: s.path, url: `${base}/api/v1/screenshots/${s.id}` }));
      } catch (err) {
        await reply(`📎 ⚠️ Could not stage ${staged.images.length} image${staged.images.length === 1 ? '' : 's'} for the session: ${escapeMrkdwn(safeMessage(err))}`);
      }
    }
    if (staged.files.length) {
      try {
        const up = await this.d.propanes.uploadFiles(sessionId, staged.files, record ? this.threadAppId(record) : (await this.defaultAppInfo()).id);
        up.files.forEach((f) => out.push({ kind: 'file', name: f.originalName || f.filename, path: f.path, url: `${base}/api/v1/uploads/${f.id}` }));
      } catch (err) {
        await reply(`📎 ⚠️ Could not stage ${staged.files.length} file${staged.files.length === 1 ? '' : 's'} for the session: ${escapeMrkdwn(safeMessage(err))}`);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- commands

  private async startSession(ev: IncomingSlackMessage, key: string, threadTs: string | null, cmd: ParsedCommand, reply: (t: string) => Promise<unknown>, staged: StagedAttachments): Promise<void> {
    if (!cmd.text) {
      await reply(`Tell me what to do, e.g. \`@${BOT_NAME} review PR 2013\`. Send \`[help]\` for options.`);
      return;
    }
    const target = await this.resolveTargets(cmd, reply);
    if (!target) return;
    const { app, infra } = target;
    const appId = app.id;
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
    // Images become feedback screenshots (rendered into the prompt and shipped
    // to remote launchers by the dispatcher); other files go through uploads.
    const feedback = await this.d.propanes.createFeedback({
      title: feedbackTitle(cmd.text),
      description: cmd.text,
      appId,
      tags: ['slack', BOT_NAME],
      screenshots: staged.images,
    });
    const forwarded = await this.stageForSession(undefined, { images: [], files: staged.files }, reply);
    const extra = forwarded.length ? `\n\n${attachmentBlock(forwarded, false)}` : '';
    const model = this.defaultModel(ev.teamId, ev.user, runtime);
    const { sessionId } = await this.d.propanes.dispatch({
      feedbackId: feedback.id,
      agentEndpointId: endpoint.id,
      model,
      instructions: slackInstructions(mode) + extra,
      permissionProfile: PERMISSION_PROFILE,
      ...(infra ? { launcherId: infra.launcherId } : {}),
    });
    const nowIso = new Date(this.now()).toISOString();
    const record: ThreadRecord = {
      key, teamId: ev.teamId, channel: ev.channel, threadTs,
      sessionId, feedbackId: feedback.id, appId, appName: app.name, runtime,
      ...(infra ? { launcherId: infra.launcherId, infraName: infra.name } : {}), agentEndpointId: endpoint.id, agentName: endpoint.name || endpoint.id,
      mode, images, model,
      history: [{ sessionId, runtime, agentName: endpoint.name || endpoint.id, createdAt: nowIso }],
      delivery: freshCheckpoint(this.now(), this.now() - FRESH_SESSION_GRACE_MS), watching: true, createdAt: nowIso, updatedAt: nowIso,
    };
    record.delivery.sentPrompts = rememberSentPrompt(undefined, cmd.text);
    this.d.state.putThread(record);
    if (ev.user) this.d.state.setRuntimePref(ev.teamId, ev.user, runtime);
    await reply(this.initialReply(record, staged.images.length + forwarded.length));
    this.watch(key);
  }

  private async listActiveSessions(ev: IncomingSlackMessage, key: string, cmd: ParsedCommand, reply: (t: string) => Promise<unknown>): Promise<void> {
    try {
      let app: AppInfo | undefined;
      const apps = cmd.command === 'list-sessions' || cmd.app !== undefined
        ? await this.d.propanes.listApplications() : [];
      if (cmd.app !== undefined) {
        const match = resolveApp(apps, cmd.app);
        if (match.kind === 'many') { await reply(ambiguousAppText(cmd.app, match.apps)); return; }
        if (match.kind === 'none') { await reply(unknownAppText(cmd.app, apps)); return; }
        app = match.app;
      }
      const sessions = await this.d.propanes.listActiveSessions();
      const terminals = cmd.command === 'list-terminals';
      const parts = sessionListing(sessions, terminals, id => this.sessionUrl(id), app, apps);
      // The numbers in the listing select a session to continue in Slack.
      const ids = terminals ? [] : listedSessions(sessions, false, app).flat().map(s => s.id);
      if (ev.user && ids.length) {
        this.d.state.clearModelMenu(key, ev.user);
        this.d.state.setSessionMenu(key, ev.user, ids, this.now() + SESSION_MENU_TTL_MS);
      }
      for (const part of parts) await reply(part);
    } catch (err) {
      await reply(`⚠️ Could not list active ${cmd.command === 'list-terminals' ? 'terminals' : 'sessions'}: ${escapeMrkdwn(safeMessage(err))}`);
    }
  }

  private async resolveTargets(cmd: ParsedCommand, reply: (t: string) => Promise<unknown>): Promise<{ app: AppInfo; infra?: InfraTarget } | undefined> {
    const apps = await this.d.propanes.listApplications();
    let app: AppInfo;
    if (cmd.app !== undefined) {
      const match = resolveApp(apps, cmd.app);
      if (match.kind === 'many') { await reply(ambiguousAppText(cmd.app, match.apps)); return; }
      if (match.kind === 'none') { await reply(unknownAppText(cmd.app, apps, this.defaultApp(apps).id)); return; }
      app = match.app;
    } else {
      app = this.defaultApp(apps);
    }
    let infra: InfraTarget | undefined;
    if (cmd.infra !== undefined) {
      const list = await this.d.propanes.listDispatchTargets();
      const match = resolveInfra(list, cmd.infra);
      if (match.kind === 'many') { await reply(ambiguousInfraText(cmd.infra, match.targets)); return; }
      if (match.kind === 'offline') { await reply(offlineInfraText(match.target, list)); return; }
      if (match.kind === 'none') { await reply(unknownInfraText(cmd.infra, list)); return; }
      if (match.target.launcherId !== LOCAL_LAUNCHER_ID) infra = match.target;
    }
    return { app, infra };
  }

  private async startTerminal(ev: Pick<IncomingSlackMessage, 'teamId' | 'channel' | 'user'>, key: string, threadTs: string | null, cmd: ParsedCommand, reply: (t: string) => Promise<unknown>, resolvedTarget?: { app: AppInfo; infra?: InfraTarget }): Promise<void> {
    const target = resolvedTarget ?? await this.resolveTargets(cmd, reply);
    if (!target) return;
    const { app, infra } = target;
    if (infra?.isHarness || infra?.isSprite) {
      await reply('Plain terminal requests support local or remote machines. Choose a machine with `[infra:name]`. Nothing was started.');
      return;
    }
    const { sessionId } = await this.d.propanes.createTerminal({
      permissionProfile: 'plain',
      ...(cmd.app ? { appId: app.id } : {}),
      ...(infra ? { launcherId: infra.launcherId } : {}),
    });
    const previous = this.d.state.getThread(key);
    // A separate terminal link must not replace an existing agent conversation.
    if (!previous || previous.kind === 'terminal') {
      const nowIso = new Date(this.now()).toISOString();
      this.d.state.putThread({
        key, teamId: ev.teamId, channel: ev.channel, threadTs, kind: 'terminal',
        appId: app.id, appName: app.name, launcherId: infra?.launcherId, infraName: infra?.name,
        sessionId, feedbackId: '', runtime: 'claude', agentEndpointId: '', agentName: 'Terminal',
        mode: 'default', images: false, history: [], delivery: freshCheckpoint(this.now()),
        watching: false, createdAt: nowIso, updatedAt: nowIso,
      });
    }
    await reply(`Terminal started: ${this.link(sessionId)}${infra ? ` · ${escapeMrkdwn(infra.name)}` : ''}${cmd.app ? ` · ${escapeMrkdwn(app.name)}` : ''}. ${previous && previous.kind !== 'terminal' ? 'Replies in this thread continue to reach the agent.' : 'Reply here to send shell input · `stop` closes it · `[status]`.'}`);
  }

  private async continueTerminal(record: ThreadRecord, cmd: ParsedCommand, staged: StagedAttachments, reply: (t: string) => Promise<unknown>): Promise<void> {
    if (cmd.runtime || cmd.mode || cmd.images || cmd.app || cmd.infra || staged.images.length || staged.files.length) {
      await reply(`Use ${this.link(record.sessionId)} to access this terminal, or reply with shell input. Send \`[terminal]\` with selectors to open another.`);
      return;
    }
    const session = await this.currentSession(record);
    if (!isLive(session.status)) {
      await reply(`Terminal ${this.link(record.sessionId)} has ended. Send \`[terminal]\` to open another.`);
      return;
    }
    const result = await this.d.propanes.sendKeys(record.sessionId, cmd.text.replace(/\r?\n/g, ' ⏎ '));
    if (!result.ok) await reply(`⚠️ Could not send terminal input: ${escapeMrkdwn(result.error || 'send-keys failed')}`);
  }

  private initialReply(record: ThreadRecord, attached = 0): string {
    const lines = [
      `🚀 Session started: ${this.link(record.sessionId)}`,
      `*app* ${escapeMrkdwn(this.appLabel(record))}${this.infraLabel(record)} · *agent* ${runtimeLabel(record.runtime)} (${escapeMrkdwn(record.agentName)}) · *output* ${record.mode} · *images* ${record.images ? 'on' : 'off'}`,
    ];
    if (attached) lines.push(`📎 ${attached} attachment${attached === 1 ? '' : 's'} passed to the session.`);
    if (record.mode === 'quiet') lines.push('_Quiet mode: I will post only the final answer here when the session finishes._');
    lines.push('Reply in this thread to continue the conversation · `stop` cancels · `[status]` · `[help]`');
    return lines.join('\n');
  }

  private async continueThread(ev: IncomingSlackMessage, record: ThreadRecord, cmd: ParsedCommand, reply: (t: string) => Promise<unknown>, staged: StagedAttachments): Promise<void> {
    if (cmd.app !== undefined) {
      const apps = await this.d.propanes.listApplications();
      const match = resolveApp(apps, cmd.app);
      if (match.kind !== 'one' || match.app.id !== this.threadAppId(record)) {
        await reply(`ℹ️ This thread's session runs in *${escapeMrkdwn(this.appLabel(record))}*; an application cannot change mid-thread. Start a new thread with \`[app:${escapeMrkdwn(cmd.app)}]\` for another project. Your message was not sent.`);
        return;
      }
    }
    if (cmd.infra !== undefined) {
      const match = resolveInfra(await this.d.propanes.listDispatchTargets(), cmd.infra);
      const sameTarget = match.kind === 'one' && (match.target.launcherId === (record.launcherId ?? LOCAL_LAUNCHER_ID));
      if (!sameTarget) {
        const where = record.infraName ? `on *${escapeMrkdwn(record.infraName)}*` : 'on this server';
        await reply(`ℹ️ This thread's session runs ${where}; infrastructure cannot change mid-thread (continuations stay where the conversation is). Start a new thread with \`[infra:${escapeMrkdwn(cmd.infra)}]\`. Your message was not sent.`);
        return;
      }
    }
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
    const forwarded = (staged.images.length || staged.files.length) ? await this.stageForSession(record, staged, reply) : [];
    const oneLineText = forwarded.length ? `${cmd.text} ${attachmentBlock(forwarded, true)}` : cmd.text;
    const multiLineText = forwarded.length ? `${cmd.text}\n\n${attachmentBlock(forwarded, false)}` : cmd.text;
    const selectedModel = this.defaultModel(ev.teamId, ev.user, cmd.runtime ?? record.runtime);
    const changingModel = selectedModel !== undefined && selectedModel !== record.model;
    if (switching || changingModel) return this.switchRuntime(ev, record, cmd.runtime ?? record.runtime, multiLineText, reply);

    let session = await this.currentSession(record);
    if (isLive(session.status)) {
      // Same operation as the structured view's input bar: keys straight to the live process.
      const keys = promptForSendKeys(oneLineText, record.mode);
      const result = await this.d.propanes.sendKeys(record.sessionId, keys);
      if (result.ok) {
        this.openTurn(record);
        record.delivery.sentPrompts = rememberSentPrompt(record.delivery.sentPrompts, keys);
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
    await this.resumeInto(record, multiLineText, undefined, reply, this.resumeReason(record, session), ev.user);
  }

  private resumeReason(record: ThreadRecord, session: SessionInfo): string {
    const link = this.link(record.sessionId);
    if (record.paused?.sessionId === record.sessionId) {
      return record.paused.reason === 'idle'
        ? `▶️ Resuming ${link}, paused after ${formatDuration(this.d.config.idleStopMs)} without activity`
        : `▶️ Resuming ${link}, stopped earlier on request`;
    }
    return `Session ${link} had ${session.status === 'completed' ? 'finished' : `ended (${session.status})`}`;
  }

  /** Explicit runtime change inside a thread: the thread keeps its history and
   * the previous session's link; the new runtime starts as a continuation
   * (child session) of the current one, carrying the thread's task context. */
  private async switchRuntime(ev: IncomingSlackMessage, record: ThreadRecord, runtime: Runtime, text: string, reply: (t: string) => Promise<unknown>): Promise<void> {
    const appId = this.threadAppId(record);
    const agents = await this.d.propanes.listAgents(appId);
    try {
      resolveAgentEndpoint(agents, runtime, appId);
    } catch (err) {
      if (err instanceof AgentUnavailableError) {
        await reply(`⚠️ ${escapeMrkdwn(err.message)}. Staying on ${runtimeLabel(record.runtime)}; your message was not sent.`);
        return;
      }
      throw err;
    }
    const session = await this.currentSession(record);
    let reason = runtime === record.runtime
      ? `Applying your selected ${runtimeLabel(runtime)} model`
      : `Switching this thread from ${runtimeLabel(record.runtime)} to ${runtimeLabel(runtime)}`;
    if (isLive(session.status)) {
      // Mirrors the admin's "Resume as…": an explicit profile/runtime change stops the live run first.
      await this.d.propanes.kill(record.sessionId).catch(() => undefined);
      await this.awaitStopped(record.sessionId);
      reason += ` (stopped the running ${runtimeLabel(record.runtime)} session)`;
    }
    const ok = await this.resumeInto(record, text, runtime, reply, reason, ev.user);
    if (ok && ev.user) this.d.state.setRuntimePref(ev.teamId, ev.user, runtime);
  }

  private async resumeInto(record: ThreadRecord, text: string, runtime: Runtime | undefined, reply: (t: string) => Promise<unknown>, reason: string, userId?: string): Promise<boolean> {
    const parentId = record.sessionId;
    const model = this.defaultModel(record.teamId, userId, runtime ?? record.runtime)
      ?? (runtime === undefined || runtime === record.runtime ? record.model : undefined);
    try {
      // The agent's own resume (claude --resume / codex resume) restores the
      // conversation; the thread's TTY profile is pinned so a drifted row never
      // turns the continuation into a headless stream.
      const { sessionId } = await this.d.propanes.resume(parentId, {
        additionalPrompt: promptForResume(text, record.mode),
        model,
        permissionProfile: record.permissionProfile ?? PERMISSION_PROFILE,
        ...(runtime ? { runtime } : {}),
      });
      const nextRuntime = runtime ?? record.runtime;
      const agentName = runtime && runtime !== record.runtime ? `${record.agentName} → ${runtime}` : record.agentName;
      record.sessionId = sessionId;
      record.runtime = nextRuntime;
      record.model = model;
      record.agentName = agentName;
      record.history.push({ sessionId, runtime: nextRuntime, agentName, createdAt: new Date(this.now()).toISOString() });
      record.delivery = freshCheckpoint(this.now(), this.now() - RESUME_GRACE_MS);
      record.delivery.sentPrompts = rememberSentPrompt(undefined, text);
      record.watching = true;
      record.paused = undefined;
      this.followers.delete(record.key);
      this.d.state.putThread(record);
      await reply(`${reason} — continuing in ${this.link(sessionId)} (${runtimeLabel(nextRuntime)}, ${record.mode}) with its conversation restored. Previous session: ${this.link(parentId)}.`);
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
    if (record.kind === 'terminal') {
      this.d.state.putThread(record);
      await reply(`Stopped terminal ${this.link(record.sessionId)}. Send \`[terminal]\` to open another.`);
      return;
    }
    record.paused = { at: new Date(this.now()).toISOString(), reason: 'stop', sessionId: record.sessionId };
    this.d.state.putThread(record);
    await reply(`🛑 Stopped session ${this.link(record.sessionId)}; its conversation is kept. Reply here to resume it with a new message.`);
  }

  async statusText(record: ThreadRecord | undefined): Promise<string> {
    if (!record) return 'No session is associated with this thread. Mention me with a request to start one.';
    let session: SessionInfo | null = null;
    try { session = await this.currentSession(record); } catch { /* reported below */ }
    if (record.kind === 'terminal') return `*terminal* ${this.link(record.sessionId)}${this.infraLabel(record)} · *state* ${escapeMrkdwn(session?.status ?? 'unknown (ProPanes unreachable)')}`;
    const paused = record.paused?.sessionId === record.sessionId && session && !isLive(session.status)
      ? (record.paused.reason === 'idle' ? `paused after ${formatDuration(this.d.config.idleStopMs)} idle` : 'stopped on request') + ' — reply to resume'
      : null;
    const state = !session ? 'unknown (ProPanes unreachable)'
      : paused ? paused
      : TERMINAL_STATUSES.has(session.status) ? session.status
      : session.inputState === 'waiting' ? 'running — waiting for your input'
      : session.inputState === 'idle' ? 'running — idle (turn finished)'
      : `${session.status} — working`;
    const lines = [
      `*session* ${this.link(record.sessionId)} · *app* ${escapeMrkdwn(this.appLabel(record))}${this.infraLabel(record)} · *agent* ${runtimeLabel(record.runtime)} (${escapeMrkdwn(record.agentName)})`,
      `*output* ${record.mode} · *images* ${record.images ? 'on' : 'off'} · *state* ${escapeMrkdwn(state)}`,
    ];
    if (record.history.length > 1) {
      lines.push(`*history* ${record.history.slice(0, -1).map((h) => `${this.link(h.sessionId)} (${runtimeLabel(h.runtime)})`).join(' → ')}`);
    }
    return lines.join('\n');
  }

  private threadAppId(record: ThreadRecord): string {
    return record.appId ?? this.d.config.appId;
  }

  private infraLabel(record: ThreadRecord): string {
    return record.launcherId ? ` · *infra* ${escapeMrkdwn(record.infraName ?? record.launcherId)}` : '';
  }

  private appLabel(record: ThreadRecord): string {
    return record.appName ?? record.appId ?? this.d.config.appId;
  }

  private defaultApp(apps: AppInfo[]): AppInfo {
    return defaultApp(apps, this.d.config.defaultApp, this.d.config.appId);
  }

  private async defaultAppInfo(): Promise<AppInfo> {
    try {
      return this.defaultApp(await this.d.propanes.listApplications());
    } catch {
      return { id: this.d.config.appId, name: this.d.config.defaultApp ?? this.d.config.appId };
    }
  }

  private async defaultAppName(): Promise<string> {
    return (await this.defaultAppInfo()).name;
  }

  private async currentSession(record: ThreadRecord): Promise<SessionInfo> {
    let rows: SessionInfo[] = [];
    try { if (record.feedbackId) rows = await this.d.propanes.listSessions(record.feedbackId); } catch { /* fall back to the single row */ }
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

      const since = record.delivery.since ?? 0;
      const events = follower.ingest(delta)
        .filter((e) => !record.delivery.delivered.includes(e.key))
        .filter((e) => !(since && e.msg.timestamp > 0 && e.msg.timestamp < since));
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
        await this.pauseIdle(record, session);
        return;
      }
      this.d.state.putThread(record);
      await this.sleep(record.delivery.turnOpen ? this.d.config.pollMs : this.d.config.idlePollMs);
    }
  }

  /** Idle timeout: stop the agent so it does not sit in a TTY for hours. Its
   * transcript stays on disk, so the next reply resumes the same conversation
   * (claude --resume / codex resume) instead of re-explaining the task. */
  private async pauseIdle(record: ThreadRecord, session: SessionInfo): Promise<void> {
    const link = this.link(record.sessionId);
    const idleFor = formatDuration(this.d.config.idleStopMs);
    record.watching = false;
    if (isLive(session.status)) {
      try {
        await this.d.propanes.kill(record.sessionId);
      } catch (err) {
        this.d.state.putThread(record);
        this.d.log(`Could not stop idle session ${record.sessionId}: ${err instanceof Error ? err.name : 'error'}`);
        await this.post(record, `⚠️ ${link} has been idle for ${idleFor} but could not be stopped (${escapeMrkdwn(safeMessage(err))}); I stopped following it. Reply here to re-attach.`);
        return;
      }
    }
    record.paused = { at: new Date(this.now()).toISOString(), reason: 'idle', sessionId: record.sessionId };
    this.d.state.putThread(record);
    this.d.log(`Paused idle session ${record.sessionId}`);
    await this.post(record, `💤 Paused ${link} after ${idleFor} without activity: the agent is stopped and its conversation is kept. Reply in this thread to resume it where it left off.`);
  }

  private async deliverEvents(record: ThreadRecord, follower: TranscriptFollower, events: { key: string; msg: import('./transcript').ParsedMessage }[]): Promise<void> {
    let pieces: string[] = [];
    const flush = async () => {
      for (const text of coalesce(pieces)) await this.post(record, text);
      pieces = [];
    };
    for (const { msg } of events) {
      if (msg.role === 'assistant' && !msg.subagentId && msg.content.trim()) record.delivery.turnTexts.push(msg.content);
      if (msg.role === 'user_input' && !msg.subagentId && isOutsideInput(msg.content, record.delivery.sentPrompts)) {
        // Typed in the admin PTY / structured view: say so in every mode, so
        // the replies that follow are attributable, and treat it as a new turn
        // (quiet mode then delivers its final answer like any Slack-sent turn).
        pieces.push(renderOutsideInput(msg.content));
        if (!record.delivery.turnOpen) this.openTurn(record);
      }
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
  return `📎 ${count} attachment${count === 1 ? '' : 's'} not forwarded: this listener has no Slack file access configured. Your text is still delivered.`;
}

const QUIET_SUFFIX = ' (Reply via Slack: finish with your answer inside <cos-reply></cos-reply>.)';

/** Keys for a live TTY: the structured view sends single-line input, so a
 * multi-line Slack message is sent as one line to avoid an early submit. */
export function promptForSendKeys(text: string, mode: OutputMode): string {
  const oneLine = text.replace(/\r?\n+/g, ' ⏎ ').trim();
  return mode === 'quiet' ? oneLine + QUIET_SUFFIX : oneLine;
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} h` : `${hours.toFixed(1)} h`;
}

export function promptForResume(text: string, mode: OutputMode): string {
  return mode === 'quiet' ? `${text.trim()}\n\n${slackInstructions('quiet')}` : text.trim();
}

export function helpText(defaultAppName?: string): string {
  const def = defaultAppName ? ` (default: *${escapeMrkdwn(defaultAppName)}*)` : '';
  return [
    '*amirobot — Slack ⇄ ProPanes sessions*',
    'Mention me with a request to start an agent session; every reply in the thread is sent to that session (no mention needed). Leading `[options]` are case-insensitive and may be comma-separated.',
    '',
    '*Commands*',
    '• `[models]` — list numbered model choices; reply with a number or use `[models:opus]`, `[models:sonnet]`, `[models:astra]`. Saves your provider default for new sessions and your next thread message.',
    `• \`@amirobot review PR 2013\` — new session in the default application${def} with your remembered agent (ProPanes default the first time)`,
    '• `@amirobot [app:<name>] …` / `[claude, app:storefront] …` — run in that application (project); partial names work when they match exactly one app, otherwise I list the candidates. Fixed per thread.',
    '• `@amirobot [apps]` — the registered applications and their `[app:…]` option',
    '• `@amirobot [infra:laptop] …` — run the session on that connected machine/launcher instead of this server (the app is synced there); offline or ambiguous targets are refused with the list. Fixed per thread.',
    '• `@amirobot [infra]` — connected infrastructure (machines, harnesses, this server) with state, load, the `[infra:…]` option and Open terminal buttons',
    '• `@amirobot [claude] …` / `[codex] …` — pick the agent; inside a thread this continues the task on the other agent',
    '• `@amirobot [help]` — this message · `[status]` — the thread\'s session, app, agent, state and link',
    '• `[session] optional task` — branch this conversation into its own thread with full agent history; the original keeps running',
    '• reply `stop` (or `cancel`) — stop the thread\'s running session; a later reply resumes it',
    '• sessions idle for an hour are paused (agent stopped, conversation kept); any reply resumes them with their full context',
    '• prompts typed in the ProPanes terminal or structured view are echoed here as `👤 User asked outside Slack`, so the replies that follow are attributable',
    '',
    '*Session lists*',
    '• `[sessions]` — all active agent sessions, numbered, with clickable links; reply with a number to continue that session in its own Slack thread',
    '• `[app:propanes sessions]` — active agent sessions for that app (approximate app matching supported)',
    '• `[terminals]` — all active plain terminals with clickable links',
    '',
    '*Terminals*',
    '• `[terminal]` / `[infra:macbook terminal]` — open a plain shell and return its session link; optional `[app:name]` supplies app context',
    '• App/infra names accept partial matches and small typos; ambiguous matches list exact selectors to retry',
    '• A terminal opened in an agent thread is separate; replies keep reaching the agent',
    '',
    '*Output modes* (remembered per thread)',
    '• default — all assistant text (progress and answer); no tool calls or tool output',
    '• `[verbose]` — the full structured view: assistant text, tool calls and tool results, in order',
    '• `[quiet]` — only the session link now and the final `<cos-reply>` answer when the turn finishes',
    '• `[images]` — also upload every image the agent views (combinable, e.g. `[quiet, images]`)',
    '',
    '*Examples*',
    '• `@amirobot [codex, verbose] investigate the failing e2e test`',
    '• `@amirobot [app:storefront] add a dark theme toggle`',
    '• `@amirobot [codex, app:storefront, infra:laptop] build the app and screenshot it`',
    '• `@amirobot [quiet, images] screenshot the dashboard and describe it`',
    '• in a thread: `[verbose]` switches that thread to verbose for later replies',
  // The lines above are written for the original bot; each instance names itself.
  ].join('\n').replace(/\bamirobot\b/g, BOT_NAME);
}
