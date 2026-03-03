import { ulid } from 'ulidx';
import { eq, and, sql } from 'drizzle-orm';
import { homedir } from 'node:os';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type {
  FeedbackItem,
  PermissionProfile,
  LaunchSession,
  LaunchHarnessSession,
  ImportSessionFiles,
  ImportSessionFilesResult,
  ExportSessionFiles,
  ExportSessionFilesResult,
} from '@prompt-widget/shared';
import { db, schema } from './db/index.js';
import { spawnAgentSession } from './agent-sessions.js';
import { getLauncher, addSessionToLauncher, sendAndWait } from './launcher-registry.js';
import { feedbackEvents } from './events.js';
import { extractArtifactPaths } from './routes/agent-sessions.js';

export function hydrateFeedback(row: typeof schema.feedbackItems.$inferSelect, tags: string[], screenshots: (typeof schema.feedbackScreenshots.$inferSelect)[]): FeedbackItem {
  return {
    ...row,
    type: row.type as FeedbackItem['type'],
    status: row.status as FeedbackItem['status'],
    data: row.data ? JSON.parse(row.data) : null,
    context: row.context ? JSON.parse(row.context) : null,
    appId: row.appId || null,
    tags,
    screenshots,
  };
}

export const DEFAULT_PROMPT_TEMPLATE = `do feedback item {{feedback.id}}

Title: {{feedback.title}}
{{feedback.description}}
URL: {{feedback.sourceUrl}}

App: {{app.name}}
Project dir: {{app.projectDir}}
App description: {{app.description}}

{{feedback.consoleLogs}}
{{feedback.networkErrors}}
{{feedback.data}}
{{instructions}}

{{feedback.screenshot}}`;

export function renderPromptTemplate(
  template: string,
  fb: FeedbackItem,
  app: { name: string; projectDir: string; description?: string; [key: string]: unknown } | null,
  instructions?: string
): string {
  let consoleLogs = '';
  if (fb.context?.consoleLogs?.length) {
    consoleLogs = 'Console logs:\n' + fb.context.consoleLogs.map(
      (l) => `  [${l.level.toUpperCase()}] ${l.message}`
    ).join('\n');
  }

  let networkErrors = '';
  if (fb.context?.networkErrors?.length) {
    networkErrors = 'Network errors:\n' + fb.context.networkErrors.map(
      (e) => `  ${e.method} ${e.url} → ${e.status} ${e.statusText}`
    ).join('\n');
  }

  let customData = '';
  if (fb.data) {
    customData = `Custom data: ${JSON.stringify(fb.data, null, 2)}`;
  }

  let screenshotText = '';
  if (fb.screenshots?.length) {
    screenshotText = fb.screenshots.map(
      (s) => `Screenshot: /api/v1/images/${s.id}`
    ).join('\n');
    screenshotText += '\n\nconsider screenshot';
  }

  const vars: Record<string, string> = {
    'feedback.id': fb.id,
    'feedback.title': fb.title || '',
    'feedback.description': fb.description || '',
    'feedback.sourceUrl': fb.sourceUrl || '',
    'feedback.tags': fb.tags?.join(', ') || '',
    'feedback.consoleLogs': consoleLogs,
    'feedback.networkErrors': networkErrors,
    'feedback.data': customData,
    'feedback.screenshot': screenshotText,
    'app.name': app?.name || '',
    'app.projectDir': app?.projectDir || '',
    'app.description': app?.description || '',
    'instructions': instructions || '',
  };

  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }

  result = result.replace(/\n{3,}/g, '\n\n');
  return result.trim();
}

