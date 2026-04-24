import { signal } from '@preact/signals';

export type CosArtifactKind = 'code' | 'list' | 'table';

export type CosArtifact = {
  id: string;
  kind: CosArtifactKind;
  label: string;
  meta: string;
  lang?: string;
  filename?: string;
  raw: string;
  createdAt: number;
};

export const cosArtifacts = signal<Record<string, CosArtifact>>({});

const DRAWER_STORAGE_KEY = 'pw-cos-drawer-artifacts';

type DrawerState = { ids: string[]; activeId: string | null };

function loadDrawerState(): DrawerState {
  if (typeof localStorage === 'undefined') return { ids: [], activeId: null };
  try {
    const raw = localStorage.getItem(DRAWER_STORAGE_KEY);
    if (!raw) return { ids: [], activeId: null };
    const parsed = JSON.parse(raw);
    const ids = Array.isArray(parsed?.ids) ? parsed.ids.filter((x: unknown) => typeof x === 'string') : [];
    const activeId = typeof parsed?.activeId === 'string' ? parsed.activeId : null;
    return { ids, activeId: activeId && ids.includes(activeId) ? activeId : (ids[0] ?? null) };
  } catch {
    return { ids: [], activeId: null };
  }
}

const initial = loadDrawerState();
export const cosDrawerArtifactIds = signal<string[]>(initial.ids);
export const cosDrawerActiveId = signal<string | null>(initial.activeId);

function persistDrawerState() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(DRAWER_STORAGE_KEY, JSON.stringify({
      ids: cosDrawerArtifactIds.value,
      activeId: cosDrawerActiveId.value,
    }));
  } catch { /* ignore */ }
}

export function toggleCosArtifactDrawer(id: string) {
  const ids = cosDrawerArtifactIds.value;
  if (ids.includes(id)) {
    if (cosDrawerActiveId.value === id) {
      // Clicking the popout icon on the currently-visible artifact closes it.
      closeCosArtifactDrawer(id);
    } else {
      cosDrawerActiveId.value = id;
      persistDrawerState();
    }
    return;
  }
  cosDrawerArtifactIds.value = [...ids, id];
  cosDrawerActiveId.value = id;
  persistDrawerState();
}

export function closeCosArtifactDrawer(id: string) {
  const ids = cosDrawerArtifactIds.value;
  const idx = ids.indexOf(id);
  if (idx < 0) return;
  const next = ids.filter((x) => x !== id);
  cosDrawerArtifactIds.value = next;
  if (cosDrawerActiveId.value === id) {
    cosDrawerActiveId.value = next[Math.min(idx, next.length - 1)] ?? null;
  }
  persistDrawerState();
}

export function setCosArtifactDrawerActive(id: string) {
  if (!cosDrawerArtifactIds.value.includes(id)) return;
  cosDrawerActiveId.value = id;
  persistDrawerState();
}

function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

export function artifactIdFor(kind: CosArtifactKind, raw: string): string {
  return `${kind}-${hashStr(raw)}`;
}

export function registerCosArtifact(a: Omit<CosArtifact, 'id' | 'createdAt'> & { id?: string }): CosArtifact {
  const id = a.id || artifactIdFor(a.kind, a.raw);
  const existing = cosArtifacts.value[id];
  if (existing) return existing;
  const entry: CosArtifact = { ...a, id, createdAt: Date.now() };
  cosArtifacts.value = { ...cosArtifacts.value, [id]: entry };
  return entry;
}

export function getCosArtifact(id: string): CosArtifact | null {
  return cosArtifacts.value[id] ?? null;
}
