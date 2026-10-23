import { join } from 'node:path';
import { App, LogLevel } from '@slack/bolt';
import { downloaderFromToken } from './attachments';
import { SlackBridge, type IncomingSlackMessage } from './bridge';
import { configuredDefaultRuntime, resolveAgentEndpoint, runtimeLabel } from './agents';
import { defaultApp } from './apps';
import { createPropanesClient, createPropanesFetch } from './propanes';
import { PacedPoster, posterFromClient } from './slack';
import { FileStateStore, StateRepo } from './state';

const PROPANES_URL = process.env.PROPANES_URL ?? 'http://localhost:3001';
// Public-facing URL used in Slack messages. Defaults to PROPANES_URL but can
// be overridden when the server is reached internally but users click links
// from outside (e.g. PROPANES_URL=http://localhost:3001 but
// PROPANES_PUBLIC_URL=https://propanes.example.com).
const PROPANES_PUBLIC_URL = process.env.PROPANES_PUBLIC_URL ?? PROPANES_URL;
const APP_ID = process.env.PROPANES_APP_ID ?? '01KNR6HYSPE08RZJSQJG6WE1PK';
// Default application for new requests, by name or id (`[app:<name>]`
// overrides per thread); falls back to PROPANES_APP_ID when it does not resolve.
const DEFAULT_APP = process.env.PROPANES_DEFAULT_APP || undefined;
// Optional override. When unset, the bot resolves a skip-permissions agent
// endpoint for the requested runtime from the ProPanes agents API.
const AGENT_ENDPOINT_ID_OVERRIDE = process.env.AGENT_ENDPOINT_ID || undefined;
const POLL_MS = parseInt(process.env.POLL_MS ?? '4000', 10) || 4000;
const IDLE_POLL_MS = parseInt(process.env.IDLE_POLL_MS ?? '30000', 10) || 30000;
// An hour without session activity stops the agent (its transcript stays
// resumable); the next Slack reply resumes it natively (--resume / codex resume).
const IDLE_STOP_MS = parseInt(process.env.IDLE_STOP_MS ?? String(60 * 60 * 1000), 10) || 60 * 60 * 1000;
// systemd's StateDirectory= exports STATE_DIRECTORY; dev runs keep state next to the package.
const STATE_FILE = process.env.AMIROBOT_STATE_FILE
  ?? join(process.env.STATE_DIRECTORY ?? join(__dirname, '..', 'state'), 'amirobot-state.json');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  appToken: process.env.SLACK_APP_TOKEN!,
  socketMode: true,
  logLevel: LogLevel.WARN,
});

const propanesFetch = createPropanesFetch(PROPANES_URL, process.env.PROPANES_TOKEN);
const propanes = createPropanesClient(propanesFetch);
const state = new StateRepo(new FileStateStore(STATE_FILE));
const log = (message: string) => console.warn(`[amirobot] ${message}`);

const bridge = new SlackBridge({
  propanes,
  slack: new PacedPoster(posterFromClient(app.client as any)),
  files: downloaderFromToken(process.env.SLACK_BOT_TOKEN!),
  state,
  config: {
    appId: APP_ID,
    defaultApp: DEFAULT_APP,
    publicUrl: PROPANES_PUBLIC_URL,
    agentEndpointOverride: AGENT_ENDPOINT_ID_OVERRIDE,
    pollMs: POLL_MS,
    idlePollMs: IDLE_POLL_MS,
    idleStopMs: IDLE_STOP_MS,
    transcriptTail: 2000,
  },
  log,
});

let botUserId: string | undefined;

// Handlers hand the event to the bridge and return at once, so Socket Mode
// acknowledgements never wait on dispatch, polling or Slack posting.
function enqueue(ev: IncomingSlackMessage): void {
  bridge.handleEvent(ev).catch((err) => log(`event handling failed: ${err instanceof Error ? err.name : 'error'}`));
}

app.event('app_mention', async ({ event, body }) => {
  const e = event as any;
  enqueue({
    eventId: (body as any).event_id,
    teamId: (body as any).team_id ?? e.team ?? 'team',
    channel: e.channel,
    channelType: 'channel',
    user: e.user,
    botId: e.bot_id,
    subtype: e.subtype,
    ts: e.ts,
    threadTs: e.thread_ts,
    text: e.text ?? '',
    mentionsBot: true,
    files: Array.isArray(e.files) ? e.files : undefined,
  });
});

// Thread replies (no mention needed) and DMs. Top-level channel messages
// without a mention are ignored; mentions arrive via app_mention above.
// A message with attachments arrives as subtype `file_share` and still
// carries the human's text, so it is forwarded like any other reply.
app.message(async ({ message, body }) => {
  const m = message as any;
  if (m.bot_id || (m.subtype && m.subtype !== 'file_share' && m.subtype !== 'thread_broadcast')) return;
  const text: string = m.text ?? '';
  if (botUserId && text.includes(`<@${botUserId}>`)) return;
  const channelType = m.channel_type as IncomingSlackMessage['channelType'];
  if (channelType !== 'im' && !m.thread_ts) return;
  enqueue({
    eventId: (body as any).event_id,
    teamId: (body as any).team_id ?? m.team ?? 'team',
    channel: m.channel,
    channelType,
    user: m.user,
    subtype: m.subtype,
    ts: m.ts,
    threadTs: m.thread_ts,
    text,
    mentionsBot: false,
    files: Array.isArray(m.files) ? m.files : undefined,
  });
});

(async () => {
  // Fail before receiving mentions if the API credential is invalid.
  await propanes.me();
  const apps = await propanes.listApplications();
  const defApp = defaultApp(apps, DEFAULT_APP, APP_ID);
  const unmatched = DEFAULT_APP && defApp.id === APP_ID && defApp.name.toLowerCase() !== DEFAULT_APP.toLowerCase();
  console.log(`[amirobot] default application: ${defApp.name} (${defApp.id})${unmatched ? ` — PROPANES_DEFAULT_APP=${DEFAULT_APP} did not match, using PROPANES_APP_ID` : ''}; ${apps.length} registered`);
  const agents = await propanes.listAgents(defApp.id);
  const defaultRuntime = configuredDefaultRuntime(agents, defApp.id);
  for (const runtime of ['claude', 'codex'] as const) {
    try {
      const ep = resolveAgentEndpoint(agents, runtime, defApp.id, runtime === defaultRuntime ? AGENT_ENDPOINT_ID_OVERRIDE : undefined);
      console.log(`[amirobot] ${runtimeLabel(runtime)} → ${ep.name || ep.id} (${ep.permissionProfile})${runtime === defaultRuntime ? ' [default]' : ''}`);
    } catch (err) {
      log(`${runtimeLabel(runtime)} is not available: ${err instanceof Error ? err.message : 'error'}`);
    }
  }
  const auth = await app.client.auth.test();
  botUserId = typeof auth.user_id === 'string' ? auth.user_id : undefined;
  bridge.setBotUserId(botUserId);
  await app.start();
  const rearmed = bridge.recover();
  console.log(`amirobot connected via Socket Mode${rearmed ? ` (re-armed ${rearmed} thread watcher${rearmed === 1 ? '' : 's'})` : ''}`);
})().catch((err) => {
  log(`startup failed: ${err instanceof Error ? err.message : 'error'}`);
  process.exit(1);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    bridge.stop();
    app.stop().catch(() => undefined).finally(() => process.exit(0));
  });
}