export async function dispatchFeedbackToAgent(params: {
  feedbackId: string;
  agentEndpointId: string;
  instructions?: string;
  launcherId?: string;
}): Promise<{ dispatched: boolean; sessionId?: string; status: number; response: string; existing?: boolean }> {
  const { feedbackId, agentEndpointId, instructions, launcherId } = params;

  const [feedback, agent] = await Promise.all([
    db.query.feedbackItems.findFirst({
      where: eq(schema.feedbackItems.id, feedbackId),
    }),
    db.query.agentEndpoints.findFirst({
      where: eq(schema.agentEndpoints.id, agentEndpointId),
    }),
  ]);
  if (!feedback) throw new Error('Feedback not found');
  if (!agent) throw new Error('Agent endpoint not found');

  const tags = db
    .select()
    .from(schema.feedbackTags)
    .where(eq(schema.feedbackTags.feedbackId, feedbackId))
    .all()
    .map((t) => t.tag);
  const screenshots = db
    .select()
    .from(schema.feedbackScreenshots)
    .where(eq(schema.feedbackScreenshots.feedbackId, feedbackId))
    .all();

  const hydratedFeedback = hydrateFeedback(feedback, tags, screenshots);

  let app = null;
  if (feedback.appId) {
    const appRow = await db.query.applications.findFirst({
      where: eq(schema.applications.id, feedback.appId),
    });
    if (appRow) {
      app = { ...appRow, hooks: JSON.parse(appRow.hooks) };
    }
  }

  const mode = (agent.mode || 'webhook') as 'webhook' | 'headless' | 'interactive';

  if (mode !== 'webhook') {
    const existing = db
      .select()
      .from(schema.agentSessions)
      .where(
        and(
          eq(schema.agentSessions.feedbackId, feedbackId),
          sql`${schema.agentSessions.status} IN ('pending', 'running')`
        )
      )
      .get();

    if (existing) {
      return {
        dispatched: true,
        sessionId: existing.id,
        status: 200,
        response: `Existing active session: ${existing.id}`,
        existing: true,
      };
    }
  }

  if (mode === 'webhook') {
    const result = await dispatchWebhook(agent.url, agent.authHeader, {
      feedback: hydratedFeedback,
      instructions,
    });

    const now = new Date().toISOString();
    await db.update(schema.feedbackItems).set({
      status: 'dispatched',
      dispatchedTo: agent.name,
      dispatchedAt: now,
      dispatchStatus: result.status >= 200 && result.status < 300 ? 'success' : 'error',
      dispatchResponse: result.response.slice(0, 5000),
      updatedAt: now,
    }).where(eq(schema.feedbackItems.id, feedbackId));

    feedbackEvents.emit('updated', { id: feedbackId, appId: feedback.appId });

    return {
      dispatched: true,
      status: result.status,
      response: result.response.slice(0, 1000),
    };
  } else {
    const cwd = app?.projectDir || process.cwd();
    const permissionProfile = (agent.permissionProfile || 'interactive') as PermissionProfile;

    const template = agent.promptTemplate || DEFAULT_PROMPT_TEMPLATE;
    const prompt = renderPromptTemplate(template, hydratedFeedback, app, instructions);

    const { sessionId } = await dispatchAgentSession({
      feedbackId,
      agentEndpointId,
      prompt,
      cwd,
      permissionProfile,
      allowedTools: agent.allowedTools || (app as any)?.defaultAllowedTools || null,
      launcherId: launcherId || undefined,
    });

    const now = new Date().toISOString();
    db.update(schema.feedbackItems).set({
      status: 'dispatched',
      dispatchedTo: agent.name,
      dispatchedAt: now,
      dispatchStatus: 'running',
      dispatchResponse: `Agent session started: ${sessionId}`,
      updatedAt: now,
    }).where(eq(schema.feedbackItems.id, feedbackId)).run();

    feedbackEvents.emit('updated', { id: feedbackId, appId: feedback.appId });

    return {
      dispatched: true,
      sessionId,
      status: 200,
      response: `Agent session started: ${sessionId}`,
    };
  }
}

export async function dispatchWebhook(
  url: string,
  authHeader: string | null,
  payload: { feedback: FeedbackItem; instructions?: string }
): Promise<{ status: number; response: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authHeader) {
    headers['Authorization'] = authHeader;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  return { status: response.status, response: responseText };
}

