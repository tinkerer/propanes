import { modelCatalog } from './models';
import { createModelCatalog } from './model-discovery';
import { dirname, join } from 'node:path';
import { App, LogLevel } from '@slack/bolt';
import { downloaderFromToken } from './attachments';
import { SlackBridge, type IncomingSlackMessage } from './bridge';
import { configuredDefaultRuntime, resolveAgentEndpoint, runtimeLabel } from './agents';
import { defaultApp } from './apps';
import { createPropanesClient, createPropanesFetch } from './propanes';
import { PacedPoster, personaPoster, posterFromClient } from './slack';
import { infraTerminalAction, OPEN_INFRA_TERMINAL_ACTION } from './infra-actions';
import { BOT_NAME } from './name';
import { FileStateStore, StateRepo } from './state';
import { IdentityDirectory, type SlackIdentity } from './identities';
import { SlackRouter } from './router';

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
// Admin "Continue in Slack" requests open their thread here (a channel id, or
// a user id for a DM); unset = the conversation of the most recent thread.
const HANDOFF_CHANNEL = process.env.AMIROBOT_HANDOFF_CHANNEL || undefined;
// The server queue is polled (Socket Mode leaves the listener no inbound HTTP);
// the admin treats a listener silent for 30 s as disconnected.
const HANDOFF_POLL_MS = parseInt(process.env.AMIROBOT_HANDOFF_POLL_MS ?? '3000', 10) || 3000;
// systemd's StateDirectory= exports STATE_DIRECTORY; dev runs keep state next to the package.
const STATE_FILE = process.env.AMIROBOT_STATE_FILE
  ?? join(process.env.STATE_DIRECTORY ?? join(__dirname, '..', 'state'), 'amirobot-state.json');
// Linked users (Users page → Slack) each get their own state file here.
const USER_STATE_DIR = join(dirname(STATE_FILE), 'users');
// Unlinked Slack members act as the operator unless this is set; then they are refused.
const REQUIRE_LINK = /^(1|true|yes)$/i.test(process.env.SLACK_REQUIRE_LINK ?? '');
const IDENTITY_REFRESH_MS = 60_000;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  appToken: process.env.SLACK_APP_TOKEN!,
  socketMode: true,
  logLevel: LogLevel.WARN,
});

const propanesFetch = createPropanesFetch(PROPANES_URL, process.env.PROPANES_TOKEN);
const propanes = createPropanesClient(propanesFetch);
const state = new StateRepo(new FileStateStore(STATE_FILE));
const log = (message: string) => console.warn(`[${BOT_NAME}] ${message}`);
// Shared by every user's bridge: one pacing queue per channel, one model list
// (discovered from the operator's CLIs on this host).
const slack = new PacedPoster(posterFromClient(app.client as any));
const models = createModelCatalog({ extra: modelCatalog(process.env.AMIROBOT_MODELS_JSON) });
const files = downloaderFromToken(process.env.SLACK_BOT_TOKEN!);
const directory = new IdentityDirectory(propanesFetch, { log });

const bridge = new SlackBridge({
  propanes,
  models,
  slack,
  files,
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
    handoffChannel: HANDOFF_CHANNEL,
  },
  log,
});

let botUserId: string | undefined;

/** A linked user's bridge: their token, their apps and defaults, their state. */
function userBridge(identity: SlackIdentity): SlackBridge {
  const userLog = (message: string) => log(`[${identity.username}] ${message}`);
  return new SlackBridge({
    propanes: createPropanesClient(createPropanesFetch(PROPANES_URL, () => directory.token(identity.userId))),
    models,
    slack: personaPoster(slack, identity.persona, userLog),
    files,
    state: new StateRepo(new FileStateStore(join(USER_STATE_DIR, `${identity.userId}.json`))),
    config: {
      // Empty = the user's first application; `[app:<name>]` picks another.
      appId: '',
      publicUrl: PROPANES_PUBLIC_URL,
      botUserId,
      pollMs: POLL_MS,
      idlePollMs: IDLE_POLL_MS,
      idleStopMs: IDLE_STOP_MS,
      transcriptTail: 2000,
    },
    log: userLog,
  });
}

let router: SlackRouter | undefined;

