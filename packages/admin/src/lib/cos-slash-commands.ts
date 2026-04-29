// Slash commands for the CoS composer. Intercepted in ChiefOfStaffBubble's
// `handleSend` before the message is dispatched as chat — when a known
// command runs, the message is consumed locally and never hits the model.

import { api } from './api.js';
import { adminHeaders } from './admin-headers.js';
import { cosActiveThread } from './cos-popout-tree.js';
import {
  chiefOfStaffActiveId,
  chiefOfStaffAgents,
  loadChiefOfStaffHistory,
  pendingProfileOverride,
} from './chief-of-staff.js';
import { activeChannel, selectedAppId } from './state.js';

export type SlashResult =
  | { handled: false }
  | { handled: true; toast?: string; error?: string };

// Mirrored from @propanes/shared/constants.ts. Admin doesn't take a workspace
// dependency on shared (kept lean intentionally), so the list is inlined and
// must be kept in sync if a new profile lands.
const PERMISSION_PROFILES = [
  'interactive-require',
  'interactive-yolo',
  'headless-yolo',
  'headless-stream-yolo',
  'headless-stream-require',
  'plain',
] as const;

const HELP_TEXT = `Available slash commands:
  /help                       Show this list
  /agent <id|slug>            Switch the active agent tab
  /archive                    Archive the active thread
  /resolve                    Mark the active thread resolved
  /reopen                     Re-open (un-resolve, un-archive) the active thread
  /channel                    Show the active thread's channel info
  /dispatch <agent> <prompt>  Dispatch a real agent against the linked feedback
  /profile <profile-name>     Override the permission profile for the next /dispatch
  /powwow <prompt>            Run a powwow with all agent members of this channel`;

// Strip the `tid:` prefix the rail uses to key reply-anchor threads — every
// other surface (server PATCH, /threads listing) deals in raw thread ids.
function activeThreadId(): string | null {
  const v = cosActiveThread.value;
  if (!v) return null;
  return v.threadKey.startsWith('tid:') ? v.threadKey.slice(4) : null;
}

// Resolve the cosThread row backing the active rail entry. Returns null if
// the active thread is positional (idx:N — never persisted) or not found.
async function fetchActiveThreadRow(): Promise<
  | {
      id: string;
      channelId: string | null;
      feedbackId: string | null;
      agentSessionId: string | null;
    }
  | null
