import { App } from '@slack/bolt';

const PROPANES_URL = process.env.PROPANES_URL ?? 'http://localhost:3001';
// Public-facing URL used in Slack messages. Defaults to PROPANES_URL but can
// be overridden when the server is reached internally but users click links
// from outside (e.g. PROPANES_URL=http://localhost:3001 but
// PROPANES_PUBLIC_URL=http://20.65.8.179:3001).
const PROPANES_PUBLIC_URL = process.env.PROPANES_PUBLIC_URL ?? PROPANES_URL;
const APP_ID = process.env.PROPANES_APP_ID ?? '01KNR6HYSPE08RZJSQJG6WE1PK';
// Optional override. When unset, the bot auto-picks a yolo/headless-profile
// agent for APP_ID at startup so it dispatches with --dangerously-skip-permissions.
const AGENT_ENDPOINT_ID_OVERRIDE = process.env.AGENT_ENDPOINT_ID;
const POLL_MS = parseInt(process.env.POLL_MS ?? '20000');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  appToken: process.env.SLACK_APP_TOKEN!,
  socketMode: true,
  logLevel: 'warn',
});

// Instructions appended to every dispatch so the implementation agent replies
// to the Slack thread right away with a one-line understanding + ETA before
// starting tool work. Those two lines get forwarded by the polling loop as
// soon as they show up in the session output.
const ACK_INSTRUCTIONS = `

[SLACK ACK PROTOCOL]
Before you do any tool calls, print exactly two short lines to stdout so the Slack bot can forward them to the operator:
  Understood: <restate the ask in one sentence>
  ETA: <looking now | ~30s | ~2min | ~10min | multi-step>
Then proceed with the work. These two lines show the operator you received the request and roughly how long this will take. Keep each line on a single line.
[/SLACK ACK PROTOCOL]`;

async function propanesFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`${PROPANES_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) throw new Error(`Propanes ${path} → ${res.status}`);
  return res.json() as Promise<any>;
}

async function submitFeedback(title: string, description: string) {
  return propanesFetch('/api/v1/feedback', {
    method: 'POST',
    body: JSON.stringify({ title, description, type: 'manual', appId: APP_ID, tags: ['slack', 'amirobot'] }),
  });
}

// Prefer interactive-yolo (TTY + skip permissions), fall back to any other
// *-yolo profile. All of these pass --dangerously-skip-permissions so the
// session never pauses on prompts. Mirrors pickYoloAgent in
// packages/admin/src/components/QuickDispatchPopup.tsx.
async function pickYoloAgent(appId: string): Promise<string> {
  const agents: any[] = await propanesFetch(`/api/v1/admin/agents?appId=${appId}`);
  const usable = agents.filter((a) => a.mode !== 'webhook' || !!a.url);
  for (const profile of ['interactive-yolo', 'headless-yolo', 'headless-stream-yolo'] as const) {
    const match = (a: any) => a.permissionProfile === profile;
    const hit = usable.find((a) => match(a) && a.isDefault && a.appId === appId)
      || usable.find((a) => match(a) && a.isDefault && !a.appId)
      || usable.find((a) => match(a) && a.appId === appId)
      || usable.find(match);
    if (hit) return hit.id;
  }
  throw new Error(`No skip-permissions (*-yolo) agent found for app ${appId}`);
}

let cachedAgentEndpointId: string | null = null;
async function resolveAgentEndpointId(): Promise<string> {
  if (AGENT_ENDPOINT_ID_OVERRIDE) return AGENT_ENDPOINT_ID_OVERRIDE;
  if (cachedAgentEndpointId) return cachedAgentEndpointId;
  cachedAgentEndpointId = await pickYoloAgent(APP_ID);
  return cachedAgentEndpointId;
}

async function dispatchSession(feedbackId: string, instructions?: string) {
  const agentEndpointId = await resolveAgentEndpointId();
  const fullInstructions = (instructions || '') + ACK_INSTRUCTIONS;
  // Force yolo regardless of the chosen agent's default — ACK_INSTRUCTIONS relies
  // on the session running to completion without pausing on permission prompts.
  return propanesFetch('/api/v1/admin/dispatch', {
    method: 'POST',
    body: JSON.stringify({
      feedbackId,
      agentEndpointId,
      instructions: fullInstructions,
      permissionProfile: 'interactive-yolo',
    }),
  });
}

async function killSessionApi(sessionId: string) {
  return propanesFetch(`/api/v1/admin/agent-sessions/${sessionId}/kill`, { method: 'POST' });
}

async function resumeSessionApi(sessionId: string, additionalPrompt: string) {
  return propanesFetch(`/api/v1/admin/agent-sessions/${sessionId}/resume`, {
    method: 'POST',
    body: JSON.stringify({
      additionalPrompt: additionalPrompt + ACK_INSTRUCTIONS,
      permissionProfile: 'interactive-yolo',
    }),
  });
}

function sessionUrl(sessionId: string): string {
  return `${PROPANES_PUBLIC_URL}/admin/#/session/${sessionId}`;
}

