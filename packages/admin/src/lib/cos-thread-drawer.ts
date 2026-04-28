import { signal } from '@preact/signals';

// Drawer state for the slack-mode thread companion in the popout panel.
// Mirrors `cos-artifact-drawer` so the thread floats over the chat from the
// right edge instead of splitting the popout-local pane tree — which used to
// reflow the chat width and remount the scroll container.

export type CosThreadDrawerState = {
  width: number;
  /** When false, only the grab tab on the left edge is visible. */
  visible: boolean;
};

const STORAGE_KEY = 'pw-cos-thread-drawer';
export const THREAD_DRAWER_DEFAULT_WIDTH = 380;
export const THREAD_DRAWER_MIN_WIDTH = 280;

function loadState(): CosThreadDrawerState {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { width: THREAD_DRAWER_DEFAULT_WIDTH, visible: true };
    const p = JSON.parse(raw) as Partial<CosThreadDrawerState>;
    const width = typeof p.width === 'number' && Number.isFinite(p.width)
      ? Math.max(THREAD_DRAWER_MIN_WIDTH, p.width)
      : THREAD_DRAWER_DEFAULT_WIDTH;
    const visible = typeof p.visible === 'boolean' ? p.visible : true;
    return { width, visible };
  } catch {
    return { width: THREAD_DRAWER_DEFAULT_WIDTH, visible: true };
  }
}

function persist() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cosThreadDrawer.value));
    }
  } catch { /* ignore */ }
}

export const cosThreadDrawer = signal<CosThreadDrawerState>(loadState());

export function setThreadDrawerWidth(width: number) {
  const cur = cosThreadDrawer.value;
  const w = Math.max(THREAD_DRAWER_MIN_WIDTH, width);
  if (cur.width === w) return;
  cosThreadDrawer.value = { ...cur, width: w };
  persist();
}

export function setThreadDrawerVisible(next: boolean) {
  const cur = cosThreadDrawer.value;
  if (cur.visible === next) return;
  cosThreadDrawer.value = { ...cur, visible: next };
  persist();
}

export function toggleThreadDrawerVisible() {
  setThreadDrawerVisible(!cosThreadDrawer.value.visible);
}
