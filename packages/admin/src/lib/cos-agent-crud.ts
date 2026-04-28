// Chief-of-Staff agent CRUD helpers.
//
// The CoS panel keeps a list of named agents (different system prompts +
// verbosity/style). This module owns the operator-facing CRUD: rename,
// re-prompt, model/verbosity/style updates, history clear, interrupts,
// add, remove. It mutates the same chiefOfStaffAgents/chiefOfStaffActiveId
// signals owned by `chief-of-staff.ts`, going through the small `updateAgent`
// helper exported from there.
//
// `clearActiveAgentHistory` and `interruptActiveAgent` also delete server-
// side cosThreads, since each top-level UI thread maps 1:1 to a server
// thread.

import {
  chiefOfStaffAgents,
  chiefOfStaffActiveId,
  getActiveAgent,
  updateAgent,
  DEFAULT_VERBOSITY,
  DEFAULT_STYLE,
  type ChiefOfStaffAgent,
  type ChiefOfStaffVerbosity,
  type ChiefOfStaffStyle,
} from './chief-of-staff.js';
import { adminHeaders } from './admin-headers.js';

async function listThreadIdsForAgent(agentId: string, appId: string | null): Promise<string[]> {
  try {
    const headers: Record<string, string> = { ...adminHeaders() };
    const qs = new URLSearchParams({ agentId });
    if (appId) qs.set('appId', appId);
    const res = await fetch(`/api/v1/admin/chief-of-staff/threads?${qs.toString()}`, { headers });
    if (!res.ok) return [];
    const data = await res.json();
    const threads = Array.isArray(data?.threads) ? data.threads : [];
    return threads.map((t: any) => t?.id).filter((id: any): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

export async function clearActiveAgentHistory(): Promise<void> {
  const agent = getActiveAgent();
  if (!agent) return;

  const headers: Record<string, string> = { ...adminHeaders() };

  // Delete ALL server-side threads for this agent (across apps). Legacy rows
  // only had one thread per agent; post-fix each top-level UI message has its
  // own thread, so "Clear history" needs to sweep them all.
  const threadIds = await listThreadIdsForAgent(agent.id, null);
  // Include any legacy singleton threadId the UI remembered that might not be
  // visible on the current app filter.
  if (agent.threadId && !threadIds.includes(agent.threadId)) threadIds.push(agent.threadId);
  await Promise.all(
    threadIds.map(async (id) => {
      try {
        await fetch(`/api/v1/admin/chief-of-staff/threads/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers,
        });
      } catch {
        /* non-fatal */
      }
    }),
  );

  updateAgent(agent.id, (a) => ({ ...a, messages: [], threadId: undefined }));
}

/**
 * Interrupt any in-flight turns for this agent. A turn is in-flight when at
 * least one local message is still streaming; we derive the targeted thread
 * ids from those messages. If nothing is streaming locally, fall back to the
 * agent's legacy singleton threadId (pre-multi-thread clients).
 */
export async function interruptActiveAgent(): Promise<void> {
  const agent = getActiveAgent();
  if (!agent) return;

  const targets = new Set<string>();
  for (const m of agent.messages) {
    if (m.streaming && m.threadId) targets.add(m.threadId);
  }
  if (targets.size === 0 && agent.threadId) targets.add(agent.threadId);
  if (targets.size === 0) return;

  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...adminHeaders() };

  await Promise.all(
    Array.from(targets).map(async (id) => {
      try {
        await fetch(`/api/v1/admin/chief-of-staff/threads/${encodeURIComponent(id)}/interrupt`, {
          method: 'POST',
          headers,
        });
      } catch {
        /* non-fatal */
      }
    }),
  );
}

/** Interrupt a single, known thread. Used by per-thread Stop buttons. */
export async function interruptThread(threadId: string): Promise<void> {
  if (!threadId) return;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...adminHeaders() };
    await fetch(`/api/v1/admin/chief-of-staff/threads/${encodeURIComponent(threadId)}/interrupt`, {
      method: 'POST',
      headers,
    });
  } catch {
    /* non-fatal */
  }
}

export function renameActiveAgent(name: string): void {
  updateAgent(chiefOfStaffActiveId.value, (a) => ({ ...a, name: name.slice(0, 60) }));
}

export function updateActiveAgentSystemPrompt(systemPrompt: string): void {
  updateAgent(chiefOfStaffActiveId.value, (a) => ({ ...a, systemPrompt }));
}

export function updateActiveAgentModel(model: string): void {
  updateAgent(chiefOfStaffActiveId.value, (a) => ({ ...a, model }));
}

export function updateActiveAgentVerbosity(verbosity: ChiefOfStaffVerbosity): void {
  updateAgent(chiefOfStaffActiveId.value, (a) => ({ ...a, verbosity }));
}

export function updateActiveAgentStyle(style: ChiefOfStaffStyle): void {
  updateAgent(chiefOfStaffActiveId.value, (a) => ({ ...a, style }));
}

export function addAgent(name: string): string {
  const id = `agent-${Date.now().toString(36)}`;
  const agent: ChiefOfStaffAgent = {
    id,
    name: name.slice(0, 60) || 'New Agent',
    systemPrompt: '',
    model: '',
    messages: [],
    verbosity: DEFAULT_VERBOSITY,
    style: DEFAULT_STYLE,
  };
  chiefOfStaffAgents.value = [...chiefOfStaffAgents.value, agent];
  chiefOfStaffActiveId.value = id;
  return id;
}

export function removeActiveAgent(): void {
  const remaining = chiefOfStaffAgents.value.filter((a) => a.id !== chiefOfStaffActiveId.value);
  if (remaining.length === 0) {
    // Don't allow removing the last agent — reset it instead
    void clearActiveAgentHistory();
    return;
  }
  chiefOfStaffAgents.value = remaining;
  chiefOfStaffActiveId.value = remaining[0].id;
}