export async function dispatchAgentSession(params: {
  feedbackId: string;
  agentEndpointId: string;
  prompt: string;
  cwd: string;
  permissionProfile: PermissionProfile;
  allowedTools?: string | null;
  launcherId?: string | null;
}): Promise<{ sessionId: string }> {
  const sessionId = ulid();
  const now = new Date().toISOString();
  const claudeSessionId = crypto.randomUUID();

  // Resolve launcher: explicit param > agent endpoint preference > harnessConfigId > local
  let targetLauncherId = params.launcherId || null;
  if (!targetLauncherId) {
    const agent = db
      .select()
      .from(schema.agentEndpoints)
      .where(eq(schema.agentEndpoints.id, params.agentEndpointId))
      .get();
    if (agent?.preferredLauncherId) {
      targetLauncherId = agent.preferredLauncherId;
    }
    // Try harnessConfigId — look up the harness config's connected launcher
    if (!targetLauncherId && agent?.harnessConfigId) {
      const harnessConfig = db
        .select()
        .from(schema.harnessConfigs)
        .where(eq(schema.harnessConfigs.id, agent.harnessConfigId))
        .get();
      if (harnessConfig?.launcherId) {
        targetLauncherId = harnessConfig.launcherId;
      }
    }
  }

  const launcher = targetLauncherId ? getLauncher(targetLauncherId) : undefined;

  db.insert(schema.agentSessions)
    .values({
      id: sessionId,
      feedbackId: params.feedbackId,
      agentEndpointId: params.agentEndpointId,
      permissionProfile: params.permissionProfile,
      status: 'pending',
      outputBytes: 0,
      launcherId: launcher ? launcher.id : null,
      claudeSessionId,
      createdAt: now,
    })
    .run();

  if (launcher && launcher.ws.readyState === 1) {
    // Route to remote launcher
    const msg: LaunchSession = {
      type: 'launch_session',
      sessionId,
      prompt: params.prompt,
      cwd: params.cwd,
      permissionProfile: params.permissionProfile,
      allowedTools: params.allowedTools,
      claudeSessionId,
      cols: 120,
      rows: 40,
    };
    try {
      launcher.ws.send(JSON.stringify(msg));
      addSessionToLauncher(launcher.id, sessionId);
      console.log(`[dispatch] Sent session ${sessionId} to launcher ${launcher.id}`);
    } catch (err) {
      console.error(`[dispatch] Failed to send to launcher, falling back to local:`, err);
      await spawnLocal(sessionId, { ...params, claudeSessionId });
    }
  } else {
    // Local spawn — await so errors propagate to the caller
    await spawnLocal(sessionId, { ...params, claudeSessionId });
  }

  return { sessionId };
}

async function spawnLocal(sessionId: string, params: {
  prompt?: string;
  cwd: string;
  permissionProfile: PermissionProfile;
  allowedTools?: string | null;
  claudeSessionId?: string;
  resumeSessionId?: string;
}): Promise<void> {
  try {
    await spawnAgentSession({
      sessionId,
      prompt: params.prompt,
      cwd: params.cwd,
      permissionProfile: params.permissionProfile,
      allowedTools: params.allowedTools,
      claudeSessionId: params.claudeSessionId,
      resumeSessionId: params.resumeSessionId,
    });
  } catch (err) {
    console.error(`Failed to spawn session ${sessionId}:`, err);
    db.update(schema.agentSessions)
      .set({ status: 'failed', completedAt: new Date().toISOString() })
      .where(eq(schema.agentSessions.id, sessionId))
      .run();
    throw err;
  }
}