// Handlers hand the event to the bridge and return at once, so Socket Mode
// acknowledgements never wait on dispatch, polling or Slack posting.
function enqueue(ev: IncomingSlackMessage): void {
  (router ?? bridge).handleEvent(ev).catch((err) => log(`event handling failed: ${err instanceof Error ? err.name : 'error'}`));
}

app.action(OPEN_INFRA_TERMINAL_ACTION, async ({ ack, body }) => {
  await ack();
  if (body.type !== 'block_actions') return;
  const action = infraTerminalAction(body);
  if (!action) return;
  (router ?? bridge).handleInfraTerminalAction(action).catch((err) => log(`terminal action failed: ${err instanceof Error ? err.name : 'error'}`));
});

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
  const me = await propanes.me();
  const apps = await propanes.listApplications();
  const defApp = defaultApp(apps, DEFAULT_APP, APP_ID);
  const unmatched = DEFAULT_APP && defApp.id === APP_ID && defApp.name.toLowerCase() !== DEFAULT_APP.toLowerCase();
  console.log(`[${BOT_NAME}] default application: ${defApp.name} (${defApp.id})${unmatched ? ` — PROPANES_DEFAULT_APP=${DEFAULT_APP} did not match, using PROPANES_APP_ID` : ''}; ${apps.length} registered`);
  const agents = await propanes.listAgents(defApp.id);
  const defaultRuntime = configuredDefaultRuntime(agents, defApp.id);
  for (const runtime of ['claude', 'codex'] as const) {
    try {
      const ep = resolveAgentEndpoint(agents, runtime, defApp.id, runtime === defaultRuntime ? AGENT_ENDPOINT_ID_OVERRIDE : undefined);
      console.log(`[${BOT_NAME}] ${runtimeLabel(runtime)} → ${ep.name || ep.id} (${ep.permissionProfile})${runtime === defaultRuntime ? ' [default]' : ''}`);
    } catch (err) {
      log(`${runtimeLabel(runtime)} is not available: ${err instanceof Error ? err.message : 'error'}`);
    }
  }
  const auth = await app.client.auth.test();
  botUserId = typeof auth.user_id === 'string' ? auth.user_id : undefined;
  await directory.refresh().catch((err) => log(`could not load Slack identity links: ${err instanceof Error ? err.message : 'error'}`));
  router = new SlackRouter({
    operator: bridge,
    operatorUserId: me.user.id,
    directory,
    createBridge: userBridge,
    slack,
    requireLink: REQUIRE_LINK,
  });
  router.setBotUserId(botUserId);
  const linked = directory.all().filter((i) => i.userId !== me.user.id);
  console.log(`[${BOT_NAME}] ${linked.length} linked user${linked.length === 1 ? '' : 's'}${linked.length ? `: ${linked.map((i) => i.username).join(', ')}` : ''}; unlinked Slack members ${REQUIRE_LINK ? 'are refused' : 'act as the operator'}`);
  await app.start();
  const rearmed = router.start();
  setInterval(() => { directory.refresh().catch(() => undefined); }, IDENTITY_REFRESH_MS).unref();
  pollHandoffs();
  console.log(`${BOT_NAME} connected via Socket Mode${rearmed ? ` (re-armed ${rearmed} thread watcher${rearmed === 1 ? '' : 's'})` : ''}`);
})().catch((err) => {
  log(`startup failed: ${err instanceof Error ? err.message : 'error'}`);
  process.exit(1);
});

let handoffTimer: NodeJS.Timeout | undefined;
let handoffFailures = 0;
function pollHandoffs(): void {
  propanes.claimHandoffs()
    .then(async (requests) => {
      if (handoffFailures) log('handoff queue reachable again');
      handoffFailures = 0;
      for (const req of requests) await bridge.handleHandoff(req);
    })
    .catch((err) => {
      // Log the first failure of a streak only; the poll runs every few seconds.
      if (handoffFailures++ === 0) log(`handoff poll failed: ${err instanceof Error ? err.message : 'error'}`);
    })
    .finally(() => { handoffTimer = setTimeout(pollHandoffs, HANDOFF_POLL_MS); });
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    (router ?? bridge).stop();
    if (handoffTimer) clearTimeout(handoffTimer);
    app.stop().catch(() => undefined).finally(() => process.exit(0));
  });
}

