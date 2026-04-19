import { ulid } from 'ulidx';
import { eq, and, sql } from 'drizzle-orm';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import type {
  AgentRuntime,
  FeedbackItem,
  PermissionProfile,
  LaunchSession,
  LaunchHarnessSession,
  ImportSessionFiles,
  ImportSessionFilesResult,
  ExportSessionFiles,
  ExportSessionFilesResult,
  SyncCodebase,
  SyncCodebaseResult,
  SyncCodebaseToContainer,
  SyncCodebaseToContainerResult,
} from '@propanes/shared';
import { db, schema } from './db/index.js';
import { spawnAgentSession } from './agent-sessions.js';
import { getLauncher, addSessionToLauncher, sendAndWait } from './launcher-registry.js';
import { feedbackEvents } from './events.js';
import { getSession } from './sessions.js';
import { extractArtifactPaths, exportSessionFiles } from './jsonl-utils.js';
import { launchSpriteSession } from './sprite-sessions.js';

export function hydrateFeedback(row: typeof schema.feedbackItems.$inferSelect, tags: string[], screenshots: (typeof schema.feedbackScreenshots.$inferSelect)[], audioFiles: (typeof schema.feedbackAudio.$inferSelect)[] = []): FeedbackItem {
  let titleHistory: FeedbackItem['titleHistory'] = [];
  if (row.titleHistory) {
    try {
      const parsed = JSON.parse(row.titleHistory);
      if (Array.isArray(parsed)) titleHistory = parsed;
    } catch { /* ignore malformed */ }
  }
  return {
    ...row,
    type: row.type as FeedbackItem['type'],
    status: row.status as FeedbackItem['status'],
    data: row.data ? JSON.parse(row.data) : null,
    context: row.context ? JSON.parse(row.context) : null,
    appId: row.appId || null,
    tags,
    screenshots,
    audioFiles,
    titleHistory,
  };
}

