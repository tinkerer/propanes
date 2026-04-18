import { Hono } from 'hono';
import { listSessions, getSession, sendCommand, resolveSessionId, setAlias, removeAlias, getAliasesForSession } from '../sessions.js';
import { agentBatchRequestSchema, sessionAliasSchema } from '@prompt-widget/shared';

export const agentRoutes = new Hono();

// Resolve session alias middleware-style helper
function resolveId(c: { req: { param: (k: string) => string } }): string {
  return resolveSessionId(c.req.param('id'));
}

// List all active sessions
agentRoutes.get('/sessions', (c) => {
  return c.json(listSessions());
});

// Get session info
agentRoutes.get('/sessions/:id', (c) => {
  const session = getSession(resolveId(c));
  if (!session) return c.json({ error: 'Session not found' }, 404);
  const { ws, pendingRequests, ...info } = session;
  return c.json({ ...info, aliases: getAliasesForSession(info.sessionId) });
});

// Capture screenshot of the live page
agentRoutes.post('/sessions/:id/screenshot', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const result = await sendCommand(resolveId(c), 'screenshot', { excludeCursor: body.excludeCursor ?? false }) as { dataUrl: string; mimeType?: string };
    if (c.req.query('format') === 'raw') {
      const base64 = result.dataUrl.split(',')[1];
      const buffer = Buffer.from(base64, 'base64');
      c.header('Content-Type', result.mimeType || 'image/png');
      return c.body(buffer);
    }
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, err.message.includes('not found') ? 404 : 504);
  }
});