export async function dispatchTerminalSession(params: {
  cwd: string;
  appId?: string | null;
  launcherId?: string | null;
}): Promise<{ sessionId: string }> {
  const sessionId = ulid();
  const now = new Date().toISOString();

  const launcher = params.launcherId ? getLauncher(params.launcherId) : undefined;

  db.insert(schema.agentSessions)
    .values({
      id: sessionId,
      feedbackId: null,
      agentEndpointId: null,
      permissionProfile: 'plain',
      status: 'pending',
      outputBytes: 0,
      launcherId: launcher ? launcher.id : null,
      createdAt: now,
    })
    .run();

  if (launcher && launcher.ws.readyState === 1) {
    // Look up machine's defaultCwd for the remote launcher
    let remoteCwd = '~';
    if (launcher.machineId) {
      const machine = db.select().from(schema.machines)
        .where(eq(schema.machines.id, launcher.machineId)).get();
      if (machine?.defaultCwd) remoteCwd = machine.defaultCwd;
    }
    const msg: LaunchSession = {
      type: 'launch_session',
      sessionId,
      prompt: '',
      cwd: remoteCwd,
      permissionProfile: 'plain',
      cols: 120,
      rows: 40,
    };
    try {
      launcher.ws.send(JSON.stringify(msg));
      addSessionToLauncher(launcher.id, sessionId);
      console.log(`[dispatch] Sent terminal session ${sessionId} to launcher ${launcher.id}`);
    } catch (err) {
      console.error(`[dispatch] Failed to send terminal to launcher, falling back to local:`, err);
      await spawnLocal(sessionId, { cwd: params.cwd, permissionProfile: 'plain' });
    }
  } else {
    try {
      await spawnAgentSession({
        sessionId,
        cwd: params.cwd,
        permissionProfile: 'plain',
      });
    } catch (err) {
      console.error(`Failed to spawn terminal session ${sessionId}:`, err);
      db.update(schema.agentSessions)
        .set({ status: 'failed', completedAt: new Date().toISOString() })
        .where(eq(schema.agentSessions.id, sessionId))
        .run();
      throw err;
    }
  }

  return { sessionId };
}

export async function dispatchCompanionTerminal(params: {
  parentSessionId: string;
  cwd: string;
}): Promise<{ sessionId: string }> {
  const sessionId = ulid();
  const now = new Date().toISOString();

  db.insert(schema.agentSessions)
    .values({
      id: sessionId,
      feedbackId: null,
      agentEndpointId: null,
      permissionProfile: 'plain',
      parentSessionId: params.parentSessionId,
      status: 'pending',
      outputBytes: 0,
      createdAt: now,
    })
    .run();

  try {
    await spawnAgentSession({
      sessionId,
      cwd: params.cwd,
      permissionProfile: 'plain',
    });
  } catch (err) {
    console.error(`Failed to spawn companion terminal ${sessionId}:`, err);
    db.update(schema.agentSessions)
      .set({ status: 'failed', completedAt: new Date().toISOString() })
      .where(eq(schema.agentSessions.id, sessionId))
      .run();
    throw err;
  }

  return { sessionId };
}

export async function dispatchTmuxAttachSession(params: {
  tmuxTarget: string;
  appId?: string | null;
}): Promise<{ sessionId: string }> {
  const sessionId = ulid();
  const now = new Date().toISOString();

  db.insert(schema.agentSessions)
    .values({
      id: sessionId,
      feedbackId: null,
      agentEndpointId: null,
      permissionProfile: 'plain',
      status: 'pending',
      outputBytes: 0,
      createdAt: now,
    })
    .run();

  try {
    await spawnAgentSession({
      sessionId,
      cwd: process.cwd(),
      permissionProfile: 'plain',
    });
  } catch (err) {
    console.error(`Failed to attach tmux session ${sessionId}:`, err);
    db.update(schema.agentSessions)
      .set({ status: 'failed', completedAt: new Date().toISOString() })
      .where(eq(schema.agentSessions.id, sessionId))
      .run();
    throw err;
  }

  return { sessionId };
}

