import type { AppInfo } from './apps';
import { coalesce, escapeMrkdwn } from './format';
import { isLive, type SessionInfo } from './propanes';

/** Keep labels on one line and prevent titles from injecting Slack link syntax. */
function label(value: string): string {
  return escapeMrkdwn(value.replace(/\s+/g, ' ').replace(/\|/g, '¦').trim().slice(0, 160));
}

export function sessionListing(
  sessions: SessionInfo[],
  terminals: boolean,
  sessionUrl: (id: string) => string,
  app?: AppInfo,
): string[] {
  const rows = sessions.filter(s => isLive(s.status)
    && (s.permissionProfile === 'plain') === terminals
    && (!app || s.appId === app.id));
  const kind = terminals ? 'terminals' : 'sessions';
  const scope = app ? ` for ${label(app.name)}` : '';
  if (!rows.length) return [`No active ${kind}${scope}.`];
  const lines = [`*Active ${kind}${scope}* (${rows.length})`];
  for (const s of rows) {
    const title = label(s.title || s.feedbackTitle || s.id);
    const state = s.inputState === 'waiting' ? `${s.status}, waiting for input`
      : s.inputState === 'idle' ? `${s.status}, idle` : s.status;
    const infra = s.machineName || s.launcherName;
    lines.push(`• <${sessionUrl(s.id)}|${title}> · ${label(s.id)} · ${terminals ? 'shell' : label(s.runtime || 'agent')} · ${label(state)}${infra ? ` · ${label(infra)}` : ''}`);
  }
  return coalesce(lines);
}