> {
  const tid = activeThreadId();
  if (!tid) return null;
  try {
    const appId = selectedAppId.value;
    const qs = appId ? `?appId=${encodeURIComponent(appId)}` : '';
    const res = await fetch(`/api/v1/admin/chief-of-staff/threads${qs}`, {
      headers: adminHeaders(),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const threads: Array<{
      id: string;
      channelId: string | null;
      feedbackId: string | null;
      agentSessionId: string | null;
    }> = Array.isArray(data?.threads) ? data.threads : [];
    return threads.find((t) => t.id === tid) ?? null;
  } catch {
    return null;
  }
}

// Resolve an agent by id, exact name, or slugified name (lower-case,
// whitespace → '-'). Used by both /dispatch and the @mention auto-dispatch
// in ChiefOfStaffBubble — agent endpoints don't carry a real `slug` column,
// so the slugified name is our convention.
function resolveAgentEndpoint(agents: any[], needle: string) {
  const lower = needle.toLowerCase();
  return agents.find((a) => {
    if (a.id === needle) return true;
    if (typeof a.name !== 'string') return false;
    if (a.name.toLowerCase() === lower) return true;
    if (a.name.toLowerCase().replace(/\s+/g, '-') === lower) return true;
    return false;
  });
}

export async function runSlashCommandIfAny(rawText: string): Promise<SlashResult> {
  const text = rawText.trim();
  if (!text.startsWith('/')) return { handled: false };
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const args = rest.join(' ').trim();

  switch (cmd) {
    case 'help':
      return { handled: true, toast: HELP_TEXT };

    case 'agent': {
      if (!args) return { handled: true, error: 'Usage: /agent <id|slug>' };
      const target = chiefOfStaffAgents.value.find(
        (a) => a.id === args || a.name?.toLowerCase() === args.toLowerCase(),
      );
      if (!target) return { handled: true, error: `Unknown agent: ${args}` };
      chiefOfStaffActiveId.value = target.id;
      return { handled: true, toast: `Switched to ${target.name}` };
    }

    case 'archive':
    case 'resolve':
    case 'reopen': {
      const active = cosActiveThread.value;
      if (!active) return { handled: true, error: 'No active thread to act on.' };
      const body =
        cmd === 'archive' ? { archived: true } :
        cmd === 'resolve' ? { resolved: true } :
        { archived: false, resolved: false };
      try {
        const res = await fetch(`/api/v1/admin/chief-of-staff/threads/${active.threadKey}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('pw-admin-token') || ''}`,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) return { handled: true, error: `HTTP ${res.status}` };
        await loadChiefOfStaffHistory(active.agentId, selectedAppId.value).catch(() => {});
        return { handled: true, toast: `Thread ${cmd}d.` };
      } catch (e) {
        return { handled: true, error: e instanceof Error ? e.message : String(e) };
      }
    }

    case 'channel': {
      const active = cosActiveThread.value;
      if (!active) return { handled: true, error: 'No active thread.' };
      try {
        const res = await fetch(`/api/v1/admin/chief-of-staff/threads?appId=`, {
          headers: { Authorization: `Bearer ${localStorage.getItem('pw-admin-token') || ''}` },
        });
        const data = await res.json();
        const t = (data.threads || []).find((x: { id: string }) => x.id === active.threadKey);
        if (!t) return { handled: true, error: 'Thread not found.' };
        if (!t.channelId) return { handled: true, toast: 'This thread is unsorted (no channel).' };
        return { handled: true, toast: `Thread is in channel ${t.channelId}` };
      } catch (e) {
        return { handled: true, error: e instanceof Error ? e.message : String(e) };
      }
    }

    case 'dispatch': {
      const sp = args.indexOf(' ');
      if (sp <= 0) return { handled: true, error: 'Usage: /dispatch <agentSlug> <prompt>' };
      const slug = args.slice(0, sp).trim();
      const prompt = args.slice(sp + 1).trim();
      if (!slug || !prompt) return { handled: true, error: 'Usage: /dispatch <agentSlug> <prompt>' };

      const threadRow = await fetchActiveThreadRow();
      if (!threadRow) return { handled: true, error: 'No active thread to act on.' };
      if (!threadRow.feedbackId) {
        return { handled: true, error: 'No feedback item linked to this thread.' };
      }

      let agents: any[];
      try {
        agents = await api.getAgents(selectedAppId.value || undefined);
      } catch (e) {
        return { handled: true, error: `Failed to list agents: ${e instanceof Error ? e.message : String(e)}` };
      }
      const agent = resolveAgentEndpoint(agents, slug);
      if (!agent) return { handled: true, error: `Unknown agent: ${slug}` };

      const profileOverride = pendingProfileOverride.value;
      try {
        const res = await api.dispatch({
          feedbackId: threadRow.feedbackId,
          agentEndpointId: agent.id,
          instructions: prompt,
          channelId: activeChannel.value?.id ?? null,
          permissionProfile: profileOverride || undefined,
        });
        // One-shot — clear the override regardless of dispatch outcome so the
        // operator doesn't have to remember to reset it.
        pendingProfileOverride.value = null;
        if (res?.dispatched === false) {
          return { handled: true, error: res.error || 'Dispatch was blocked by channel policy.' };
        }
        const sid = res?.sessionId ? ` (${res.sessionId})` : '';
        return { handled: true, toast: `Dispatched ${agent.name}${sid}.` };
      } catch (e) {
        return { handled: true, error: e instanceof Error ? e.message : String(e) };
      }
    }

    case 'profile': {
      if (!args) {
        return {
          handled: true,
          error: `Usage: /profile <name>. Allowed: ${PERMISSION_PROFILES.join(', ')}`,
        };
      }
      if (!(PERMISSION_PROFILES as readonly string[]).includes(args)) {
        return {
          handled: true,
          error: `Unknown profile: ${args}. Allowed: ${PERMISSION_PROFILES.join(', ')}`,
        };
      }
      pendingProfileOverride.value = args;
      return { handled: true, toast: `Next dispatch will use profile "${args}".` };
    }

    case 'powwow': {
      if (!args) return { handled: true, error: 'Usage: /powwow <prompt>' };
      const channel = activeChannel.value;
      if (!channel) return { handled: true, error: 'No active channel.' };
      if (channel.policy?.powwow?.enabled === false) {
        return { handled: true, error: 'Channel does not allow powwow.' };
      }

      const threadRow = await fetchActiveThreadRow();
      if (!threadRow) return { handled: true, error: 'No active thread to act on.' };
      if (!threadRow.feedbackId) {
        return { handled: true, error: 'No feedback item linked to this thread.' };
      }

      let memberRefIds: string[];
      try {
        const res = await api.getChannelMembers(channel.id);
        memberRefIds = res.members.filter((m) => m.kind === 'agent').map((m) => m.refId);
      } catch (e) {
        return { handled: true, error: `Failed to load channel members: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (memberRefIds.length < 2) {
        return { handled: true, error: 'Powwow needs ≥2 agents in the channel.' };
      }

      let allAgents: any[];
      try {
        allAgents = await api.getAgents(selectedAppId.value || undefined);
      } catch (e) {
        return { handled: true, error: `Failed to list agents: ${e instanceof Error ? e.message : String(e)}` };
      }
      const matched = memberRefIds
        .map((rid) => allAgents.find((a) => a.id === rid))
        .filter(Boolean) as any[];
      if (matched.length < 2) {
        return { handled: true, error: 'Powwow needs ≥2 resolvable agents in the channel.' };
      }
      const [moderator, ...participants] = matched;

      try {
        const res = await api.powwow({
          feedbackId: threadRow.feedbackId,
          moderatorAgentId: moderator.id,
          participantAgentIds: participants.map((a) => a.id),
          instructions: args,
        });
        if (res?.dispatched === false) {
          return { handled: true, error: 'Powwow dispatch was rejected.' };
        }
        const count = participants.length + 1;
        return {
          handled: true,
          toast: `Powwow launched with ${count} agents (mod: ${moderator.name}).`,
        };
      } catch (e) {
        return { handled: true, error: e instanceof Error ? e.message : String(e) };
      }
    }

    default:
      return { handled: true, error: `Unknown command: /${cmd}. Try /help` };
  }
}

// Parse @<agent-slug> mentions from message text. Returns array of agent ids
// referenced; the caller decides whether to auto-dispatch them.
export function parseAgentMentions(text: string): { agentId: string; slug: string }[] {
  const mentions: { agentId: string; slug: string }[] = [];
  const seen = new Set<string>();
  const re = /(?:^|\s)@([a-zA-Z0-9_-]+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const slug = m[1];
    const agent = chiefOfStaffAgents.value.find(
      (a) => a.id === slug || a.name?.toLowerCase().replace(/\s+/g, '-') === slug.toLowerCase(),
    );
    if (agent && !seen.has(agent.id)) {
      seen.add(agent.id);
      mentions.push({ agentId: agent.id, slug });
    }
  }
  return mentions;
}
