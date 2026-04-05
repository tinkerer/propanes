import { Hono } from 'hono';
import { ulid } from 'ulidx';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { applicationSchema, applicationUpdateSchema } from '@prompt-widget/shared';
import type { ControlAction, RequestPanelConfig } from '@prompt-widget/shared';
import { db, schema } from '../db/index.js';
import { dispatchTerminalSession, dispatchAgentSession } from '../dispatch.js';
import { inputSessionRemote, getSessionStatus } from '../session-service-client.js';

export const applicationRoutes = new Hono();

function generateApiKey(): string {
  return 'pw_' + randomBytes(32).toString('base64url').slice(0, 43);
}

function parseAppJson(app: typeof schema.applications.$inferSelect) {
  return {
    ...app,
    hooks: JSON.parse(app.hooks),
    controlActions: JSON.parse(app.controlActions || '[]'),
    requestPanel: JSON.parse(app.requestPanel || '{}'),
  };
}

applicationRoutes.get('/', async (c) => {
  const apps = db.select().from(schema.applications).all();
  return c.json(apps.map(parseAppJson));
});

applicationRoutes.post('/scaffold', async (c) => {
  const body = await c.req.json();
  const { name, parentDir, projectName } = body;

  if (!name || !parentDir || !projectName) {
    return c.json({ error: 'name, parentDir, and projectName are required' }, 400);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(projectName)) {
    return c.json({ error: 'projectName must be alphanumeric (with _ or -)' }, 400);
  }
  if (!existsSync(parentDir)) {
    return c.json({ error: `parentDir does not exist: ${parentDir}` }, 400);
  }

  const projectDir = join(parentDir, projectName);
  if (existsSync(projectDir)) {
    return c.json({ error: `Directory already exists: ${projectDir}` }, 400);
  }

  const now = new Date().toISOString();
  const id = ulid();
  const apiKey = generateApiKey();

  const host = c.req.header('host') || 'localhost:3001';
  const proto = c.req.header('x-forwarded-proto') || 'http';
  const serverUrl = `${proto}://${host}`;

  mkdirSync(projectDir, { recursive: true });

  writeFileSync(join(projectDir, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 60px auto; padding: 0 20px; }
    h1 { color: #333; }
  </style>
</head>
<body>
  <h1>${name}</h1>
  <p>Your app is ready. The feedback widget is loaded below.</p>
  <script src="${serverUrl}/widget.js" data-server="${serverUrl}" data-api-key="${apiKey}"></script>
</body>
</html>
`);

  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
    name: projectName,
    version: '0.0.1',
    scripts: { start: 'npx serve .' },
  }, null, 2) + '\n');

  await db.insert(schema.applications).values({
    id,
    name,
    apiKey,
    projectDir,
    serverUrl,
    hooks: '{}',
    createdAt: now,
    updatedAt: now,
  });

  return c.json({ id, apiKey, projectDir }, 201);
});

applicationRoutes.post('/clone', async (c) => {
  const body = await c.req.json();
  const { name, gitUrl, parentDir, dirName } = body;

  if (!name || !gitUrl || !parentDir) {
    return c.json({ error: 'name, gitUrl, and parentDir are required' }, 400);
  }
  if (!existsSync(parentDir)) {
    return c.json({ error: `parentDir does not exist: ${parentDir}` }, 400);
  }

  const repoName = dirName || basename(gitUrl).replace(/\.git$/, '');
  const projectDir = join(parentDir, repoName);
  if (existsSync(projectDir)) {
    return c.json({ error: `Directory already exists: ${projectDir}` }, 400);
  }

  try {
    execSync(`git clone ${JSON.stringify(gitUrl)} ${JSON.stringify(projectDir)}`, {
      timeout: 120_000,
      stdio: 'pipe',
    });
  } catch (err: any) {
    return c.json({ error: `git clone failed: ${err.stderr?.toString() || err.message}` }, 500);
  }

  const now = new Date().toISOString();
  const id = ulid();
  const apiKey = generateApiKey();

  await db.insert(schema.applications).values({
    id,
    name,
    apiKey,
    projectDir,
    hooks: '{}',
    createdAt: now,
    updatedAt: now,
  });

  return c.json({ id, apiKey, projectDir }, 201);
});

applicationRoutes.post('/onboard-assist', async (c) => {
  const body = await c.req.json();
  const { request } = body as { request?: string };

  if (!request?.trim()) return c.json({ error: 'request text is required' }, 400);

  // Find agent endpoint (default → any)
  let agentEndpointId: string | null = null;
  const defaultAgent = db.select().from(schema.agentEndpoints)
    .where(eq(schema.agentEndpoints.isDefault, true)).get();
  if (defaultAgent) {
    agentEndpointId = defaultAgent.id;
  } else {
    const anyAgent = db.select().from(schema.agentEndpoints).get();
    if (anyAgent) agentEndpointId = anyAgent.id;
  }
  if (!agentEndpointId) return c.json({ error: 'No agent endpoint configured' }, 400);

  const agentRow = db.select().from(schema.agentEndpoints)
    .where(eq(schema.agentEndpoints.id, agentEndpointId)).get();
  if (!agentRow) return c.json({ error: 'Agent endpoint not found' }, 404);

  const host = c.req.header('host') || 'localhost:3001';
  const proto = c.req.header('x-forwarded-proto') || 'http';
  const baseUrl = `${proto}://${host}`;

  const prompt = buildOnboardPrompt(request.trim(), baseUrl);

  // Find the admin app for linking feedback
  const serverCwd = process.cwd();
  const adminApp = db.select().from(schema.applications)
    .where(eq(schema.applications.projectDir, serverCwd)).get();

  const feedbackId = ulid();
  const now = new Date().toISOString();
  db.insert(schema.feedbackItems).values({
    id: feedbackId,
    type: 'request',
    status: 'dispatched',
    title: `[Onboard] ${request.trim().slice(0, 80)}`,
    description: request.trim(),
    appId: adminApp?.id || null,
    dispatchedTo: agentRow.name,
    dispatchedAt: now,
    dispatchStatus: 'dispatched',
    createdAt: now,
    updatedAt: now,
  }).run();

  try {
    const { sessionId } = await dispatchAgentSession({
      feedbackId,
      agentEndpointId,
      prompt,
      cwd: process.cwd(),
      permissionProfile: 'interactive' as any,
      allowedTools: agentRow.allowedTools,
    });

    return c.json({ sessionId, feedbackId });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: errorMsg }, 500);
  }
});

