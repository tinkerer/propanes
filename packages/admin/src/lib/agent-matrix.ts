// Shared agent-picker model used by Cook It, Quick Dispatch, and Resume As so
// every picker surfaces the same set of run profiles for each runtime (Claude
// / Codex). Profile names follow `<mode>-<perms>` (see
// packages/shared/src/constants.ts).
// Kept free of imports so the picker logic stays unit-testable outside a
// browser (agent-constants pulls in localStorage/window-bound modules).

export interface ProfileDescriptor {
  label: string;          // short label used in chips / dropdowns
  longLabel: string;      // descriptive label used in menu items
  desc: string;           // one-line explanation
  icon: string;
  mode: 'interactive' | 'headless' | 'headless-stream' | 'plain';
  yolo: boolean;
}

export const PROFILE_MATRIX: Record<string, ProfileDescriptor> = {
  'interactive-require': {
    label: 'Interactive',
    longLabel: 'Interactive (supervised)',
    desc: 'You approve each tool use',
    icon: '\u{1F441}',
    mode: 'interactive',
    yolo: false,
  },
  'interactive-yolo': {
    label: 'YOLO',
    longLabel: 'YOLO (skip permissions)',
    desc: 'Interactive, but dangerously skips permission checks',
    icon: '⚡',
    mode: 'interactive',
    yolo: true,
  },
  'headless-yolo': {
    label: 'Headless',
    longLabel: 'Headless (JSONL, skip permissions)',
    desc: 'One-shot background session; structured JSONL output',
    icon: '\u{1F916}',
    mode: 'headless',
    yolo: true,
  },
  'headless-stream-yolo': {
    label: 'Stream',
    longLabel: 'Stream (bidirectional JSON, skip permissions)',
    desc: 'Persistent agent stream; turns streamed over JSON',
    icon: '\u{1F50C}',
    mode: 'headless-stream',
    yolo: true,
  },
  'headless-stream-require': {
    label: 'Stream (supervised)',
    longLabel: 'Stream (bidirectional JSON, ask permissions)',
    desc: 'Persistent agent stream with UI-delivered approval prompts',
    icon: '\u{1F50B}',
    mode: 'headless-stream',
    yolo: false,
  },
  plain: {
    label: 'Terminal',
    longLabel: 'Plain terminal',
    desc: 'Shell only, no agent',
    icon: '\u{1F5A5}️',
    mode: 'plain',
    yolo: false,
  },
};

// Ordered list of the dispatchable profiles; pickers render in this order.
export const DISPATCHABLE_PROFILES = [
  'interactive-require',
  'interactive-yolo',
  'headless-yolo',
  'headless-stream-yolo',
  'headless-stream-require',
] as const;

export function profileDescriptor(profile?: string | null): ProfileDescriptor {
  return PROFILE_MATRIX[profile || 'interactive-require'] || PROFILE_MATRIX['interactive-require'];
}

// Compare function that orders agents by (runtime, profile order) so grouped
// pickers show Claude first, then Codex, each grouped by the matrix order
// above.
export function agentSortCmp(
  a: { runtime?: string | null; permissionProfile?: string | null; name?: string },
  b: { runtime?: string | null; permissionProfile?: string | null; name?: string },
): number {
  const RUNTIME_ORDER = ['claude', 'codex'];
  const runtimeIndex = (r: string | null | undefined) => {
    const idx = RUNTIME_ORDER.indexOf(r || 'claude');
    return idx === -1 ? 99 : idx;
  };
  const profileIndex = (p: string | null | undefined) => {
    const idx = (DISPATCHABLE_PROFILES as readonly string[]).indexOf(p || 'interactive-require');
    return idx === -1 ? 99 : idx;
  };
  const ra = runtimeIndex(a.runtime);
  const rb = runtimeIndex(b.runtime);
  if (ra !== rb) return ra - rb;
  const pa = profileIndex(a.permissionProfile);
  const pb = profileIndex(b.permissionProfile);
  if (pa !== pb) return pa - pb;
  return (a.name || '').localeCompare(b.name || '');
}

export function isDispatchableAgent(agent: {
  mode?: string | null;
  url?: string | null;
}): boolean {
  return agent.mode !== 'webhook' || !!agent.url;
}