export const DEFAULT_PROMPT_TEMPLATE = `Feedback: {{feedback.url}}

Title: {{feedback.title}}
{{feedback.description}}
URL: {{feedback.sourceUrl}}

App: {{app.name}}
Project dir: {{app.projectDir}}
App description: {{app.description}}

{{feedback.consoleLogs}}
{{feedback.networkErrors}}
{{feedback.data}}
{{instructions}}`;

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
  }

  // Look up live widget session for real-time URL/viewport
  const liveSession = fb.sessionId ? getSession(fb.sessionId) : undefined;

  const publicBaseUrl = (process.env.PW_PUBLIC_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');

  const vars: Record<string, string> = {
    'feedback.id': fb.id,
    'feedback.url': `${publicBaseUrl}/api/v1/admin/feedback/${fb.id}`,
    'feedback.title': fb.title || '',
    'feedback.description': fb.description || '',
    'feedback.sourceUrl': fb.sourceUrl || '',
    'feedback.tags': fb.tags?.join(', ') || '',
    'feedback.consoleLogs': consoleLogs,
    'feedback.networkErrors': networkErrors,
    'feedback.data': customData,
    'feedback.screenshot': screenshotText,
    'app.id': String(app?.id || ''),
    'app.name': app?.name || '',
    'app.projectDir': app?.projectDir || '',
    'app.description': app?.description || '',
    'app.hooks': app?.hooks ? (typeof app.hooks === 'string' ? app.hooks : JSON.stringify(app.hooks)) : '',
    'session.url': liveSession?.url || fb.sourceUrl || '',
    'session.viewport': liveSession?.viewport || fb.viewport || '',
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
  harnessConfigId?: string;
}): Promise<{ dispatched: boolean; sessionId?: string; status: number; response: string; existing?: boolean }> {
  const { feedbackId, agentEndpointId, instructions, launcherId, harnessConfigId: explicitHarnessConfigId } = params;

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
  const runtime = (agent.runtime || 'claude') as AgentRuntime;

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
    if (!agent.url) throw new Error('Agent endpoint has mode "webhook" but no URL configured');
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
    const isHarness = !!(explicitHarnessConfigId || agent.harnessConfigId);
    const permissionProfile: PermissionProfile = isHarness
      ? 'yolo'
      : (agent.permissionProfile || 'interactive') as PermissionProfile;

    const template = agent.promptTemplate || DEFAULT_PROMPT_TEMPLATE;
    const prompt = renderPromptTemplate(template, hydratedFeedback, app, instructions);

    const { sessionId } = await dispatchAgentSession({
      feedbackId,
      agentEndpointId,
      prompt,
      cwd,
      runtime,
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

// --- Code sync: push local changes to a temp branch, have remote launcher fetch ---

function isGitRepo(dir: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function getGitRemoteUrl(dir: string): string | null {
  try {
    return execSync('git remote get-url origin', { cwd: dir, stdio: 'pipe' }).toString().trim();
  } catch {
    return null;
  }
}

export function pushSyncBranch(projectDir: string, sessionId: string): { branch: string; remoteUrl: string } {
  const branch = `pw-sync/${sessionId}`;
  const remoteUrl = getGitRemoteUrl(projectDir);
  if (!remoteUrl) throw new Error('No git remote "origin" configured');

  // Create a temporary index to snapshot all files (including uncommitted/untracked)
  // without touching the user's working tree or index
  const tmpIdx = execSync('mktemp', { stdio: 'pipe' }).toString().trim();
  try {
    execSync(`cp .git/index "${tmpIdx}"`, { cwd: projectDir, stdio: 'pipe' });

    const env = { ...process.env, GIT_INDEX_FILE: tmpIdx };
    execSync('git add -A', { cwd: projectDir, stdio: 'pipe', env });
    const tree = execSync('git write-tree', { cwd: projectDir, stdio: 'pipe', env }).toString().trim();

    const head = execSync('git rev-parse HEAD', { cwd: projectDir, stdio: 'pipe' }).toString().trim();
    const commit = execSync(
      `git commit-tree ${tree} -p ${head} -m "pw-sync: auto-sync for dispatch ${sessionId}"`,
      { cwd: projectDir, stdio: 'pipe' }
    ).toString().trim();

    execSync(`git push origin "${commit}:refs/heads/${branch}" --force`, {
      cwd: projectDir,
      stdio: 'pipe',
      timeout: 120_000,
    });

    return { branch, remoteUrl };
  } finally {
    try { execSync(`rm -f "${tmpIdx}"`, { stdio: 'pipe' }); } catch {}
  }
}

export async function syncCodebaseToLauncher(
  launcherId: string,
  sessionId: string,
  branch: string,
  projectDir: string,
  gitRemoteUrl: string,
): Promise<void> {
  const msg: SyncCodebase & { sessionId: string } = {
    type: 'sync_codebase',
    sessionId,
    branch,
    projectDir,
    gitRemoteUrl,
  };

  const result = await sendAndWait(launcherId, msg, 'sync_codebase_result', 120_000) as SyncCodebaseResult;
  if (!result.ok) {
    throw new Error(`Code sync failed on launcher ${launcherId}: ${result.error}`);
  }
}

export function cleanupSyncBranch(projectDir: string, sessionId: string): void {
  const branch = `pw-sync/${sessionId}`;
  try {
    execSync(`git push origin --delete "${branch}"`, {
      cwd: projectDir,
      stdio: 'pipe',
      timeout: 30_000,
    });
    console.log(`[dispatch] Cleaned up sync branch ${branch}`);
  } catch (err: any) {
    console.warn(`[dispatch] Failed to cleanup sync branch ${branch}: ${err.message}`);
  }
}

export async function dispatchAgentSession(params: {
  feedbackId: string;
  agentEndpointId: string;
  prompt: string;
  cwd: string;
  runtime?: AgentRuntime;
  permissionProfile: PermissionProfile;
  allowedTools?: string | null;
  launcherId?: string | null;
}): Promise<{ sessionId: string }> {
  const sessionId = ulid();
  const now = new Date().toISOString();
  const claudeSessionId = crypto.randomUUID();

  // Check if explicit launcherId is a sprite target
  if (params.launcherId?.startsWith('sprite:')) {
    const spriteConfigId = params.launcherId.slice('sprite:'.length);
    const spriteConfig = db
      .select()
      .from(schema.spriteConfigs)
      .where(eq(schema.spriteConfigs.id, spriteConfigId))
      .get();
    if (spriteConfig) {
      return dispatchSpriteSession({
        sessionId,
        feedbackId: params.feedbackId,
        agentEndpointId: params.agentEndpointId,
        spriteConfigId,
        spriteName: spriteConfig.spriteName,
        token: spriteConfig.token,
        prompt: params.prompt,
        cwd: spriteConfig.defaultCwd || params.cwd,
        runtime: params.runtime || 'claude',
        permissionProfile: params.permissionProfile,
        allowedTools: params.allowedTools,
        claudeSessionId,
      });
    }
  }

  // Load agent endpoint once for launcher resolution and harness detection
  const agent = db
    .select()
    .from(schema.agentEndpoints)
    .where(eq(schema.agentEndpoints.id, params.agentEndpointId))
    .get();
  const runtime: AgentRuntime = params.runtime || (agent?.runtime as AgentRuntime | undefined) || 'claude';

  // Resolve launcher: explicit param > agent endpoint preference > harnessConfigId > local
  let targetLauncherId = params.launcherId || null;
  let harnessConfig: typeof schema.harnessConfigs.$inferSelect | undefined;

  if (!targetLauncherId) {
    if (agent?.preferredLauncherId) {
      targetLauncherId = agent.preferredLauncherId;
    }
    // Try harnessConfigId — look up the harness config's connected launcher
    if (!targetLauncherId && agent?.harnessConfigId) {
      harnessConfig = db
        .select()
        .from(schema.harnessConfigs)
        .where(eq(schema.harnessConfigs.id, agent.harnessConfigId))
        .get();
      if (harnessConfig?.launcherId) {
        targetLauncherId = harnessConfig.launcherId;
      }
    }

    // Try spriteConfigId — dispatch to sprite instead of launcher
    if (!targetLauncherId && agent?.spriteConfigId) {
      const spriteConfig = db
        .select()
        .from(schema.spriteConfigs)
        .where(eq(schema.spriteConfigs.id, agent.spriteConfigId))
        .get();
      if (spriteConfig) {
        return dispatchSpriteSession({
          sessionId,
          feedbackId: params.feedbackId,
          agentEndpointId: params.agentEndpointId,
          spriteConfigId: agent.spriteConfigId,
          spriteName: spriteConfig.spriteName,
          token: spriteConfig.token,
          prompt: params.prompt,
          cwd: spriteConfig.defaultCwd || params.cwd,
          runtime,
          permissionProfile: params.permissionProfile,
          allowedTools: params.allowedTools,
          claudeSessionId,
        });
      }
    }
  }

  // If agent has a harnessConfigId, route through harness dispatch (docker compose exec)
  if (agent?.harnessConfigId) {
    if (!harnessConfig) {
      harnessConfig = db
        .select()
        .from(schema.harnessConfigs)
        .where(eq(schema.harnessConfigs.id, agent.harnessConfigId))
        .get();
    }
    if (harnessConfig && targetLauncherId) {
      return dispatchHarnessSession({
        harnessConfigId: harnessConfig.id,
        launcherId: targetLauncherId,
        prompt: params.prompt,
        composeDir: harnessConfig.composeDir || undefined,
        runtime,
        permissionProfile: params.permissionProfile,
        feedbackId: params.feedbackId,
        agentEndpointId: params.agentEndpointId,
        claudeSessionId,
        cwd: params.cwd,
      });
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
      cwd: params.cwd || null,
      createdAt: now,
    })
    .run();

  // Fire-and-forget: return sessionId immediately so UI can open the tab.
  // The session is already in 'pending' status in the DB.
  if (launcher && launcher.ws.readyState === 1) {
    (async () => {
      // Sync codebase to remote before launching
      if (isGitRepo(params.cwd)) {
        try {
          const { branch, remoteUrl } = pushSyncBranch(params.cwd, sessionId);
          await syncCodebaseToLauncher(launcher.id, sessionId, branch, params.cwd, remoteUrl);
          console.log(`[dispatch] Synced codebase to launcher ${launcher.id} via branch ${branch}`);
        } catch (err: any) {
          console.warn(`[dispatch] Code sync failed, proceeding without sync: ${err.message}`);
        }
      }

      // Route to remote launcher
      const msg: LaunchSession = {
        type: 'launch_session',
        sessionId,
        prompt: params.prompt,
        cwd: params.cwd,
          runtime,
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
        spawnLocal(sessionId, { ...params, claudeSessionId }).catch(() => {});
      }
    })().catch((err) => {
      console.error(`[dispatch] Async remote launch failed for ${sessionId}:`, err);
    });
  } else {
    // Local spawn — fire-and-forget, errors are handled in spawnLocal
    spawnLocal(sessionId, { ...params, claudeSessionId }).catch(() => {});
  }

  return { sessionId };
}

async function spawnLocal(sessionId: string, params: {
  prompt?: string;
  cwd: string;
  runtime?: AgentRuntime;
  permissionProfile: PermissionProfile;
  allowedTools?: string | null;
  claudeSessionId?: string;
  resumeSessionId?: string;
}): Promise<void> {
  try {
    const runtime = params.runtime || 'claude';
    await spawnAgentSession({
      sessionId,
      prompt: params.prompt,
      cwd: params.cwd,
      runtime,
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
  permissionProfile?: PermissionProfile;
}): Promise<{ sessionId: string }> {
  const sessionId = ulid();
  const now = new Date().toISOString();
  const profile: PermissionProfile = params.permissionProfile || 'plain';

  const launcher = params.launcherId ? getLauncher(params.launcherId) : undefined;

  db.insert(schema.agentSessions)
    .values({
      id: sessionId,
      feedbackId: null,
      agentEndpointId: null,
      permissionProfile: profile,
      status: 'pending',
      outputBytes: 0,
      launcherId: launcher ? launcher.id : null,
      cwd: params.cwd || null,
      createdAt: now,
    })
    .run();

  // Fire-and-forget: return sessionId immediately so UI can open the tab
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
      permissionProfile: profile,
      cols: 120,
      rows: 40,
    };
    try {
      launcher.ws.send(JSON.stringify(msg));
      addSessionToLauncher(launcher.id, sessionId);
      console.log(`[dispatch] Sent terminal session ${sessionId} to launcher ${launcher.id} (profile=${profile})`);
    } catch (err) {
      console.error(`[dispatch] Failed to send terminal to launcher, falling back to local:`, err);
      spawnLocal(sessionId, { cwd: params.cwd, permissionProfile: profile }).catch(() => {});
    }
  } else {
    spawnLocal(sessionId, { cwd: params.cwd, permissionProfile: profile }).catch(() => {});
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
      cwd: params.cwd || null,
      createdAt: now,
    })
    .run();

  spawnLocal(sessionId, { cwd: params.cwd, permissionProfile: 'plain' }).catch(() => {});

  return { sessionId };
}

export async function resumeAgentSession(parentSessionId: string, targetLauncherId?: string | null, overridePermissionProfile?: PermissionProfile | null): Promise<{ sessionId: string }> {
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
  const runtime = (agent.runtime || 'claude') as AgentRuntime;

  const sessionId = ulid();
  const now = new Date().toISOString();

  // Inherit parent's permission profile by default; allow explicit override (e.g. restart-as)
  const permissionProfile: PermissionProfile = overridePermissionProfile || parent.permissionProfile as PermissionProfile;

  // If parent has a Claude session ID, use --resume for full context restoration
  if (runtime === 'claude' && parent.claudeSessionId) {
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
        cwd,
        createdAt: now,
      })
      .run();

    if (launcher && launcher.ws.readyState === 1) {
      const msg: LaunchSession = {
        type: 'launch_session',
        sessionId,
        prompt: '',
        cwd,
        runtime,
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
        spawnLocal(sessionId, {
          prompt: '',
          cwd,
          runtime,
          permissionProfile,
          resumeSessionId: parent.claudeSessionId,
        }).catch(() => {});
      }
    } else {
      spawnLocal(sessionId, {
        prompt: '',
        cwd,
        runtime,
        permissionProfile,
        resumeSessionId: parent.claudeSessionId,
      }).catch(() => {});
    }

    return { sessionId };
  }

  // Legacy fallback: no stored Claude session ID, use context-dump approach
  const claudeSessionId = crypto.randomUUID();
  const publicBaseUrl = (process.env.PW_PUBLIC_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
  const originalPrompt = `Feedback: ${publicBaseUrl}/api/v1/admin/feedback/${parent.feedbackId}\n\nTitle: ${feedbackRow.title}${feedbackRow.description ? `\nDescription: ${feedbackRow.description}` : ''}`;

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
      cwd,
      createdAt: now,
    })
    .run();

  if (launcher && launcher.ws.readyState === 1) {
    const msg: LaunchSession = {
      type: 'launch_session',
      sessionId,
      prompt: resumePrompt,
      cwd,
      runtime,
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
      spawnLocal(sessionId, { prompt: resumePrompt, cwd, runtime, permissionProfile, claudeSessionId }).catch(() => {});
    }
  } else {
    spawnLocal(sessionId, { prompt: resumePrompt, cwd, runtime, permissionProfile, claudeSessionId }).catch(() => {});
  }

  return { sessionId };
}