export async function resumeAgentSession(parentSessionId: string, targetLauncherId?: string | null): Promise<{ sessionId: string }> {
  const parent = db
    .select()
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, parentSessionId))
    .get();

  if (!parent) {
    throw new Error('Parent session not found');
  }

  if (parent.status === 'running' || parent.status === 'pending') {
    throw new Error('Session is still active');
  }

  // Plain terminal sessions just spawn a new shell
  if (parent.permissionProfile === 'plain') {
    return dispatchTerminalSession({ cwd: process.cwd() });
  }

  if (!parent.agentEndpointId) {
    throw new Error('Agent endpoint not found');
  }
  if (!parent.feedbackId) {
    throw new Error('Original feedback not found');
  }

  const agent = db
    .select()
    .from(schema.agentEndpoints)
    .where(eq(schema.agentEndpoints.id, parent.agentEndpointId))
    .get();

  if (!agent) {
    throw new Error('Agent endpoint not found');
  }

  const feedbackRow = db
    .select()
    .from(schema.feedbackItems)
    .where(eq(schema.feedbackItems.id, parent.feedbackId))
    .get();

  if (!feedbackRow) {
    throw new Error('Original feedback not found');
  }

  let cwd = process.cwd();
  const resumeAppId = agent.appId || feedbackRow.appId;
  if (resumeAppId) {
    const appRow = db
      .select()
      .from(schema.applications)
      .where(eq(schema.applications.id, resumeAppId))
      .get();
    if (appRow?.projectDir) cwd = appRow.projectDir;
  }

  // Resolve target launcher: explicit param > agent preference > harness config > same as parent > local
  let resolvedLauncherId = targetLauncherId || null;
  if (!resolvedLauncherId) {
    if (agent.preferredLauncherId) {
      resolvedLauncherId = agent.preferredLauncherId;
    }
    if (!resolvedLauncherId && agent.harnessConfigId) {
      const harnessConfig = db
        .select()
        .from(schema.harnessConfigs)
        .where(eq(schema.harnessConfigs.id, agent.harnessConfigId))
        .get();
      if (harnessConfig?.launcherId) {
        resolvedLauncherId = harnessConfig.launcherId;
      }
    }
    // Fall back to same launcher as parent session
    if (!resolvedLauncherId && parent.launcherId) {
      resolvedLauncherId = parent.launcherId;
    }
  }

  const launcher = resolvedLauncherId ? getLauncher(resolvedLauncherId) : undefined;

  const sessionId = ulid();
  const now = new Date().toISOString();

  // Always resume in interactive mode so the user gets an immediate terminal
  const permissionProfile: PermissionProfile = 'interactive';

  // If parent has a Claude session ID, use --resume for full context restoration
  if (parent.claudeSessionId) {
    db.insert(schema.agentSessions)
      .values({
        id: sessionId,
        feedbackId: parent.feedbackId,
        agentEndpointId: parent.agentEndpointId,
        parentSessionId,
        permissionProfile,
        status: 'pending',
        outputBytes: 0,
        claudeSessionId: parent.claudeSessionId,
        launcherId: launcher ? launcher.id : null,
        createdAt: now,
      })
      .run();

    if (launcher && launcher.ws.readyState === 1) {
      const msg: LaunchSession = {
        type: 'launch_session',
        sessionId,
        prompt: '',
        cwd,
        permissionProfile,
        resumeSessionId: parent.claudeSessionId,
        cols: 120,
        rows: 40,
      };
      try {
        launcher.ws.send(JSON.stringify(msg));
        addSessionToLauncher(launcher.id, sessionId);
        console.log(`[dispatch] Sent resume session ${sessionId} to launcher ${launcher.id}`);
      } catch (err) {
        console.error(`[dispatch] Failed to send resume to launcher, falling back to local:`, err);
        await spawnLocal(sessionId, {
          prompt: '',
          cwd,
          permissionProfile,
          resumeSessionId: parent.claudeSessionId,
        });
      }
    } else {
      await spawnLocal(sessionId, {
        prompt: '',
        cwd,
        permissionProfile,
        resumeSessionId: parent.claudeSessionId,
      });
    }

    return { sessionId };
  }

  // Legacy fallback: no stored Claude session ID, use context-dump approach
  const claudeSessionId = crypto.randomUUID();
  const originalPrompt = `do feedback item ${parent.feedbackId}\n\nTitle: ${feedbackRow.title}${feedbackRow.description ? `\nDescription: ${feedbackRow.description}` : ''}`;

  const parentOutput = parent.outputLog || '';
  const outputTail = parentOutput.length > 4000
    ? '...(truncated)\n' + parentOutput.slice(-4000)
    : parentOutput;

  const resumePrompt = `You are resuming a task that a previous agent session worked on but did not fully complete. The user wants you to continue making progress.

Previous session output:
---
${outputTail}
---

Original task:
${originalPrompt}

IMPORTANT: The previous session may have made partial progress. Check the current state (git status, git diff, etc.) then continue working on anything that is still incomplete or broken. Do NOT just summarize what was done — actually do more work. If everything appears complete, verify by running tests or checking the build, and fix any issues you find.`;

  db.insert(schema.agentSessions)
    .values({
      id: sessionId,
      feedbackId: parent.feedbackId,
      agentEndpointId: parent.agentEndpointId,
      parentSessionId,
      permissionProfile,
      status: 'pending',
      outputBytes: 0,
      claudeSessionId,
      launcherId: launcher ? launcher.id : null,
      createdAt: now,
    })
    .run();

  if (launcher && launcher.ws.readyState === 1) {
    const msg: LaunchSession = {
      type: 'launch_session',
      sessionId,
      prompt: resumePrompt,
      cwd,
      permissionProfile,
      claudeSessionId,
      cols: 120,
      rows: 40,
    };
    try {
      launcher.ws.send(JSON.stringify(msg));
      addSessionToLauncher(launcher.id, sessionId);
    } catch (err) {
      console.error(`[dispatch] Failed to send to launcher, falling back to local:`, err);
      await spawnLocal(sessionId, { prompt: resumePrompt, cwd, permissionProfile, claudeSessionId });
    }
  } else {
    await spawnLocal(sessionId, { prompt: resumePrompt, cwd, permissionProfile, claudeSessionId });
  }

  return { sessionId };
}

