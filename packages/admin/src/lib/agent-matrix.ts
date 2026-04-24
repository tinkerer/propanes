// Shared agent-picker model used by Cook It, Quick Dispatch, and Resume As so
// every picker surfaces the same set of run profiles for each runtime (Claude
// / Codex). Profile names follow `<mode>-<perms>` (see
// packages/shared/src/constants.ts).
import { RUNTIME_INFO } from './agent-constants.js';

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

// Structured label used across all agent pickers so users see a consistent set
// of choices regardless of the raw endpoint name configured in the DB.
export function formatAgentOption(agent: {
  runtime?: string | null;
  permissionProfile?: string | null;
  isDefault?: boolean;
}): string {
  const runtime = agent.runtime || 'claude';
  const pd = profileDescriptor(agent.permissionProfile);
  const rt = RUNTIME_INFO[runtime] || RUNTIME_INFO.claude;
  const defaultMarker = agent.isDefault ? ' *' : '';
  return `${rt.icon} ${rt.label} — ${pd.icon} ${pd.label}${defaultMarker}`;
}

// Compare function that orders agents by (runtime preference, profile order)
// so grouped pickers show Claude first, then Codex, each grouped by the matrix
// order above. runtimePref lets callers (e.g. YOLO mode) flip the preferred
// runtime to surface Codex first.
export function agentSortCmp(
  a: { runtime?: string | null; permissionProfile?: string | null; name?: string },
  b: { runtime?: string | null; permissionProfile?: string | null; name?: string },
  runtimePref: Array<'claude' | 'codex'> = ['claude', 'codex'],
): number {
  const runtimeIndex = (r: string | null | undefined) => {
    const idx = runtimePref.indexOf((r || 'claude') as any);
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
