// onboarding.ts — give a new member a working, isolated workspace in one call.
//
// The data-plane half of "onboard a user": their own copies of the apps an
// admin suggests (each owned by the member, so memberAppScope shows them only
// these), the standard agent set on each app (claude/codex × interactive/yolo),
// a machine row for their private launcher, and the launcher pin that makes
// every session they start — or that their apps' widgets auto-dispatch — run
// there instead of on the server's own account.
//
// The OS half (a Linux account, the launcher service, CLI logins, the Slack
// bot) lives in scripts/onboard-user.sh, which calls this through
// POST /admin/users/:id/onboard. Everything here is idempotent: rows are
// matched by owner + name, so re-running fills gaps and changes nothing else.
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { ulid } from 'ulidx';
import type { PermissionProfile } from '@propanes/shared';
import { db, schema } from './db/index.js';

export const AGENT_PRESETS = [
  { key: 'claude', name: 'Claude', runtime: 'claude', permissionProfile: 'interactive-require' },
  { key: 'claude-yolo', name: 'Claude YOLO', runtime: 'claude', permissionProfile: 'interactive-yolo' },
  { key: 'codex', name: 'Codex', runtime: 'codex', permissionProfile: 'interactive-require' },
  { key: 'codex-yolo', name: 'Codex YOLO', runtime: 'codex', permissionProfile: 'interactive-yolo' },
] as const satisfies ReadonlyArray<{ key: string; name: string; runtime: string; permissionProfile: PermissionProfile }>;

export type AgentPresetKey = (typeof AGENT_PRESETS)[number]['key'];

export type OnboardAppInput = {
  /** Existing app to copy name/description/serverUrl/sub-apps/settings from. */
  fromAppId?: string;
  name?: string;
  /** Where the member's checkout lives on THEIR launcher (not the source app's dir). */
  projectDir: string;
  description?: string;
  serverUrl?: string | null;
};

export type OnboardPlan = {
  apps: OnboardAppInput[];
  agents?: AgentPresetKey[];
  /** Which preset becomes each app's default endpoint. */
  defaultAgent?: AgentPresetKey;
  /** Pin all of the member's sessions to this launcher. */
  launcherId?: string | null;
  /** Machine row the launcher reports as (its MACHINE_ID). */
  machine?: { name: string; hostname?: string | null; defaultCwd?: string | null } | null;
};

export type OnboardResult = {
  userId: string;
  launcherId: string | null;
  machine: { id: string; name: string; created: boolean } | null;
  apps: Array<{ id: string; name: string; apiKey: string; projectDir: string; created: boolean }>;
  agents: Array<{ id: string; appId: string; name: string; created: boolean }>;
};

export class OnboardError extends Error {}

function generateApiKey(): string {
  return 'pw_' + randomBytes(32).toString('base64url').slice(0, 43);
}

/** Validate an untrusted request body into a plan; throws OnboardError. */
export function parseOnboardPlan(body: unknown): OnboardPlan {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const rawApps = Array.isArray(b.apps) ? b.apps : [];
  const apps: OnboardAppInput[] = rawApps.map((raw, i) => {
    const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const projectDir = typeof a.projectDir === 'string' ? a.projectDir.trim() : '';
    if (!projectDir.startsWith('/') && !projectDir.startsWith('~')) {
      throw new OnboardError(`apps[${i}].projectDir must be an absolute path`);
    }
    if (typeof a.fromAppId !== 'string' && typeof a.name !== 'string') {
      throw new OnboardError(`apps[${i}] needs fromAppId or name`);
    }
    return {
      fromAppId: typeof a.fromAppId === 'string' ? a.fromAppId : undefined,
      name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : undefined,
      projectDir,
      description: typeof a.description === 'string' ? a.description : undefined,
      serverUrl: typeof a.serverUrl === 'string' || a.serverUrl === null ? (a.serverUrl as string | null) : undefined,
    };
  });
  const known = new Set<string>(AGENT_PRESETS.map((p) => p.key));
  const agents = Array.isArray(b.agents) ? b.agents : AGENT_PRESETS.map((p) => p.key);
  for (const k of agents) {
    if (typeof k !== 'string' || !known.has(k)) throw new OnboardError(`unknown agent preset: ${String(k)}`);
  }
  const defaultAgent = typeof b.defaultAgent === 'string' ? b.defaultAgent : agents[0];
  if (defaultAgent !== undefined && !agents.includes(defaultAgent)) {
    throw new OnboardError('defaultAgent must be one of agents');
  }
  let machine: OnboardPlan['machine'] = null;
  if (b.machine && typeof b.machine === 'object') {
    const m = b.machine as Record<string, unknown>;
    if (typeof m.name !== 'string' || !m.name.trim()) throw new OnboardError('machine.name required');
    machine = {
      name: m.name.trim(),
      hostname: typeof m.hostname === 'string' ? m.hostname : null,
      defaultCwd: typeof m.defaultCwd === 'string' ? m.defaultCwd : null,
    };
  }
  return {
    apps,
    agents: agents as AgentPresetKey[],
    defaultAgent: defaultAgent as AgentPresetKey | undefined,
    launcherId: typeof b.launcherId === 'string' && b.launcherId.trim() ? b.launcherId.trim() : null,
    machine,
  };
}

