import { signal } from '@preact/signals';
import { api } from '../lib/api.js';

export interface DispatchTarget {
  launcherId: string;
  name: string;
  hostname: string;
  machineName: string | null;
  machineId: string | null;
  isHarness: boolean;
  isSprite?: boolean;
  harnessConfigId: string | null;
  spriteConfigId?: string | null;
  activeSessions: number;
  maxSessions: number;
  online: boolean;
}

export const cachedTargets = signal<DispatchTarget[]>([]);
let lastFetch = 0;

/** Unique selection key for a dispatch target (launcherId alone is not unique for harnesses) */
export function targetKey(t: DispatchTarget): string {
  if (t.isHarness && t.harnessConfigId) return `harness:${t.harnessConfigId}`;
  if (t.isSprite && t.spriteConfigId) return `sprite:${t.spriteConfigId}`;
  return t.launcherId;
}

/** Find a target by its unique key */
export function findTargetByKey(targets: DispatchTarget[], key: string): DispatchTarget | undefined {
  return targets.find(t => targetKey(t) === key);
}

/** Parse a target key into launcherId + optional harnessConfigId for API calls */
export function parseTargetKey(key: string, targets: DispatchTarget[]): { launcherId?: string; harnessConfigId?: string } {
  const t = findTargetByKey(targets, key);
  if (!t) return { launcherId: key || undefined };
  return {
    launcherId: t.launcherId,
    harnessConfigId: t.isHarness && t.harnessConfigId ? t.harnessConfigId : undefined,
  };
}

export async function refreshTargets() {
  try {
    const { targets } = await api.getDispatchTargets();
    cachedTargets.value = targets;
    lastFetch = Date.now();
  } catch {
    // ignore — leave stale data
  }
}

export function ensureTargetsLoaded() {
  if (Date.now() - lastFetch > 10_000) refreshTargets();
}

export function DispatchTargetSelect({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (launcherId: string | undefined) => void;
  className?: string;
}) {
  const targets = cachedTargets.value;

  if (targets.length === 0 && Date.now() - lastFetch > 10_000) {
    refreshTargets();
  }

  if (targets.length === 0) return null;

  const machines = targets.filter(t => !t.isHarness && !t.isSprite);
  const harnesses = targets.filter(t => t.isHarness);
  const sprites = targets.filter(t => t.isSprite);

  return (
    <select
      class={className || 'dispatch-bar-select'}
      value={value}
      onChange={(e) => {
        const v = (e.target as HTMLSelectElement).value;
        onChange(v || undefined);
      }}
      onFocus={() => refreshTargets()}
    >
      <option value="">Local</option>
      {machines.length > 0 && (
        <optgroup label="Machines">
          {machines.map(t => (
            <option key={targetKey(t)} value={targetKey(t)} disabled={!t.online}>
              {t.machineName || t.name}{t.online ? ` (${t.activeSessions}/${t.maxSessions})` : ' (offline)'}
            </option>
          ))}
        </optgroup>
      )}
      {harnesses.length > 0 && (
        <optgroup label="Harnesses">
          {harnesses.map(t => (
            <option key={targetKey(t)} value={targetKey(t)} disabled={!t.online}>
              {t.name}{t.online ? ` (${t.activeSessions}/${t.maxSessions})` : ' (offline)'}
            </option>
          ))}
        </optgroup>
      )}
      {sprites.length > 0 && (
        <optgroup label="Sprites">
          {sprites.map(t => (
            <option key={targetKey(t)} value={targetKey(t)} disabled={!t.online}>
              {t.name}{t.online ? ` (${t.activeSessions}/${t.maxSessions})` : ' (offline)'}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