export async function dispatchHarnessSession(params: {
  harnessConfigId: string;
  launcherId: string;
  prompt: string;
  composeDir?: string;
  serviceName?: string;
  runtime?: AgentRuntime;
  permissionProfile: PermissionProfile;
  feedbackId?: string | null;
  agentEndpointId?: string | null;
  claudeSessionId?: string;
  cwd?: string;
}): Promise<{ sessionId: string }> {
  const sessionId = ulid();
  const now = new Date().toISOString();
  const claudeSessionId = params.claudeSessionId || crypto.randomUUID();
  const runtime = params.runtime || 'claude';
  let containerCwd: string | undefined;

  // Pre-flight: verify harness is running
  const harnessConfig = db
    .select()
    .from(schema.harnessConfigs)
    .where(eq(schema.harnessConfigs.id, params.harnessConfigId))
    .get();
  if (!harnessConfig) {
    throw new Error(`Harness config ${params.harnessConfigId} not found`);
  }
  if (harnessConfig.status !== 'running') {
    throw new Error(`Harness "${harnessConfig.name}" is not running (status: ${harnessConfig.status}). Start it first.`);
  }

  const launcher = getLauncher(params.launcherId);
  if (!launcher || launcher.ws.readyState !== 1) {
    throw new Error('Launcher is not connected');
  }

  db.insert(schema.agentSessions)
    .values({
      id: sessionId,
      feedbackId: params.feedbackId || null,
      agentEndpointId: params.agentEndpointId || null,
      permissionProfile: params.permissionProfile,
      status: 'pending',
      outputBytes: 0,
      launcherId: params.launcherId,
      claudeSessionId,
      cwd: params.cwd || null,
      createdAt: now,
    })
    .run();

  try {
    // Sync codebase into the Docker container if we have a git repo
    const projectDir = params.cwd;
    if (projectDir && isGitRepo(projectDir)) {
      try {
        const { branch, remoteUrl } = pushSyncBranch(projectDir, sessionId);
        await syncCodebaseToContainer(
          params.launcherId,
          sessionId,
          params.harnessConfigId,
          branch,
          remoteUrl,
          '/workspace',
          params.composeDir,
          params.serviceName,
        );
        containerCwd = '/workspace';
        console.log(`[dispatch] Synced codebase to container for harness session ${sessionId}`);
      } catch (err: any) {
        console.warn(`[dispatch] Container code sync failed, proceeding without sync: ${err.message}`);
      }
    }

    const msg: LaunchHarnessSession = {
      type: 'launch_harness_session',
      sessionId,
      harnessConfigId: params.harnessConfigId,
      prompt: params.prompt,
      composeDir: params.composeDir,
      serviceName: params.serviceName,
      runtime,
      permissionProfile: params.permissionProfile,
      containerCwd,
      claudeSessionId,
      anthropicApiKey: harnessConfig.anthropicApiKey || undefined,
      cols: 120,
      rows: 40,
    };

    // sendAndWait resolves when launcher sends launcher_session_started
    // resolveLauncherResponse short-circuits the normal handler in index.ts,
    // so we must update the DB ourselves after confirmation
    const response = await sendAndWait(params.launcherId, msg, 'launcher_session_started', 120_000);
    addSessionToLauncher(params.launcherId, sessionId);

    const startedMsg = response as { pid?: number };
    db.update(schema.agentSessions)
      .set({
        status: 'running',
        pid: startedMsg.pid,
        startedAt: new Date().toISOString(),
      })
      .where(eq(schema.agentSessions.id, sessionId))
      .run();

    console.log(`[dispatch] Harness session ${sessionId} started on launcher ${params.launcherId} (pid=${startedMsg.pid})`);
  } catch (err: any) {
    console.error(`[dispatch] Harness session ${sessionId} failed:`, err.message);
    db.update(schema.agentSessions)
      .set({ status: 'failed', completedAt: new Date().toISOString() })
      .where(eq(schema.agentSessions.id, sessionId))
      .run();
    throw err;
  }

  return { sessionId };
}

