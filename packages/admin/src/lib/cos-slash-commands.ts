// Slash commands for the CoS composer. Intercepted in ChiefOfStaffBubble's
// `handleSend` before the message is dispatched as chat — when a known
// command runs, the message is consumed locally and never hits the model.

import { api } from './api.js';
import { cosActiveThread } from './cos-popout-tree.js';
import {
  chiefOfStaffActiveId,
  chiefOfStaffAgents,
  loadChiefOfStaffHistory,
} from './chief-of-staff.js';
import { selectedAppId } from './state.js';

export type SlashResult =
  | { handled: false }
  | { handled: true; toast?: string; error?: string };

const HELP_TEXT = `Available slash commands:
  /help                       Show this list
  /agent <id|slug>            Switch the active agent tab
  /archive                    Archive the active thread
  /resolve                    Mark the active thread resolved
  /reopen                     Re-open (un-resolve, un-archive) the active thread
  /channel                    Show the active thread's channel info`;

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