function buildOnboardPrompt(request: string, baseUrl: string): string {
  // Gather context: existing apps, machines, harness configs
  const apps = db.select().from(schema.applications).all();
  const machines = db.select().from(schema.machines).all();
  const harnesses = db.select().from(schema.harnessConfigs).all();

  const parts: string[] = [];
  parts.push('# App Onboarding Assistant');
  parts.push('');
  parts.push('You are helping a user set up a new application in the prompt-widget system.');
  parts.push('Based on their description, figure out the right approach: scaffold a new project, clone a repo, or register an existing directory.');
  parts.push('Then create the app, embed the widget, and optionally set up Docker harnesses or remote machines.');
  parts.push('');

  parts.push('## User Request');
  parts.push(request);
  parts.push('');

  parts.push('## Existing Context');
  if (apps.length) {
    parts.push(`### Applications (${apps.length})`);
    for (const a of apps) parts.push(`- ${a.name} (${a.projectDir})`);
  } else {
    parts.push('No applications registered yet.');
  }
  if (machines.length) {
    parts.push(`### Machines (${machines.length})`);
    for (const m of machines) parts.push(`- ${m.name} (${m.hostname || m.address || 'local'})`);
  }
  if (harnesses.length) {
    parts.push(`### Harness Configs (${harnesses.length})`);
    for (const h of harnesses) parts.push(`- ${h.name}`);
  }
  parts.push('');

  parts.push('## Available API Endpoints');
  parts.push(`Base URL: ${baseUrl}`);
  parts.push('');
  parts.push('### Scaffold a new project');
  parts.push('POST /api/v1/admin/applications/scaffold');
  parts.push('Body: { name, parentDir, projectName }');
  parts.push('Creates a hello-world project with widget already embedded.');
  parts.push('');
  parts.push('### Clone a git repo');
  parts.push('POST /api/v1/admin/applications/clone');
  parts.push('Body: { name, gitUrl, parentDir, dirName? }');
  parts.push('Clones the repo and registers it.');
  parts.push('');
  parts.push('### Register existing directory');
  parts.push('POST /api/v1/admin/applications');
  parts.push('Body: { name, projectDir, serverUrl?, description?, hooks? }');
  parts.push('');
  parts.push('### Update an app');
  parts.push('PATCH /api/v1/admin/applications/:id');
  parts.push('Body: any subset of { name, projectDir, serverUrl, hooks, description, controlActions, requestPanel }');
  parts.push('');

  parts.push('## Widget Embed Snippet');
  parts.push('After creating the app, you\'ll get an apiKey. Embed the widget with:');
  parts.push(`<script src="${baseUrl}/widget.js" data-server="${baseUrl}" data-api-key="API_KEY"></script>`);
  parts.push('');

  parts.push('## Instructions');
  parts.push('- Ask clarifying questions if the user request is ambiguous');
  parts.push('- Use curl or the API to create the app');
  parts.push('- If cloning, verify the git URL is valid');
  parts.push('- After creating the app, show the widget embed snippet');
  parts.push('- If the user mentions Docker, offer to set up a harness config');
  parts.push('- If the user mentions a remote machine, offer to configure it');

  return parts.join('\n');
}

applicationRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const app = await db.query.applications.findFirst({
    where: eq(schema.applications.id, id),
  });
  if (!app) {
    return c.json({ error: 'Not found' }, 404);
  }
  return c.json(parseAppJson(app));
});

applicationRoutes.post('/', async (c) => {
  const body = await c.req.json();
  const parsed = applicationSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const now = new Date().toISOString();
  const id = ulid();
  const apiKey = generateApiKey();

  await db.insert(schema.applications).values({
    id,
    name: parsed.data.name,
    apiKey,
    projectDir: parsed.data.projectDir,
    serverUrl: parsed.data.serverUrl || null,
    hooks: JSON.stringify(parsed.data.hooks),
    description: parsed.data.description,
    controlActions: JSON.stringify(parsed.data.controlActions || []),
    requestPanel: JSON.stringify(parsed.data.requestPanel || {}),
    createdAt: now,
    updatedAt: now,
  });

  return c.json({ id, apiKey }, 201);
});

applicationRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = applicationUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const existing = await db.query.applications.findFirst({
    where: eq(schema.applications.id, id),
  });
  if (!existing) {
    return c.json({ error: 'Not found' }, 404);
  }

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { updatedAt: now };
  const d = parsed.data;

  if (d.name !== undefined) updates.name = d.name;
  if (d.projectDir !== undefined) updates.projectDir = d.projectDir;
  if ('serverUrl' in d) updates.serverUrl = d.serverUrl || null;
  if (d.hooks !== undefined) updates.hooks = JSON.stringify(d.hooks);
  if (d.description !== undefined) updates.description = d.description;
  if ('tmuxConfigId' in d) updates.tmuxConfigId = d.tmuxConfigId || null;
  if (d.defaultPermissionProfile !== undefined) updates.defaultPermissionProfile = d.defaultPermissionProfile;
  if ('defaultAllowedTools' in d) updates.defaultAllowedTools = d.defaultAllowedTools || null;
  if ('agentPath' in d) updates.agentPath = d.agentPath || null;
  if (d.screenshotIncludeWidget !== undefined) updates.screenshotIncludeWidget = d.screenshotIncludeWidget;
  if (d.autoDispatch !== undefined) updates.autoDispatch = d.autoDispatch;
  if (d.controlActions !== undefined) updates.controlActions = JSON.stringify(d.controlActions);
  if (d.requestPanel !== undefined) updates.requestPanel = JSON.stringify(d.requestPanel);

  await db.update(schema.applications).set(updates).where(eq(schema.applications.id, id));

  return c.json({ id, updated: true });
});

applicationRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await db.query.applications.findFirst({
    where: eq(schema.applications.id, id),
  });
  if (!existing) {
    return c.json({ error: 'Not found' }, 404);
  }

  await db.delete(schema.applications).where(eq(schema.applications.id, id));
  return c.json({ id, deleted: true });
});

applicationRoutes.post('/:id/regenerate-key', async (c) => {
  const id = c.req.param('id');
  const existing = await db.query.applications.findFirst({
    where: eq(schema.applications.id, id),
  });
  if (!existing) {
    return c.json({ error: 'Not found' }, 404);
  }

  const apiKey = generateApiKey();
  const now = new Date().toISOString();
  await db.update(schema.applications).set({
    apiKey,
    updatedAt: now,
  }).where(eq(schema.applications.id, id));

  return c.json({ id, apiKey });
});