export async function dispatchHarnessSession(params: {
  harnessConfigId: string;
  launcherId: string;
  prompt: string;
  composeDir?: string;
  serviceName?: string;
  permissionProfile: PermissionProfile;
}): Promise<{ sessionId: string }> {
  const sessionId = ulid();
  const now = new Date().toISOString();

  const launcher = getLauncher(params.launcherId);
  if (!launcher || launcher.ws.readyState !== 1) {
    throw new Error('Launcher is not connected');
  }

  db.insert(schema.agentSessions)
    .values({
      id: sessionId,
      feedbackId: null,
      agentEndpointId: null,
      permissionProfile: params.permissionProfile,
      status: 'pending',
      outputBytes: 0,
      launcherId: params.launcherId,
      createdAt: now,
    })
    .run();

  const msg: LaunchHarnessSession = {
    type: 'launch_harness_session',
    sessionId,
    harnessConfigId: params.harnessConfigId,
    prompt: params.prompt,
    composeDir: params.composeDir,
    serviceName: params.serviceName,
    permissionProfile: params.permissionProfile,
    cols: 120,
    rows: 40,
  };

  try {
    launcher.ws.send(JSON.stringify(msg));
    addSessionToLauncher(params.launcherId, sessionId);
    console.log(`[dispatch] Sent harness session ${sessionId} to launcher ${params.launcherId}`);
  } catch (err) {
    console.error(`[dispatch] Failed to send harness session to launcher:`, err);
    db.update(schema.agentSessions)
      .set({ status: 'failed', completedAt: new Date().toISOString() })
      .where(eq(schema.agentSessions.id, sessionId))
      .run();
    throw err;
  }

  return { sessionId };
}

// --- Session transfer across machines ---

export type TransferStatus = 'pending' | 'exporting' | 'importing' | 'launching' | 'completed' | 'failed';

export interface TransferState {
  id: string;
  status: TransferStatus;
  parentSessionId: string;
  targetLauncherId: string | null;
  sessionId: string | null;
  error: string | null;
  createdAt: string;
}

const activeTransfers = new Map<string, TransferState>();

export function getTransfer(transferId: string): TransferState | undefined {
  return activeTransfers.get(transferId);
}