export function onboardUser(userId: string, plan: OnboardPlan): OnboardResult {
  const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) throw new OnboardError('User not found');
  const now = new Date().toISOString();
  const result: OnboardResult = { userId, launcherId: user.launcherId ?? null, machine: null, apps: [], agents: [] };

  // Resolve every source first so a bad fromAppId fails before anything is written.
  const sources = plan.apps.map((input) => {
    if (!input.fromAppId) return null;
    const src = db.select().from(schema.applications).where(eq(schema.applications.id, input.fromAppId)).get();
    if (!src) throw new OnboardError(`Suggested app ${input.fromAppId} not found`);
    return src;
  });

  db.transaction((tx) => {
    if (plan.machine) {
      const existing = tx.select().from(schema.machines).where(eq(schema.machines.name, plan.machine.name)).get();
      if (existing) {
        result.machine = { id: existing.id, name: existing.name, created: false };
      } else {
        const id = ulid();
        tx.insert(schema.machines).values({
          id,
          name: plan.machine.name,
          hostname: plan.machine.hostname ?? null,
          type: 'local',
          status: 'offline',
          defaultCwd: plan.machine.defaultCwd ?? null,
          tags: JSON.stringify(['user-launcher', user.username]),
          createdAt: now,
          updatedAt: now,
        }).run();
        result.machine = { id, name: plan.machine.name, created: true };
      }
    }

    if (plan.launcherId) {
      tx.update(schema.users).set({ launcherId: plan.launcherId, updatedAt: now }).where(eq(schema.users.id, userId)).run();
      result.launcherId = plan.launcherId;
    }

    plan.apps.forEach((input, i) => {
      const src = sources[i];
      const name = input.name || src!.name;
      let app = tx.select().from(schema.applications)
        .where(and(eq(schema.applications.ownerUserId, userId), eq(schema.applications.name, name)))
        .get();
      if (app) {
        result.apps.push({ id: app.id, name, apiKey: app.apiKey, projectDir: app.projectDir, created: false });
      } else {
        const id = ulid();
        const apiKey = generateApiKey();
        const row = {
          id,
          name,
          apiKey,
          projectDir: input.projectDir,
          // Sub-app dirs are relative to projectDir, so they carry over as-is.
          subApps: src?.subApps ?? '[]',
          serverUrl: input.serverUrl !== undefined ? input.serverUrl : src?.serverUrl ?? null,
          // Hooks are commands run on the server's own account; never copy them
          // into an isolated member's workspace.
          hooks: '[]',
          description: input.description ?? src?.description ?? '',
          defaultPermissionProfile: src?.defaultPermissionProfile ?? 'interactive-require',
          defaultAllowedTools: src?.defaultAllowedTools ?? null,
          screenshotIncludeWidget: src?.screenshotIncludeWidget ?? true,
          autoDispatch: src?.autoDispatch ?? true,
          controlActions: '[]',
          requestPanel: src?.requestPanel ?? '{}',
          ownerUserId: userId,
          orgId: user.orgId ?? null,
          createdAt: now,
          updatedAt: now,
        };
        tx.insert(schema.applications).values(row).run();
        app = row as typeof schema.applications.$inferSelect;
        result.apps.push({ id, name, apiKey, projectDir: input.projectDir, created: true });
      }

      for (const key of plan.agents ?? []) {
        const preset = AGENT_PRESETS.find((p) => p.key === key)!;
        const existing = tx.select().from(schema.agentEndpoints)
          .where(and(eq(schema.agentEndpoints.appId, app.id), eq(schema.agentEndpoints.name, preset.name)))
          .get();
        if (existing) {
          result.agents.push({ id: existing.id, appId: app.id, name: preset.name, created: false });
          continue;
        }
        const id = ulid();
        tx.insert(schema.agentEndpoints).values({
          id,
          name: preset.name,
          url: '',
          mode: 'interactive',
          runtime: preset.runtime,
          permissionProfile: preset.permissionProfile,
          // Only claim default when the app has none yet, so an admin's later
          // choice survives a re-run.
          isDefault: key === plan.defaultAgent && !tx.select({ id: schema.agentEndpoints.id })
            .from(schema.agentEndpoints)
            .where(and(eq(schema.agentEndpoints.appId, app.id), eq(schema.agentEndpoints.isDefault, true)))
            .get(),
          appId: app.id,
          createdAt: now,
          updatedAt: now,
        }).run();
        result.agents.push({ id, appId: app.id, name: preset.name, created: true });
      }
    });
  });

  return result;
}

/** The launcher a member's sessions must run on, or null when unpinned. Admins
 *  are never pinned (they deliberately target any launcher). */
export function pinnedLauncherFor(ownerUserId: string | null | undefined): string | null {
  if (!ownerUserId || ownerUserId === 'env-admin') return null;
  const row = db.select({ role: schema.users.role, launcherId: schema.users.launcherId })
    .from(schema.users).where(eq(schema.users.id, ownerUserId)).get();
  return row?.role === 'member' && row.launcherId ? row.launcherId : null;
}
