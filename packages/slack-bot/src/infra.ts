/** Connected infrastructure: where a session's process runs. ProPanes lists
 * dispatch targets (remote launchers, harnesses, sprites, offline machines)
 * plus the server host itself; `[infra:<name>]` picks one for a new thread.
 * Matching mirrors `[app:…]` — forgiving on case/punctuation, exact beats
 * partial, never a guess between several — and an offline target is refused
 * instead of silently running on the server. */
import type { SectionBlock } from '@slack/bolt';
import { OPEN_INFRA_TERMINAL_ACTION } from './infra-actions';
import { matchTargets } from './targets';
import { escapeMrkdwn } from './format';

export interface InfraTarget {
  launcherId: string;
  name: string;
  hostname?: string | null;
  machineName?: string | null;
  machineId?: string | null;
  online: boolean;
  isHarness?: boolean;
  isSprite?: boolean;
  activeSessions?: number;
  maxSessions?: number;
}

export interface LocalTarget { name: string; hostname?: string | null; machineId?: string | null }

export interface InfraList { targets: InfraTarget[]; localTarget: LocalTarget | null }

/** The server host as a target: `[infra:local]`, or its machine name. */
export const LOCAL_LAUNCHER_ID = 'local';
const LOCAL_ALIASES = ['local', 'server', 'here'];

export type InfraMatch =
  | { kind: 'one'; target: InfraTarget }
  | { kind: 'many'; targets: InfraTarget[] }
  | { kind: 'offline'; target: InfraTarget }
  | { kind: 'none' };

export function normalizeInfraName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function localAsTarget(local: LocalTarget | null): InfraTarget {
  return { launcherId: LOCAL_LAUNCHER_ID, name: local?.name ?? 'this server', hostname: local?.hostname ?? null, machineName: local?.name ?? null, machineId: local?.machineId ?? null, online: true };
}

function keys(t: InfraTarget): string[] {
  const out = [t.name, t.machineName ?? '', t.hostname ?? '', t.launcherId, t.machineId ?? ''];
  if (t.launcherId === LOCAL_LAUNCHER_ID) out.push(...LOCAL_ALIASES);
  return out.filter(Boolean);
}

export function resolveInfra(list: InfraList, query: string): InfraMatch {
  const q = normalizeInfraName(query);
  if (!q) return { kind: 'none' };
  const all = [localAsTarget(list.localTarget), ...list.targets];
  const hits = matchTargets(all, query, t => t.launcherId, keys);
  if (hits.length > 1) return { kind: 'many', targets: hits };
  if (hits.length === 0) return { kind: 'none' };
  return hits[0].online ? { kind: 'one', target: hits[0] } : { kind: 'offline', target: hits[0] };
}

function load(t: InfraTarget): string {
  return t.maxSessions ? ` · ${t.activeSessions ?? 0}/${t.maxSessions} sessions` : '';
}

function infraLine(t: InfraTarget, defaultId?: string, exactSelector = false): string {
  const kind = t.launcherId === LOCAL_LAUNCHER_ID ? 'this server' : t.isHarness ? 'harness' : t.isSprite ? 'sprite' : 'machine';
  const host = t.hostname && normalizeInfraName(t.hostname) !== normalizeInfraName(t.name) ? ` (${escapeMrkdwn(t.hostname)})` : '';
  const state = t.online ? 'online' : 'offline';
  const option = exactSelector ? t.launcherId : t.launcherId === LOCAL_LAUNCHER_ID ? 'local' : t.name.toLowerCase();
  return `• *${escapeMrkdwn(t.name)}*${host} — ${kind} · ${state}${load(t)}${t.launcherId === defaultId ? ' _(default)_' : ''} → \`[infra:${escapeMrkdwn(option)}]\``;
}

export function listInfraText(list: InfraList): string {
  const all = [localAsTarget(list.localTarget), ...list.targets];
  return [
    `*Connected infrastructure* (${all.length}) — start a request with \`[infra:<name>]\` to run the session there; without it sessions run on this server. The application (\`[app:…]\`) is synced to the target.`,
    ...all.map((t) => infraLine(t, LOCAL_LAUNCHER_ID)),
  ].join('\n');
}

/** Each target gets its own block; keep every message below Slack's 50-block limit. */
export function listInfraMessages(list: InfraList): { text: string; blocks: SectionBlock[] }[] {
  const targets = [localAsTarget(list.localTarget), ...list.targets];
  const messages: { text: string; blocks: SectionBlock[] }[] = [];
  for (let offset = 0; offset < targets.length; offset += 40) {
    const rows = targets.slice(offset, offset + 40);
    const heading = offset ? '*Connected infrastructure (continued)*' : `*Connected infrastructure* (${targets.length}) — choose a machine to open a new terminal.`;
    const blocks: SectionBlock[] = [{ type: 'section', text: { type: 'mrkdwn', text: heading } }];
    for (const target of rows) {
      blocks.push({
        type: 'section', text: { type: 'mrkdwn', text: infraLine(target, LOCAL_LAUNCHER_ID).slice(0, 2900) },
        ...(canOpenTerminal(target) ? { accessory: {
          type: 'button' as const, text: { type: 'plain_text' as const, text: 'Open terminal' },
          action_id: OPEN_INFRA_TERMINAL_ACTION, value: target.launcherId,
        } } : {}),
      });
    }
    messages.push({ text: [heading, ...rows.map(t => infraLine(t, LOCAL_LAUNCHER_ID))].join('\n'), blocks });
  }
  return messages;
}

export function canOpenTerminal(target: InfraTarget): boolean {
  return target.online && !target.isHarness && !target.isSprite;
}

export function ambiguousInfraText(query: string, targets: InfraTarget[]): string {
  return [
    `❓ \`infra:${escapeMrkdwn(query)}\` matches ${targets.length} targets — which one?`,
    ...targets.map((t) => infraLine(t, undefined, true)),
    'Mention me again with your request and an exact `[infra:ID]` selector above. Nothing was started.',
  ].join('\n');
}

export function offlineInfraText(target: InfraTarget, list: InfraList): string {
  return [
    `⚠️ *${escapeMrkdwn(target.name)}* is offline (no launcher connected), so the session would silently run on this server instead. Nothing was started.`,
    listInfraText(list),
  ].join('\n');
}

export function unknownInfraText(query: string, list: InfraList): string {
  return [`❓ No infrastructure matches \`infra:${escapeMrkdwn(query)}\`.`, listInfraText(list), 'Nothing was started.'].join('\n');
}
