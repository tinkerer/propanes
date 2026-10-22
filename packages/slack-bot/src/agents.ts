/** Resolve runtime requests to real ProPanes agent endpoints; never substitute another runtime. */
import type { Runtime } from './options';

export interface AgentEndpointInfo {
  id: string;
  name?: string;
  runtime?: string | null;
  permissionProfile?: string | null;
  mode?: string | null;
  url?: string | null;
  isDefault?: boolean | null;
  appId?: string | null;
}

export class AgentUnavailableError extends Error {
  constructor(public readonly runtime: Runtime, detail: string) {
    super(`No usable ${runtimeLabel(runtime)} agent endpoint: ${detail}`);
    this.name = 'AgentUnavailableError';
  }
}

export function runtimeLabel(runtime: Runtime | string | null | undefined): string {
  return runtime === 'codex' ? 'Codex' : 'Claude';
}

export function endpointRuntime(agent: AgentEndpointInfo): Runtime {
  return agent.runtime === 'codex' ? 'codex' : 'claude';
}

// Skip-permission profiles only: nobody answers permission prompts from Slack.
// Interactive TTY first so follow-up replies reach the same live conversation.
const PREFERRED_PROFILES = ['interactive-yolo', 'headless-stream-yolo', 'headless-yolo'] as const;

function usable(agent: AgentEndpointInfo): boolean {
  return agent.mode !== 'webhook' || !!agent.url;
}

/** The ProPanes default: the app's default endpoint, else the global default, else Claude. */
export function configuredDefaultRuntime(agents: AgentEndpointInfo[], appId: string): Runtime {
  const def = agents.find((a) => a.isDefault && a.appId === appId)
    || agents.find((a) => a.isDefault && !a.appId)
    || agents.find((a) => a.isDefault);
  return def ? endpointRuntime(def) : 'claude';
}

export function resolveAgentEndpoint(
  agents: AgentEndpointInfo[],
  runtime: Runtime,
  appId: string,
  overrideId?: string,
): AgentEndpointInfo {
  if (overrideId) {
    const forced = agents.find((a) => a.id === overrideId);
    if (!forced) throw new AgentUnavailableError(runtime, `AGENT_ENDPOINT_ID ${overrideId} is not registered for this app`);
    if (endpointRuntime(forced) !== runtime) {
      throw new AgentUnavailableError(runtime, `AGENT_ENDPOINT_ID points at a ${runtimeLabel(endpointRuntime(forced))} endpoint`);
    }
    return forced;
  }
  const candidates = agents.filter((a) => usable(a) && endpointRuntime(a) === runtime);
  if (!candidates.length) throw new AgentUnavailableError(runtime, 'no endpoint with that runtime is registered');
  for (const profile of PREFERRED_PROFILES) {
    const match = (a: AgentEndpointInfo) => a.permissionProfile === profile;
    const hit = candidates.find((a) => match(a) && a.isDefault && a.appId === appId)
      || candidates.find((a) => match(a) && a.isDefault && !a.appId)
      || candidates.find((a) => match(a) && a.appId === appId)
      || candidates.find(match);
    if (hit) return hit;
  }
  throw new AgentUnavailableError(runtime, 'none of its endpoints use a skip-permissions (*-yolo) profile');
}
