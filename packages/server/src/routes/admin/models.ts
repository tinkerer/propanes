import { Hono } from 'hono';
import { ulid } from 'ulidx';
import type { DiscoverModelsResult } from '@propanes/shared';
import { getAdminUser } from '../../admin-auth.js';
import { sendAndWait } from '../../launcher-registry.js';
import { discoverClaudeModels, discoverCodexModels, type ModelOption, type Runtime } from '../../model-discovery.js';
import { pinnedLauncherFor } from '../../onboarding.js';

// The models a user can pick (Slack `[models]`), read from the CLIs where
// their agents run: a member's pinned launcher (their Linux account, their
// logins), otherwise this host. Listing never starts a conversation.
export const modelRoutes = new Hono();

const CACHE_MS = 60_000;
// Below the Slack bot's 30 s request timeout, so a silent launcher is reported.
const LAUNCHER_TIMEOUT_MS = 25_000;
const cache = new Map<string, { models: ModelOption[]; at: number }>();

export async function discoverModelsFor(runtime: Runtime, launcherId: string | null): Promise<ModelOption[]> {
  const key = `${launcherId ?? 'local'}:${runtime}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.models;
  let models: ModelOption[];
  if (launcherId) {
    let reply: DiscoverModelsResult;
    try {
      reply = await sendAndWait(launcherId, { type: 'discover_models', sessionId: `models-${ulid()}`, runtime }, 'discover_models_result', LAUNCHER_TIMEOUT_MS) as DiscoverModelsResult;
    } catch (err) {
      const timedOut = err instanceof Error && /^Timeout/.test(err.message);
      throw new Error(timedOut
        ? `Launcher ${launcherId} did not answer model discovery (it may need an update)`
        : err instanceof Error ? err.message : 'launcher unavailable');
    }
    if (reply.error || !reply.models) throw new Error(reply.error || 'the launcher returned no models');
    models = reply.models;
  } else {
    models = await (runtime === 'codex' ? discoverCodexModels : discoverClaudeModels)({ timeoutMs: 20_000 });
  }
  cache.set(key, { models, at: Date.now() });
  return models;
}

modelRoutes.get('/models', async (c) => {
  const runtime = c.req.query('runtime');
  if (runtime !== 'claude' && runtime !== 'codex') return c.json({ error: 'runtime must be claude or codex' }, 400);
  const user = getAdminUser(c);
  const launcherId = pinnedLauncherFor(user.id);
  try {
    return c.json({ runtime, launcherId, models: await discoverModelsFor(runtime, launcherId) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'model discovery failed' }, 502);
  }
});