export async function syncCodebaseToContainer(
  launcherId: string,
  sessionId: string,
  harnessConfigId: string,
  branch: string,
  gitRemoteUrl: string,
  containerPath: string,
  composeDir?: string,
  serviceName?: string,
): Promise<void> {
  const msg: SyncCodebaseToContainer & { sessionId: string } = {
    type: 'sync_codebase_to_container',
    sessionId,
    harnessConfigId,
    branch,
    gitRemoteUrl,
    containerPath,
    composeDir,
    serviceName,
  };

  const result = await sendAndWait(launcherId, msg, 'sync_codebase_to_container_result', 120_000) as SyncCodebaseToContainerResult;
  if (!result.ok) {
    throw new Error(`Container code sync failed on launcher ${launcherId}: ${result.error}`);
  }
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
    // Source is local — use shared export utility
    const pkg = exportSessionFiles(projectDir, claudeSessionId);
    jsonlFiles = pkg.jsonlFiles;
    artifactFiles = pkg.artifactFiles;
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

// --- Sprite dispatch ---

function buildSpriteCommandArgs(params: {
  runtime?: AgentRuntime;
  prompt?: string;
  cwd?: string;
  permissionProfile: PermissionProfile;
}): string[] {
  const runtime = params.runtime || 'claude';

  if (runtime === 'codex') {
    const cmdArgs = ['codex'];
    if (params.permissionProfile === 'auto') {
      cmdArgs.push('--full-auto');
    } else if (params.permissionProfile === 'yolo') {
      cmdArgs.push('--dangerously-bypass-approvals-and-sandbox');
    }
    if (params.cwd) {
      cmdArgs.push('-C', params.cwd);
    }
    if (params.prompt) {
      cmdArgs.push(params.prompt);
    }
    return cmdArgs;
  }

  const cmdArgs = ['claude'];
  if (params.permissionProfile === 'yolo') {
    cmdArgs.push('--dangerously-skip-permissions');
  }
  if (params.prompt) {
    cmdArgs.push('-p', params.prompt);
  }
  if (params.cwd) {
    cmdArgs.push('--cwd', params.cwd);
  }
  return cmdArgs;
}

async function dispatchSpriteSession(params: {
  sessionId: string;
  feedbackId: string;
  agentEndpointId: string;
  spriteConfigId: string;
  spriteName: string;
  token: string | null;
  prompt: string;
  cwd: string;
  runtime?: AgentRuntime;
  permissionProfile: PermissionProfile;
  allowedTools?: string | null;
  claudeSessionId: string;
}): Promise<{ sessionId: string }> {
  const now = new Date().toISOString();

  db.insert(schema.agentSessions)
    .values({
      id: params.sessionId,
      feedbackId: params.feedbackId,
      agentEndpointId: params.agentEndpointId,
      permissionProfile: params.permissionProfile,
      status: 'pending',
      outputBytes: 0,
      claudeSessionId: params.claudeSessionId,
      spriteConfigId: params.spriteConfigId,
      createdAt: now,
    })
    .run();

  const cmdArgs = buildSpriteCommandArgs(params);

  try {
    launchSpriteSession({
      sessionId: params.sessionId,
      spriteConfigId: params.spriteConfigId,
      spriteName: params.spriteName,
      token: params.token,
      cmdArgs,
    });
    console.log(`[dispatch] Launched sprite session ${params.sessionId} on sprite ${params.spriteName}`);
  } catch (err) {
    console.error(`[dispatch] Failed to launch sprite session:`, err);
    db.update(schema.agentSessions)
      .set({ status: 'failed', completedAt: new Date().toISOString() })
      .where(eq(schema.agentSessions.id, params.sessionId))
      .run();
    throw err;
  }

  return { sessionId: params.sessionId };
}

export async function dispatchDirectSpriteSession(params: {
  spriteConfigId: string;
  prompt?: string;
  runtime?: AgentRuntime;
  permissionProfile?: PermissionProfile;
}): Promise<{ sessionId: string }> {
  const config = db.select().from(schema.spriteConfigs)
    .where(eq(schema.spriteConfigs.id, params.spriteConfigId)).get();
  if (!config) throw new Error('Sprite config not found');

  const sessionId = ulid();
  const now = new Date().toISOString();
  const profile = params.permissionProfile || 'interactive';
  const runtime = params.runtime || 'claude';

  db.insert(schema.agentSessions)
    .values({
      id: sessionId,
      feedbackId: null,
      agentEndpointId: null,
      permissionProfile: profile,
      status: 'pending',
      outputBytes: 0,
      spriteConfigId: params.spriteConfigId,
      createdAt: now,
    })
    .run();

  const cmdArgs = buildSpriteCommandArgs({
    runtime,
    prompt: params.prompt,
    cwd: config.defaultCwd || undefined,
    permissionProfile: profile,
  });

  try {
    launchSpriteSession({
      sessionId,
      spriteConfigId: params.spriteConfigId,
      spriteName: config.spriteName,
      token: config.token,
      cmdArgs,
    });
  } catch (err) {
    db.update(schema.agentSessions)
      .set({ status: 'failed', completedAt: new Date().toISOString() })
      .where(eq(schema.agentSessions.id, sessionId))
      .run();
    throw err;
  }

  return { sessionId };
}