function computeLocalJsonlPath(projectDir: string, claudeSessionId: string): string {
  const sanitized = projectDir.replaceAll('/', '-').replaceAll('.', '-');
  return `${homedir()}/.claude/projects/${sanitized}/${claudeSessionId}.jsonl`;
}

export async function transferSession(
  parentSessionId: string,
  targetLauncherId: string | null,
  targetCwd?: string,
): Promise<string> {
  const transferId = ulid();
  const transfer: TransferState = {
    id: transferId,
    status: 'pending',
    parentSessionId,
    targetLauncherId,
    sessionId: null,
    error: null,
    createdAt: new Date().toISOString(),
  };
  activeTransfers.set(transferId, transfer);

  // Run async — caller polls for status
  doTransfer(transfer, targetCwd).catch((err) => {
    transfer.status = 'failed';
    transfer.error = err.message;
  });

  return transferId;
}

async function doTransfer(transfer: TransferState, targetCwd?: string): Promise<void> {
  const parent = db
    .select()
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, transfer.parentSessionId))
    .get();

  if (!parent) throw new Error('Parent session not found');
  if (parent.status === 'running' || parent.status === 'pending') {
    throw new Error('Cannot transfer an active session');
  }
  if (!parent.claudeSessionId) throw new Error('Parent session has no claudeSessionId');

  // Resolve project dir
  let projectDir: string | null = null;
  if (parent.feedbackId) {
    const feedbackRow = db.select().from(schema.feedbackItems)
      .where(eq(schema.feedbackItems.id, parent.feedbackId)).get();
    if (feedbackRow?.appId) {
      const app = db.select().from(schema.applications)
        .where(eq(schema.applications.id, feedbackRow.appId)).get();
      if (app?.projectDir) projectDir = app.projectDir;
    }
  }
  if (!projectDir) throw new Error('Cannot determine project directory');

  const cwd = targetCwd || projectDir;
  const claudeSessionId = parent.claudeSessionId;
  const sourceLauncherId = parent.launcherId;

  // --- EXPORT phase ---
  transfer.status = 'exporting';

  let jsonlFiles: Array<{ relativePath: string; content: string }>;
  let artifactFiles: Array<{ path: string; content: string }>;

  if (sourceLauncherId) {
    // Source is remote — ask launcher to export
    const sourceLauncher = getLauncher(sourceLauncherId);
    if (!sourceLauncher || sourceLauncher.ws.readyState !== 1) {
      throw new Error(`Source launcher ${sourceLauncherId} is not connected`);
    }

    // First export just JSONL files (no artifact paths yet)
    const exportMsg: ExportSessionFiles = {
      type: 'export_session_files',
      sessionId: transfer.parentSessionId,
      claudeSessionId,
      projectDir,
      artifactPaths: [],
    };

    const exportResult = await sendAndWait(
      sourceLauncherId,
      exportMsg,
      'export_session_files_result',
      120_000,
    ) as ExportSessionFilesResult;

    if (!exportResult.ok) throw new Error(`Export failed: ${exportResult.error}`);

    jsonlFiles = exportResult.jsonlFiles || [];
    artifactFiles = exportResult.artifactFiles || [];

    // Parse JSONL for artifact paths and re-export with them
    const allContent = jsonlFiles.map(f => f.content).join('\n');
    const paths = extractArtifactPaths(allContent, projectDir);
    if (paths.length > 0) {
      const exportMsg2: ExportSessionFiles = {
        type: 'export_session_files',
        sessionId: transfer.parentSessionId,
        claudeSessionId,
        projectDir,
        artifactPaths: paths,
      };
      const exportResult2 = await sendAndWait(
        sourceLauncherId,
        exportMsg2,
        'export_session_files_result',
        120_000,
      ) as ExportSessionFilesResult;
      if (exportResult2.ok && exportResult2.artifactFiles) {
        artifactFiles = exportResult2.artifactFiles;
      }
    }
  } else {
    // Source is local — read from disk
    const jsonlPath = computeLocalJsonlPath(projectDir, claudeSessionId);
    jsonlFiles = [];

    if (existsSync(jsonlPath)) {
      jsonlFiles.push({
        relativePath: `${claudeSessionId}.jsonl`,
        content: readFileSync(jsonlPath, 'utf-8'),
      });
    }

    // Subagent files
    const subagentDir = jsonlPath.replace(/\.jsonl$/, '') + '/subagents';
    if (existsSync(subagentDir)) {
      for (const file of readdirSync(subagentDir).filter(f => f.endsWith('.jsonl'))) {
        jsonlFiles.push({
          relativePath: `${claudeSessionId}/subagents/${file}`,
          content: readFileSync(`${subagentDir}/${file}`, 'utf-8'),
        });
      }
    }

    // Continuations — other .jsonl files in same dir
    const sanitized = projectDir.replaceAll('/', '-').replaceAll('.', '-');
    const jsonlDir = `${homedir()}/.claude/projects/${sanitized}`;
    if (existsSync(jsonlDir)) {
      for (const file of readdirSync(jsonlDir)) {
        if (!file.endsWith('.jsonl') || file === `${claudeSessionId}.jsonl`) continue;
        jsonlFiles.push({
          relativePath: file,
          content: readFileSync(`${jsonlDir}/${file}`, 'utf-8'),
        });
      }
    }

    // Extract artifact paths from JSONL
    const allContent = jsonlFiles.map(f => f.content).join('\n');
    const paths = extractArtifactPaths(allContent, projectDir);
    artifactFiles = [];
    for (const relPath of paths) {
      const full = resolve(projectDir, relPath);
      if (!full.startsWith(projectDir)) continue;
      if (existsSync(full)) {
        try {
          artifactFiles.push({ path: relPath, content: readFileSync(full, 'utf-8') });
        } catch { /* skip */ }
      }
    }
  }

  if (jsonlFiles.length === 0) {
    throw new Error('No JSONL files found for session');
  }

  // --- IMPORT phase ---
  transfer.status = 'importing';

  const targetLauncher = transfer.targetLauncherId ? getLauncher(transfer.targetLauncherId) : undefined;

  if (targetLauncher && targetLauncher.ws.readyState === 1) {
    // Target is remote — send files to launcher
    const importMsg: ImportSessionFiles = {
      type: 'import_session_files',
      sessionId: transfer.parentSessionId,
      claudeSessionId,
      projectDir: cwd,
      jsonlFiles,
      artifactFiles,
    };

    const importResult = await sendAndWait(
      transfer.targetLauncherId!,
      importMsg,
      'import_session_files_result',
      120_000,
    ) as ImportSessionFilesResult;

    if (!importResult.ok) throw new Error(`Import failed: ${importResult.error}`);
    console.log(`[transfer] Imported ${importResult.jsonlFilesWritten} JSONL + ${importResult.artifactFilesWritten} artifacts to ${transfer.targetLauncherId}`);
  } else if (!transfer.targetLauncherId) {
    // Target is local — write files to disk
    const sanitized = cwd.replaceAll('/', '-').replaceAll('.', '-');
    const jsonlDir = `${homedir()}/.claude/projects/${sanitized}`;

    for (const f of jsonlFiles) {
      const target = resolve(jsonlDir, f.relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content, 'utf-8');
    }

    for (const f of artifactFiles) {
      const target = resolve(cwd, f.path);
      if (!target.startsWith(cwd)) continue;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content, 'utf-8');
    }

    console.log(`[transfer] Wrote ${jsonlFiles.length} JSONL + ${artifactFiles.length} artifacts locally`);
  } else {
    throw new Error(`Target launcher ${transfer.targetLauncherId} is not connected`);
  }

  // --- LAUNCH phase ---
  transfer.status = 'launching';

  const { sessionId } = await resumeAgentSession(transfer.parentSessionId, transfer.targetLauncherId);
  transfer.sessionId = sessionId;
  transfer.status = 'completed';
  console.log(`[transfer] Transfer ${transfer.id} completed — new session ${sessionId}`);
}