export function pickYoloAgent<T extends {
  appId?: string | null;
  isDefault?: boolean;
  mode?: string | null;
  name?: string;
  permissionProfile?: string | null;
  runtime?: string | null;
  url?: string | null;
}>(agents: T[], appId?: string | null): T | undefined {
  const ordered = [...agents].filter(isDispatchableAgent).sort(agentSortCmp);
  for (const profile of ['interactive-yolo', 'headless-yolo', 'headless-stream-yolo'] as const) {
    const match = (a: T) => a.permissionProfile === profile;
    const hit = ordered.find(a => match(a) && a.isDefault && a.appId === appId)
      || ordered.find(a => match(a) && a.isDefault && !a.appId)
      || ordered.find(a => match(a) && a.appId === appId)
      || ordered.find(match);
    if (hit) return hit;
  }
  return undefined;
}

// The dispatch pickers deliberately offer just four choices — Claude YOLO,
// Codex YOLO, Claude Interactive, Codex Interactive — no matter how many
// endpoints are configured. Listing every endpoint row repeated the same
// label once per application (each app carries its own copies), which read as
// a wall of identical "Claude — YOLO" entries.
const RUNTIME_LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
export const PICKER_PROFILES = ['interactive-yolo', 'interactive-require'] as const;

export interface PickerAgentShape {
  id: string;
  appId?: string | null;
  isDefault?: boolean;
  mode?: string | null;
  name?: string;
  permissionProfile?: string | null;
  runtime?: string | null;
  url?: string | null;
}

const pickerKey = (a: { runtime?: string | null; permissionProfile?: string | null }) =>
  `${a.runtime || 'claude'}|${a.permissionProfile || 'interactive-require'}`;

/**
 * One endpoint per (runtime, profile), ordered YOLO-first then by runtime.
 * Within a slot the endpoint scoped to `appId` wins, then a global one, then
 * (only reachable from the app-less "+" composer) another app's; defaults
 * break ties. Falls back to every profile when none of the four exist, so a
 * headless-only setup still has something to pick.
 */
export function pickerAgents<T extends PickerAgentShape>(agents: T[], appId?: string | null): T[] {
  const scope = (a: T) => (appId && a.appId === appId ? 0 : !a.appId ? 1 : 2);
  const ranked = agents.filter(isDispatchableAgent).sort((a, b) =>
    scope(a) - scope(b)
    || Number(!!b.isDefault) - Number(!!a.isDefault)
    || (a.name || '').localeCompare(b.name || ''));
  const slots = new Map<string, T>();
  for (const a of ranked) {
    if (!slots.has(pickerKey(a))) slots.set(pickerKey(a), a);
  }
  const all = Array.from(slots.values());
  const simple = all.filter(a => (PICKER_PROFILES as readonly string[]).includes(a.permissionProfile || 'interactive-require'));
  const profileIndex = (a: T) => {
    const p = a.permissionProfile || 'interactive-require';
    const idx = (PICKER_PROFILES as readonly string[]).indexOf(p);
    return idx !== -1 ? idx : PICKER_PROFILES.length + (DISPATCHABLE_PROFILES as readonly string[]).indexOf(p);
  };
  return (simple.length > 0 ? simple : all).sort((a, b) => profileIndex(a) - profileIndex(b) || agentSortCmp(a, b));
}

/**
 * Map an endpoint id (a saved selection, a computed default) onto the picker
 * option covering the same runtime + profile. Returns '' when nothing matches.
 */
export function resolvePickerAgentId<T extends PickerAgentShape>(options: T[], agents: T[], id?: string | null): string {
  if (!id) return '';
  if (options.some(o => o.id === id)) return id;
  const agent = agents.find(a => a.id === id);
  if (!agent) return '';
  return options.find(o => pickerKey(o) === pickerKey(agent))?.id || '';
}

/** "⚡ Claude YOLO" / "👁 Codex Interactive". */
export function formatPickerOption(agent: { runtime?: string | null; permissionProfile?: string | null }): string {
  const pd = profileDescriptor(agent.permissionProfile);
  const runtime = agent.runtime || 'claude';
  return `${pd.icon} ${RUNTIME_LABELS[runtime] || runtime} ${pd.label}`;
}