applicationRoutes.post('/:id/run-action', async (c) => {
  const id = c.req.param('id');
  const { actionId } = await c.req.json();
  if (!actionId) return c.json({ error: 'actionId is required' }, 400);

  const app = await db.query.applications.findFirst({
    where: eq(schema.applications.id, id),
  });
  if (!app) return c.json({ error: 'App not found' }, 404);

  const actions: ControlAction[] = JSON.parse(app.controlActions || '[]');
  const action = actions.find((a) => a.id === actionId);
  if (!action) return c.json({ error: 'Action not found' }, 404);

  try {
    const { sessionId } = await dispatchTerminalSession({ cwd: app.projectDir, appId: id });

    (async () => {
      try {
        for (let i = 0; i < 30; i++) {
          const status = await getSessionStatus(sessionId);
          if (status?.active && status.totalBytes > 0) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        await inputSessionRemote(sessionId, action.command + '\r');
      } catch (err) {
        console.error('[applications] Failed to send control action command:', err);
      }
    })();

    return c.json({ sessionId, actionId });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: errorMsg }, 500);
  }
});

applicationRoutes.post('/:id/request', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const { request, preferences } = body as { request?: string; preferences?: string[] };

  if (!request || !request.trim()) {
    return c.json({ error: 'request text is required' }, 400);
  }

  const app = await db.query.applications.findFirst({
    where: eq(schema.applications.id, id),
  });
  if (!app) return c.json({ error: 'App not found' }, 404);

  const panelConfig: RequestPanelConfig = JSON.parse(app.requestPanel || '{}');

  // Find agent endpoint
  let agentEndpointId = panelConfig.defaultAgentId || null;
  if (!agentEndpointId) {
    // Fall back to app-specific agent, then any default agent
    const appAgent = db.select().from(schema.agentEndpoints)
      .where(eq(schema.agentEndpoints.appId, id)).get();
    if (appAgent) {
      agentEndpointId = appAgent.id;
    } else {
      const defaultAgent = db.select().from(schema.agentEndpoints)
        .where(eq(schema.agentEndpoints.isDefault, true)).get();
      if (defaultAgent) {
        agentEndpointId = defaultAgent.id;
      } else {
        const anyAgent = db.select().from(schema.agentEndpoints).get();
        if (anyAgent) agentEndpointId = anyAgent.id;
      }
    }
  }

  if (!agentEndpointId) {
    return c.json({ error: 'No agent endpoint configured' }, 400);
  }

  const agent = db.select().from(schema.agentEndpoints)
    .where(eq(schema.agentEndpoints.id, agentEndpointId)).get();
  if (!agent) {
    return c.json({ error: 'Agent endpoint not found' }, 404);
  }

  // Build prompt
  const parts: string[] = [];
  if (panelConfig.promptPrefix) parts.push(panelConfig.promptPrefix);
  parts.push(`App: ${app.name}`);
  parts.push(`Project dir: ${app.projectDir}`);
  if (app.description) parts.push(app.description);
  parts.push('');
  parts.push(`Request: ${request.trim()}`);

  if (preferences?.length && panelConfig.preferences?.length) {
    const snippets = preferences
      .map((prefId) => panelConfig.preferences.find((p) => p.id === prefId))
      .filter(Boolean)
      .map((p) => p!.promptSnippet);
    if (snippets.length) {
      parts.push('');
      parts.push(snippets.join('\n'));
    }
  }

  const prompt = parts.join('\n');

  // Create feedback item
  const feedbackId = ulid();
  const now = new Date().toISOString();
  db.insert(schema.feedbackItems).values({
    id: feedbackId,
    type: 'request',
    status: 'dispatched',
    title: request.trim().slice(0, 100),
    description: request.trim(),
    appId: id,
    dispatchedTo: agent.name,
    dispatchedAt: now,
    dispatchStatus: 'dispatched',
    createdAt: now,
    updatedAt: now,
  }).run();

  try {
    const { sessionId } = await dispatchAgentSession({
      feedbackId,
      agentEndpointId,
      prompt,
      cwd: app.projectDir,
      permissionProfile: agent.permissionProfile as any,
      allowedTools: agent.allowedTools,
    });

    return c.json({ sessionId, feedbackId });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: errorMsg }, 500);
  }
});

