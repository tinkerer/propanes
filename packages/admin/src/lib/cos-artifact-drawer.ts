import { signal } from '@preact/signals';

// Drawer state for CoS artifact popouts in the floating popout panel.
// Keeping artifacts here (instead of inside cos-popout-tree) avoids splitting
// the chat leaf when an artifact opens — splits cause Preact to remount the
// chat into a new SplitPane parent, which loses the chat scroll position.
// The drawer renders as an absolute-positioned overlay over the chat tree.

export type CosArtifactDrawerState = {
  tabs: string[];
  activeTabId: string | null;
  width: number;
};

const STORAGE_KEY = 'pw-cos-artifact-drawer';
export const ARTIFACT_DRAWER_DEFAULT_WIDTH = 440;
export const ARTIFACT_DRAWER_MIN_WIDTH = 240;

function loadState(): CosArtifactDrawerState {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { tabs: [], activeTabId: null, width: ARTIFACT_DRAWER_DEFAULT_WIDTH };
    const p = JSON.parse(raw) as Partial<CosArtifactDrawerState>;
    const tabs = Array.isArray(p.tabs) ? p.tabs.filter((t) => typeof t === 'string') : [];
    const activeTabId = typeof p.activeTabId === 'string' && tabs.includes(p.activeTabId)
      ? p.activeTabId
      : tabs[0] ?? null;
    const width = typeof p.width === 'number' && Number.isFinite(p.width)
      ? Math.max(ARTIFACT_DRAWER_MIN_WIDTH, p.width)
      : ARTIFACT_DRAWER_DEFAULT_WIDTH;
    return { tabs, activeTabId, width };
  } catch {
    return { tabs: [], activeTabId: null, width: ARTIFACT_DRAWER_DEFAULT_WIDTH };
  }
}

function persist() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cosArtifactDrawer.value));
    }
  } catch { /* ignore */ }
}

export const cosArtifactDrawer = signal<CosArtifactDrawerState>(loadState());

export function openArtifactDrawerTab(artifactId: string) {
  const cur = cosArtifactDrawer.value;
  if (cur.tabs.includes(artifactId)) {
    if (cur.activeTabId !== artifactId) {
      cosArtifactDrawer.value = { ...cur, activeTabId: artifactId };
      persist();
    }
    return;
  }
  cosArtifactDrawer.value = {
    ...cur,
    tabs: [...cur.tabs, artifactId],
    activeTabId: artifactId,
  };
  persist();
}

export function closeArtifactDrawerTab(artifactId: string) {
  const cur = cosArtifactDrawer.value;
  const idx = cur.tabs.indexOf(artifactId);
  if (idx === -1) return;
  const newTabs = cur.tabs.filter((t) => t !== artifactId);
  let newActive = cur.activeTabId;
  if (cur.activeTabId === artifactId) {
    newActive = newTabs[Math.max(0, idx - 1)] ?? newTabs[0] ?? null;
  }
  cosArtifactDrawer.value = { tabs: newTabs, activeTabId: newActive, width: cur.width };
  persist();
}

export function setActiveArtifactDrawerTab(artifactId: string) {
  const cur = cosArtifactDrawer.value;
  if (!cur.tabs.includes(artifactId)) return;
  if (cur.activeTabId === artifactId) return;
  cosArtifactDrawer.value = { ...cur, activeTabId: artifactId };
  persist();
}

export function setArtifactDrawerWidth(width: number) {
  const cur = cosArtifactDrawer.value;
  const w = Math.max(ARTIFACT_DRAWER_MIN_WIDTH, width);
  if (cur.width === w) return;
  cosArtifactDrawer.value = { ...cur, width: w };
  persist();
}

export function closeArtifactDrawer() {
  const cur = cosArtifactDrawer.value;
  if (cur.tabs.length === 0 && cur.activeTabId === null) return;
  cosArtifactDrawer.value = { tabs: [], activeTabId: null, width: cur.width };
  persist();
}

export function isArtifactDrawerOpen(): boolean {
  return cosArtifactDrawer.value.tabs.length > 0;
}
