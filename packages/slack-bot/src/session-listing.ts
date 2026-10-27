import type { AppInfo } from './apps';
import { coalesce, escapeMrkdwn } from './format';
import { isLive, type SessionInfo } from './propanes';

/** Keep labels on one line and prevent titles from injecting Slack link syntax. */
function label(value: string): string {
  return escapeMrkdwn(value.replace(/\s+/g, ' ').replace(/\|/g, '¦').trim().slice(0, 160));
}

export const CONTINUE_IN_SLACK_HINT = 'Reply with the number to continue the session in Slack.';

/** The listed rows grouped by application (API order within each), in the
 * order they are printed — agent session numbers index into this list. */
export function listedSessions(sessions: SessionInfo[], terminals: boolean, app?: AppInfo): SessionInfo[][] {
  const rows = sessions.filter(s => isLive(s.status)
    && (s.permissionProfile === 'plain') === terminals
    && (!app || s.appId === app.id));
  const groups = new Map<string | null, SessionInfo[]>();
  for (const s of rows) {
    const key = terminals ? null : s.appId || null;
    const group = groups.get(key) || [];
    group.push(s);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Agent sessions are numbered across app groups so a reply can pick one;
 * terminals stay a plain bulleted list. */
export function sessionListing(
  sessions: SessionInfo[],
  terminals: boolean,
  sessionUrl: (id: string) => string,
  app?: AppInfo,
  apps: AppInfo[] = [],
): string[] {
  const groups = listedSessions(sessions, terminals, app);
  const count = groups.reduce((n, g) => n + g.length, 0);
  const kind = terminals ? 'terminals' : 'sessions';
  const scope = app ? ` for ${label(app.name)}` : '';
  if (!count) return [`No active ${kind}${scope}.`];
  const lines = [`*Active ${kind}${scope}* (${count})`];
  const appNames = new Map(apps.map(a => [a.id, a.name]));
  if (app) appNames.set(app.id, app.name);
  let n = 0;
  for (const group of groups) {
    const appId = group[0].appId || null;
    const appName = appId ? appNames.get(appId) || `Unknown app (${appId})` : 'No app';
    for (const [index, s] of group.entries()) {
      const title = label(s.title || s.feedbackTitle || s.id);
      const state = s.inputState === 'waiting' ? `${s.status}, waiting for input`
        : s.inputState === 'idle' ? `${s.status}, idle` : s.status;
      const infra = s.machineName || s.launcherName;
      const heading = !terminals && index === 0 ? `*${label(appName)}*\n` : '';
      const marker = terminals ? '•' : `${++n}.`;
      lines.push(`${heading}${marker} <${sessionUrl(s.id)}|${title}> · ${label(s.id)} · ${terminals ? 'shell' : label(s.runtime || 'agent')} · ${label(state)}${infra ? ` · ${label(infra)}` : ''}`);
    }
  }
  if (!terminals) lines.push(`_${CONTINUE_IN_SLACK_HINT}_`);
  return coalesce(lines);
}