// Execute JS in page context (scoped - agent provides expression, widget evals it)
agentRoutes.post('/sessions/:id/execute', async (c) => {
  const body = await c.req.json();
  const { expression } = body;
  if (!expression || typeof expression !== 'string') {
    return c.json({ error: 'expression is required' }, 400);
  }
  if (expression.length > 10_000) {
    return c.json({ error: 'expression too long (max 10000 chars)' }, 400);
  }
  try {
    const result = await sendCommand(resolveId(c), 'execute', { expression });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

// Get current console logs from the session
agentRoutes.get('/sessions/:id/console', async (c) => {
  try {
    const result = await sendCommand(resolveId(c), 'getConsole');
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

// Get network errors from the session
agentRoutes.get('/sessions/:id/network', async (c) => {
  try {
    const result = await sendCommand(resolveId(c), 'getNetwork');
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

// Get environment info from the session
agentRoutes.get('/sessions/:id/environment', async (c) => {
  try {
    const result = await sendCommand(resolveId(c), 'getEnvironment');
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

// Get DOM snapshot (accessibility-tree-like)
agentRoutes.get('/sessions/:id/dom', async (c) => {
  const selector = c.req.query('selector') || 'body';
  try {
    const result = await sendCommand(resolveId(c), 'getDom', { selector });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

// Navigate to a URL
agentRoutes.post('/sessions/:id/navigate', async (c) => {
  const body = await c.req.json();
  const { url } = body;
  if (!url || typeof url !== 'string') {
    return c.json({ error: 'url is required' }, 400);
  }
  try {
    const result = await sendCommand(resolveId(c), 'navigate', { url });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

// Click an element by CSS selector
agentRoutes.post('/sessions/:id/click', async (c) => {
  const body = await c.req.json();
  const { selector } = body;
  if (!selector || typeof selector !== 'string') {
    return c.json({ error: 'selector is required' }, 400);
  }
  try {
    const result = await sendCommand(resolveId(c), 'click', { selector });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

// Type text into a focused or selected element
agentRoutes.post('/sessions/:id/type', async (c) => {
  const body = await c.req.json();
  const { selector, text } = body;
  if (!text || typeof text !== 'string') {
    return c.json({ error: 'text is required' }, 400);
  }
  try {
    const result = await sendCommand(resolveId(c), 'type', { selector, text });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

// Get page performance timing
agentRoutes.get('/sessions/:id/performance', async (c) => {
  try {
    const result = await sendCommand(resolveId(c), 'getPerformance');
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

// --- Mouse commands ---

agentRoutes.post('/sessions/:id/mouse/move', async (c) => {
  const { x, y } = await c.req.json();
  if (typeof x !== 'number' || typeof y !== 'number') {
    return c.json({ error: 'x and y are required numbers' }, 400);
  }
  try {
    return c.json(await sendCommand(resolveId(c), 'moveMouse', { x, y }));
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

agentRoutes.post('/sessions/:id/mouse/click', async (c) => {
  const { x, y, button } = await c.req.json();
  if (typeof x !== 'number' || typeof y !== 'number') {
    return c.json({ error: 'x and y are required numbers' }, 400);
  }
  try {
    return c.json(await sendCommand(resolveId(c), 'clickAt', { x, y, button }));
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

agentRoutes.post('/sessions/:id/mouse/hover', async (c) => {
  const { selector, x, y } = await c.req.json();
  if (!selector && typeof x !== 'number') {
    return c.json({ error: 'selector or x/y coordinates required' }, 400);
  }
  try {
    return c.json(await sendCommand(resolveId(c), 'hover', { selector, x, y }));
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

agentRoutes.post('/sessions/:id/mouse/drag', async (c) => {
  const { from, to, steps, stepDelayMs } = await c.req.json();
  if (from?.x == null || from?.y == null || to?.x == null || to?.y == null) {
    return c.json({ error: 'from {x,y} and to {x,y} are required' }, 400);
  }
  try {
    return c.json(await sendCommand(resolveId(c), 'drag', { from, to, steps, stepDelayMs }));
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

agentRoutes.post('/sessions/:id/mouse/down', async (c) => {
  const { x, y, button } = await c.req.json();
  if (typeof x !== 'number' || typeof y !== 'number') {
    return c.json({ error: 'x and y are required numbers' }, 400);
  }
  try {
    return c.json(await sendCommand(resolveId(c), 'mouseDown', { x, y, button }));
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

agentRoutes.post('/sessions/:id/mouse/up', async (c) => {
  const { x, y, button } = await c.req.json();
  if (typeof x !== 'number' || typeof y !== 'number') {
    return c.json({ error: 'x and y are required numbers' }, 400);
  }
  try {
    return c.json(await sendCommand(resolveId(c), 'mouseUp', { x, y, button }));
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

// --- Keyboard commands ---

agentRoutes.post('/sessions/:id/keyboard/press', async (c) => {
  const { key, modifiers } = await c.req.json();
  if (!key || typeof key !== 'string') {
    return c.json({ error: 'key is required' }, 400);
  }
  try {
    return c.json(await sendCommand(resolveId(c), 'pressKey', { key, modifiers }));
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

agentRoutes.post('/sessions/:id/keyboard/down', async (c) => {
  const { key, modifiers } = await c.req.json();
  if (!key || typeof key !== 'string') {
    return c.json({ error: 'key is required' }, 400);
  }
  try {
    return c.json(await sendCommand(resolveId(c), 'keyDown', { key, modifiers }));
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

agentRoutes.post('/sessions/:id/keyboard/up', async (c) => {
  const { key, modifiers } = await c.req.json();
  if (!key || typeof key !== 'string') {
    return c.json({ error: 'key is required' }, 400);
  }
  try {
    return c.json(await sendCommand(resolveId(c), 'keyUp', { key, modifiers }));
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

agentRoutes.post('/sessions/:id/keyboard/type', async (c) => {
  const { text, selector, charDelayMs } = await c.req.json();
  if (!text || typeof text !== 'string') {
    return c.json({ error: 'text is required' }, 400);
  }
  try {
    return c.json(await sendCommand(resolveId(c), 'typeText', { text, selector, charDelayMs }));
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

// --- Batch endpoint ---

agentRoutes.post('/sessions/:id/batch', async (c) => {
  const body = await c.req.json();
  const parsed = agentBatchRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid batch request', details: parsed.error.flatten() }, 400);
  }

  const { commands, stopOnError, commandTimeout } = parsed.data;
  const sessionId = resolveId(c);
  const results: { index: number; command: string; ok: boolean; data?: unknown; error?: string; durationMs: number }[] = [];
  const batchStart = Date.now();
  let stoppedAtIndex: number | undefined;

  for (let i = 0; i < commands.length; i++) {
    const { command, params } = commands[i];
    const cmdStart = Date.now();
    try {
      const data = await sendCommand(sessionId, command, params, commandTimeout);
      results.push({ index: i, command, ok: true, data, durationMs: Date.now() - cmdStart });
    } catch (err: any) {
      results.push({ index: i, command, ok: false, error: err.message, durationMs: Date.now() - cmdStart });
      if (stopOnError) {
        stoppedAtIndex = i;
        break;
      }
    }
  }

  return c.json({
    results,
    completedCount: results.filter((r) => r.ok).length,
    totalCount: commands.length,
    totalDurationMs: Date.now() - batchStart,
    stoppedAtIndex,
  });
});

// --- Session aliasing ---

agentRoutes.post('/sessions/:id/alias', async (c) => {
  const body = await c.req.json();
  const parsed = sessionAliasSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid alias', details: parsed.error.flatten() }, 400);
  }

  const sessionId = resolveId(c);
  const session = getSession(sessionId);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  setAlias(parsed.data.name, sessionId);
  return c.json({ alias: parsed.data.name, sessionId });
});

agentRoutes.delete('/sessions/:id/alias', async (c) => {
  const body = await c.req.json();
  const parsed = sessionAliasSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid alias', details: parsed.error.flatten() }, 400);
  }

  removeAlias(parsed.data.name);
  return c.json({ removed: parsed.data.name });
});

// --- waitFor primitive ---

agentRoutes.post('/sessions/:id/waitFor', async (c) => {
  const body = await c.req.json();
  const { selector, condition, text, timeout, pollInterval, pierceShadow } = body;
  if (!selector || typeof selector !== 'string') {
    return c.json({ error: 'selector is required' }, 400);
  }
  const validConditions = ['exists', 'absent', 'visible', 'hidden', 'textContains', 'textEquals'];
  const cond = condition || 'exists';
  if (!validConditions.includes(cond)) {
    return c.json({ error: `Invalid condition. Must be one of: ${validConditions.join(', ')}` }, 400);
  }
  if ((cond === 'textContains' || cond === 'textEquals') && typeof text !== 'string') {
    return c.json({ error: 'text is required for textContains/textEquals conditions' }, 400);
  }

  const widgetTimeout = Math.min(timeout || 5000, 30000);
  const serverTimeout = widgetTimeout + 2000;

  try {
    const result = await sendCommand(
      resolveId(c),
      'waitFor',
      { selector, condition: cond, text, timeout: widgetTimeout, pollInterval: pollInterval || 100, pierceShadow: !!pierceShadow },
      serverTimeout,
    );
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, err.message.includes('not found') ? 404 : 504);
  }
});

// --- Shadow DOM-aware DOM snapshot ---

agentRoutes.get('/sessions/:id/dom/deep', async (c) => {
  const selector = c.req.query('selector') || 'body';
  try {
    const result = await sendCommand(resolveId(c), 'getDom', { selector, pierceShadow: true });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

// --- Shadow DOM-aware click ---

agentRoutes.post('/sessions/:id/click/deep', async (c) => {
  const body = await c.req.json();
  const { selector } = body;
  if (!selector || typeof selector !== 'string') {
    return c.json({ error: 'selector is required' }, 400);
  }
  try {
    const result = await sendCommand(resolveId(c), 'click', { selector, pierceShadow: true });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

// --- Shadow DOM-aware type ---

agentRoutes.post('/sessions/:id/type/deep', async (c) => {
  const body = await c.req.json();
  const { selector, text } = body;
  if (!text || typeof text !== 'string') {
    return c.json({ error: 'text is required' }, 400);
  }
  try {
    const result = await sendCommand(resolveId(c), 'type', { selector, text, pierceShadow: true });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

// --- Shadow DOM-aware hover ---

agentRoutes.post('/sessions/:id/mouse/hover/deep', async (c) => {
  const { selector, x, y } = await c.req.json();
  if (!selector && typeof x !== 'number') {
    return c.json({ error: 'selector or x/y coordinates required' }, 400);
  }
  try {
    return c.json(await sendCommand(resolveId(c), 'hover', { selector, x, y, pierceShadow: true }));
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

// --- Compound widget actions ---

agentRoutes.post('/sessions/:id/widget/open', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const panel = body.panel || 'feedback';
  const param = body.param;
  try {
    const result = await sendCommand(resolveId(c), 'openAdmin', { panel, param });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

agentRoutes.post('/sessions/:id/widget/close', async (c) => {
  try {
    const result = await sendCommand(resolveId(c), 'closeAdmin', {});
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

agentRoutes.post('/sessions/:id/append-feedback', async (c) => {
  const body = await c.req.json();
  const { feedbackId } = body;
  if (!feedbackId || typeof feedbackId !== 'string') {
    return c.json({ error: 'feedbackId is required' }, 400);
  }
  try {
    const result = await sendCommand(resolveId(c), 'appendFeedback', { feedbackId });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

agentRoutes.post('/sessions/:id/widget/submit', async (c) => {
  const body = await c.req.json();
  try {
    const result = await sendCommand(resolveId(c), 'widgetSubmit', {
      description: body.description || '',
      screenshot: !!body.screenshot,
      type: body.type || 'manual',
      tags: body.tags || [],
    });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});

agentRoutes.post('/sessions/:id/widget/screenshot', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await sendCommand(resolveId(c), 'screenshot', { includeWidget: body.includeWidget !== false, excludeCursor: body.excludeCursor ?? false }) as { dataUrl: string; mimeType?: string };
    if (c.req.query('format') === 'raw') {
      const base64 = result.dataUrl.split(',')[1];
      const buffer = Buffer.from(base64, 'base64');
      c.header('Content-Type', result.mimeType || 'image/png');
      return c.body(buffer);
    }
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 504);
  }
});