applicationRoutes.post('/:id/design-assist', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const { request, context, settingPath } = body as { request?: string; context?: string; settingPath?: string };

  if (!request || !request.trim()) {
    return c.json({ error: 'request text is required' }, 400);
  }

  const app = await db.query.applications.findFirst({
    where: eq(schema.applications.id, id),
  });
  if (!app) return c.json({ error: 'App not found' }, 404);

  const panelConfig: RequestPanelConfig = JSON.parse(app.requestPanel || '{}');

  // Find agent endpoint (same fallback logic as /:id/request)
  let agentEndpointId = panelConfig.defaultAgentId || null;
  if (!agentEndpointId) {
    const appAgent = db.select().from(schema.agentEndpoints)
      .where(eq(schema.agentEndpoints.appId, id)).get();
    if (appAgent) {
      agentEndpointId = appAgent.id;
    } else {
      const defaultAgent = db.select().from(schema.agentEndpoints)
        .where(eq(schema.agentEndpoints.isDefault, true)).get();
      if (defaultAgent) {
        agentEndpointId = defaultAgent.id;
      } else {
        const anyAgent = db.select().from(schema.agentEndpoints).get();
        if (anyAgent) agentEndpointId = anyAgent.id;
      }
    }
  }

  if (!agentEndpointId) {
    return c.json({ error: 'No agent endpoint configured' }, 400);
  }

  const agent = db.select().from(schema.agentEndpoints)
    .where(eq(schema.agentEndpoints.id, agentEndpointId)).get();
  if (!agent) {
    return c.json({ error: 'Agent endpoint not found' }, 404);
  }

  // Build prompt with codebase architecture context
  const parts: string[] = [];
  parts.push(`# AI Assist — ${app.name}`);
  parts.push('');
  parts.push(`App: ${app.name}`);
  parts.push(`Project dir: ${app.projectDir}`);
  if (app.description) parts.push(`Description: ${app.description}`);
  parts.push('');
  parts.push('## Codebase Architecture');
  parts.push('This is a monorepo with 4 packages:');
  parts.push('- `packages/widget` — Embeddable JS feedback overlay (vanilla TS, bundled as IIFE)');
  parts.push('- `packages/server` — Hono REST API + SQLite (Drizzle ORM), serves admin SPA');
  parts.push('- `packages/admin` — Preact SPA dashboard (Vite build, served at /admin/)');
  parts.push('- `packages/shared` — Shared types, Zod schemas, constants');
  parts.push('');
  parts.push('## Key Files');
  parts.push('- `packages/server/src/db/schema.ts` — Database schema (SQLite/Drizzle)');
  parts.push('- `packages/shared/src/types.ts` — Shared TypeScript types');
  parts.push('- `packages/shared/src/schemas.ts` — Zod validation schemas');
  parts.push('- `packages/admin/src/app.css` — All admin UI styles');
  parts.push('- `packages/admin/src/lib/api.ts` — Frontend API client');
  parts.push('- `packages/admin/src/pages/AppSettingsPage.tsx` — App settings page');
  parts.push('- `packages/widget/src/widget.ts` — Widget overlay implementation');
  parts.push('- `packages/widget/src/styles.ts` — Widget CSS-in-JS styles');
  parts.push('');
  if (context) {
    parts.push(`## Setting Context`);
    parts.push(context);
    if (settingPath) parts.push(`Setting path: ${settingPath}`);
    parts.push('');
  }
  parts.push(`## User Request`);
  parts.push(request.trim());
  parts.push('');
  parts.push('## Instructions');
  parts.push('- Ask clarifying questions before making changes if the request is ambiguous');
  parts.push('- Read relevant files first to understand existing patterns');
  parts.push('- Follow existing code style and conventions');
  parts.push('- After making changes, rebuild: `cd packages/admin && npx vite build`');

  const prompt = parts.join('\n');

  // Create feedback item
  const feedbackId = ulid();
  const now = new Date().toISOString();
  db.insert(schema.feedbackItems).values({
    id: feedbackId,
    type: 'request',
    status: 'dispatched',
    title: `[AI Assist] ${request.trim().slice(0, 80)}`,
    description: request.trim(),
    appId: id,
    dispatchedTo: agent.name,
    dispatchedAt: now,
    dispatchStatus: 'dispatched',
    createdAt: now,
    updatedAt: now,
  }).run();

  try {
    const { sessionId } = await dispatchAgentSession({
      feedbackId,
      agentEndpointId,
      prompt,
      cwd: app.projectDir,
      permissionProfile: agent.permissionProfile as any,
      allowedTools: agent.allowedTools,
    });

    return c.json({ sessionId, feedbackId });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: errorMsg }, 500);
  }
});