async function getSession(sessionId: string) {
  return propanesFetch(`/api/v1/admin/agent-sessions/${sessionId}`);
}

function extractCosReply(output: string): string | null {
  // Concatenate every closed <cos-reply> block — the ack protocol emits one
  // early (understanding+ETA) and one late (final answer), both belong in the
  // thread reply when the session completes.
  const re = /<cos-reply(?:\s[^>]*)?>([\s\S]*?)<\/cos-reply>/g;
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const t = m[1].trim();
    if (t) parts.push(t);
  }
  if (parts.length === 0) return null;
  return parts.join('\n\n');
}

function tailOutput(output: string, maxChars = 800): string {
  if (output.length <= maxChars) return output;
  return '…' + output.slice(-maxChars);
}

// Tracks the currently-running agent session per Slack conversation so
// follow-up messages can stop/resume it. For channel @mentions the key is
// the Slack thread_ts; for DMs it's the channel id (DMs are flat).
// postThreadTs is the Slack thread_ts used for every posted update for this
// session — fixed for the duration of the session so progress messages stay
// grouped in one thread.
type ThreadState = {
  sessionId: string;
  feedbackId: string;
  channel: string;
  postThreadTs: string;
  pollAbort: { stopped: boolean };
};
const inFlightByThread = new Map<string, ThreadState>();

function isStopKeyword(text: string): boolean {
  return /^\s*(stop|halt|cancel|kill)\s*\.?\s*$/i.test(text);
}

async function pollAndReport(
  client: any,
  threadKey: string,
  state: ThreadState,
) {
  const { sessionId, channel, postThreadTs } = state;
  let lastBytesSeen = 0;
  let pollCount = 0;
  const maxPolls = 90; // ~30 min at 20s

  while (pollCount < maxPolls) {
    await new Promise(r => setTimeout(r, POLL_MS));
    pollCount++;

    // If another handler marked this poll as aborted (stop / resume), bail.
    if (state.pollAbort.stopped) return;

    let session: any;
    try {
      session = await getSession(sessionId);
    } catch {
      continue;
    }

    const output: string = session.output ?? '';
    const newBytes = output.length - lastBytesSeen;

    if (newBytes > 200) {
      lastBytesSeen = output.length;
      const snippet = tailOutput(output);
      await client.chat.postMessage({
        channel,
        thread_ts: postThreadTs,
        text: `\`[${session.status}]\` +${newBytes} bytes\n\`\`\`\n${snippet}\n\`\`\``,
      });
    }

    if (
      session.status === 'completed' ||
      session.status === 'failed' ||
      session.status === 'cancelled' ||
      session.status === 'killed'
    ) {
      // Clear in-flight tracking only if we're still the current session for
      // this thread — a concurrent resume/stop may have already replaced it.
      const current = inFlightByThread.get(threadKey);
      if (current && current.sessionId === sessionId) {
        inFlightByThread.delete(threadKey);
      }
      const sessionLink = `<${sessionUrl(sessionId)}|\`${sessionId}\`>`;
      const cosReply = extractCosReply(output);
      if (cosReply) {
        await client.chat.postMessage({
          channel,
          thread_ts: postThreadTs,
          text: `${cosReply}\n\n_Session: ${sessionLink}_`,
        });
      } else {
        const summary = output.length > 0 ? tailOutput(output, 1200) : '(no output)';
        await client.chat.postMessage({
          channel,
          thread_ts: postThreadTs,
          text: `Session ${sessionLink} ${session.status}.\n\`\`\`\n${summary}\n\`\`\``,
        });
      }
      return;
    }
  }

  if (pollCount >= maxPolls) {
    const current = inFlightByThread.get(threadKey);
    if (current && current.sessionId === sessionId) {
      inFlightByThread.delete(threadKey);
    }
    await client.chat.postMessage({
      channel,
      thread_ts: postThreadTs,
      text: `Session <${sessionUrl(sessionId)}|\`${sessionId}\`> still running after 30 min — stopping poll.`,
    });
  }
}

