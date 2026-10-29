/** ProPanes applications: which project a Slack request's session runs in.
 * Chosen per request with `[app:<name>]`, otherwise the configured default.
 * Matching is forgiving (case, spaces, punctuation; name, id or project
 * directory name) but never guesses between several candidates. */
import { matchTargets } from './targets';
import { escapeMrkdwn } from './format';

export interface AppInfo {
  id: string;
  name: string;
  projectDir?: string | null;
  description?: string | null;
  /** Another user's copy (onboarded members get their own apps); names
   * resolve to the requester's own apps first. */
  othersApp?: boolean;
}

export type AppMatch =
  | { kind: 'one'; app: AppInfo }
  | { kind: 'many'; apps: AppInfo[] }
  | { kind: 'none' };

export function normalizeAppName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function dirName(app: AppInfo): string {
  const dir = (app.projectDir ?? '').replace(/\/+$/, '');
  return dir.slice(dir.lastIndexOf('/') + 1);
}

/** Exact (id, name or project directory name) beats partial and typo matching;
 * the requester's own apps beat other users' copies; several hits are
 * reported, never picked from. */
export function resolveApp(apps: readonly AppInfo[], query: string): AppMatch {
  const all = matchTargets(apps, query, a => a.id, a => [a.name, dirName(a)]);
  const own = all.filter(a => !a.othersApp);
  const matches = own.length ? own : all;
  if (matches.length === 1) return { kind: 'one', app: matches[0] };
  if (matches.length > 1) return { kind: 'many', apps: matches };
  return { kind: 'none' };
}

/** The configured default: a name/id query first, else the legacy app id, else the first registered app. */
export function defaultApp(apps: readonly AppInfo[], query: string | undefined, fallbackId: string): AppInfo {
  if (query) {
    const m = resolveApp(apps, query);
    if (m.kind === 'one') return m.app;
  }
  return apps.find((a) => a.id === fallbackId) ?? apps[0] ?? { id: fallbackId, name: fallbackId };
}

function appLine(app: AppInfo, defaultId?: string, exactSelector = false): string {
  const dir = dirName(app);
  return `• *${escapeMrkdwn(app.name)}*${dir ? ` — \`${escapeMrkdwn(dir)}\`` : ''}${app.id === defaultId ? ' _(default)_' : ''} → \`[app:${escapeMrkdwn(exactSelector ? app.id : app.name.toLowerCase())}]\``;
}

export function listAppsText(apps: readonly AppInfo[], defaultId?: string): string {
  if (!apps.length) return 'No applications are registered in ProPanes.';
  const own = apps.filter((a) => !a.othersApp);
  const others = apps.filter((a) => a.othersApp);
  return [
    `*Applications* (${apps.length}) — start a request with \`[app:<name>]\` to run it in that project; without it the default is used.`,
    ...own.map((a) => appLine(a, defaultId)),
    ...(others.length ? ['_Other users\' apps (select by id; names prefer yours):_', ...others.map((a) => appLine(a, defaultId, true))] : []),
  ].join('\n');
}

export function ambiguousAppText(query: string, apps: readonly AppInfo[]): string {
  return [
    `❓ \`app:${escapeMrkdwn(query)}\` matches ${apps.length} applications — which one?`,
    ...apps.map((a) => appLine(a, undefined, true)),
    'Mention me again with your request and an exact `[app:ID]` selector above. Nothing was started.',
  ].join('\n');
}

export function unknownAppText(query: string, apps: readonly AppInfo[], defaultId?: string): string {
  return [
    `❓ No application matches \`app:${escapeMrkdwn(query)}\`. Registered applications:`,
    ...apps.map((a) => appLine(a, defaultId)),
    'Nothing was started.',
  ].join('\n');
}