async function handleIncoming(
  client: any,
  threadKey: string,
  channel: string,
  postThreadTs: string,
  text: string,
) {
  const existing = inFlightByThread.get(threadKey);

  // "stop" keyword: kill the in-flight session if any.
  if (isStopKeyword(text)) {
    if (existing) {
      existing.pollAbort.stopped = true;
      inFlightByThread.delete(threadKey);
      try {
        await killSessionApi(existing.sessionId);
      } catch {
        /* already dead or not running */
      }
      await client.chat.postMessage({
        channel,
        thread_ts: existing.postThreadTs,
        text: `Stopped session <${sessionUrl(existing.sessionId)}|\`${existing.sessionId}\`>.`,
      });
    } else {
      await client.chat.postMessage({
        channel,
        thread_ts: postThreadTs,
        text: 'Nothing running to stop.',
      });
    }
    return;
  }

  // Follow-up message while a session is in flight: resume with the new
  // message so context carries over. Post the update in the SAME Slack thread
  // as the original session.
  if (existing) {
    existing.pollAbort.stopped = true;
    inFlightByThread.delete(threadKey);
    try {
      // Killing the running session before resuming keeps just one live proc
      // per thread — resumeSession launches a new one immediately.
      await killSessionApi(existing.sessionId).catch(() => { /* may already be done */ });
      const result = await resumeSessionApi(existing.sessionId, text);
      const newSessionId = result.sessionId ?? result.id;
      if (!newSessionId) throw new Error('resume did not return a sessionId');
      const newState: ThreadState = {
        sessionId: newSessionId,
        feedbackId: existing.feedbackId,
        channel: existing.channel,
        postThreadTs: existing.postThreadTs,
        pollAbort: { stopped: false },
      };
      inFlightByThread.set(threadKey, newState);
      await client.chat.postMessage({
        channel: existing.channel,
        thread_ts: existing.postThreadTs,
        text: `Resuming with your new message → <${sessionUrl(newSessionId)}|\`${newSessionId}\`>`,
      });
      pollAndReport(client, threadKey, newState).catch(console.error);
    } catch (err: any) {
      await client.chat.postMessage({
        channel: existing.channel,
        thread_ts: existing.postThreadTs,
        text: `Resume failed: ${err.message}`,
      });
    }
    return;
  }

  // Fresh thread: dispatch a new session.
  await client.chat.postMessage({
    channel,
    thread_ts: postThreadTs,
    text: `On it. Spinning up a session for: _${text.substring(0, 120)}_`,
  });

  let feedbackId: string;
  let sessionId: string;
  try {
    const feedback = await submitFeedback(`Slack: ${text.substring(0, 80)}`, text);
    feedbackId = feedback.id;
    const dispatch = await dispatchSession(feedbackId, text);
    sessionId = dispatch.sessionId ?? dispatch.id;
    await client.chat.postMessage({
      channel,
      thread_ts: postThreadTs,
      text: `Session launched: <${sessionUrl(sessionId)}|\`${sessionId}\`> — polling every ${POLL_MS / 1000}s. Reply \`stop\` to kill.`,
    });
  } catch (err: any) {
    await client.chat.postMessage({
      channel,
      thread_ts: postThreadTs,
      text: `Failed to dispatch: ${err.message}`,
    });
    return;
  }

  const state: ThreadState = {
    sessionId,
    feedbackId,
    channel,
    postThreadTs,
    pollAbort: { stopped: false },
  };
  inFlightByThread.set(threadKey, state);
  pollAndReport(client, threadKey, state).catch(console.error);
}

// Handle @mentions
app.event('app_mention', async ({ event, client }) => {
  const text = ((event as any).text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim();
  const threadTs = (event as any).thread_ts ?? event.ts;
  const channel = (event as any).channel;
  if (!text) return;
  handleIncoming(client, threadTs, channel, threadTs, text).catch(console.error);
});

// Handle DMs. DMs are flat — key in-flight state by channel so follow-up
// DMs route to the same session. Slack posts still use each new message's
// ts as its thread anchor (normal DM behaviour).
app.message(async ({ message, client }) => {
  if ((message as any).channel_type !== 'im') return;
  // Ignore echoes from other bots (including our own).
  if ((message as any).subtype === 'bot_message' || (message as any).bot_id) return;
  const text = ((message as any).text ?? '').trim();
  if (!text) return;
  const channel = (message as any).channel;
  const parentTs = (message as any).thread_ts;
  const threadKey = parentTs ?? `dm:${channel}`;
  const postThreadTs = parentTs ?? (message as any).ts;
  handleIncoming(client, threadKey, channel, postThreadTs, text).catch(console.error);
});

(async () => {
  await app.start();
  console.log('amirobot connected via Socket Mode');
})();
