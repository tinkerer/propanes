import { signal, effect } from '@preact/signals';

export type Theme = 'light' | 'dark' | 'system';

function loadSetting<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export const theme = signal<Theme>(loadSetting('pw-theme', 'system'));
export const shortcutsEnabled = signal<boolean>(loadSetting('pw-shortcuts-enabled', true));
export const tooltipsEnabled = signal<boolean>(loadSetting('pw-tooltips-enabled', true));
export const showTabs = signal<boolean>(loadSetting('pw-show-tabs', true));
export const arrowTabSwitching = signal<boolean>(loadSetting('pw-arrow-tab-switching', true));
export const multiDigitTabs = signal<boolean>(loadSetting('pw-multi-digit-tabs', true));
export const autoNavigateToFeedback = signal<boolean>(loadSetting('pw-auto-navigate-feedback', false));
export const showHotkeyHints = signal<boolean>(loadSetting('pw-show-hotkey-hints', true));
export const autoJumpWaiting = signal<boolean>(loadSetting('pw-auto-jump-waiting', false));
export const autoJumpInterrupt = signal<boolean>(loadSetting('pw-auto-jump-interrupt', false));
export const autoJumpDelay = signal<boolean>(loadSetting('pw-auto-jump-delay', false));
export const autoJumpShowPopup = signal<boolean>(loadSetting('pw-auto-jump-show-popup', true));
export const autoJumpLogs = signal<boolean>(loadSetting('pw-auto-jump-logs', false));
export const autoCloseWaitingPanel = signal<boolean>(loadSetting('pw-auto-close-waiting-panel', false));
export const autoJumpHandleBounce = signal<boolean>(loadSetting('pw-auto-jump-handle-bounce', true));

export interface RecentResult {
  type: 'application' | 'feedback' | 'session';
  id: string;
  title: string;
  subtitle?: string;
  icon: string;
  route: string;
}

export const recentResults = signal<RecentResult[]>(loadSetting('pw-recent-results', []));

export type PopoutMode = 'panel' | 'window' | 'tab';
export const popoutMode = signal<PopoutMode>(loadSetting('pw-popout-mode', 'panel'));

export const localBridgeUrl = signal<string>(loadSetting('pw-local-bridge-url', 'http://localhost:3001'));

export interface SshConfig {
  sshUser: string;
  sshHost: string;
  sshPort?: number;
}
export const sshConfigs = signal<Record<string, SshConfig>>(loadSetting('pw-ssh-configs', {}));

export function getEffectiveTheme(): 'light' | 'dark' {
  if (theme.value !== 'system') return theme.value;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme() {
  const el = document.documentElement;
  if (theme.value === 'system') {
    el.removeAttribute('data-theme');
  } else {
    el.setAttribute('data-theme', theme.value);
  }
}

export function setTheme(t: Theme) {
  theme.value = t;
}

export function toggleTheme() {
  const effective = getEffectiveTheme();
  theme.value = effective === 'dark' ? 'light' : 'dark';
}

// Persist settings to localStorage
effect(() => {
  localStorage.setItem('pw-theme', JSON.stringify(theme.value));
  applyTheme();
});

effect(() => {
  localStorage.setItem('pw-shortcuts-enabled', JSON.stringify(shortcutsEnabled.value));
});

effect(() => {
  localStorage.setItem('pw-tooltips-enabled', JSON.stringify(tooltipsEnabled.value));
});

effect(() => {
  localStorage.setItem('pw-show-tabs', JSON.stringify(showTabs.value));
});

effect(() => {
  localStorage.setItem('pw-arrow-tab-switching', JSON.stringify(arrowTabSwitching.value));
});

effect(() => {
  localStorage.setItem('pw-multi-digit-tabs', JSON.stringify(multiDigitTabs.value));
});

effect(() => {
  localStorage.setItem('pw-auto-navigate-feedback', JSON.stringify(autoNavigateToFeedback.value));
});

effect(() => {
  localStorage.setItem('pw-show-hotkey-hints', JSON.stringify(showHotkeyHints.value));
});

effect(() => {
  localStorage.setItem('pw-popout-mode', JSON.stringify(popoutMode.value));
});

effect(() => {
  localStorage.setItem('pw-auto-jump-waiting', JSON.stringify(autoJumpWaiting.value));
});

effect(() => {
  localStorage.setItem('pw-auto-jump-interrupt', JSON.stringify(autoJumpInterrupt.value));
});

effect(() => {
  localStorage.setItem('pw-auto-jump-delay', JSON.stringify(autoJumpDelay.value));
});

effect(() => {
  localStorage.setItem('pw-auto-jump-show-popup', JSON.stringify(autoJumpShowPopup.value));
});

effect(() => {
  localStorage.setItem('pw-auto-jump-logs', JSON.stringify(autoJumpLogs.value));
});

effect(() => {
  localStorage.setItem('pw-auto-close-waiting-panel', JSON.stringify(autoCloseWaitingPanel.value));
});

effect(() => {
  localStorage.setItem('pw-auto-jump-handle-bounce', JSON.stringify(autoJumpHandleBounce.value));
});

effect(() => {
  localStorage.setItem('pw-recent-results', JSON.stringify(recentResults.value));
});

effect(() => {
  localStorage.setItem('pw-local-bridge-url', JSON.stringify(localBridgeUrl.value));
});

effect(() => {
  localStorage.setItem('pw-ssh-configs', JSON.stringify(sshConfigs.value));
});

// Listen for system theme changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (theme.value === 'system') {
    applyTheme();
  }
});

// Apply theme immediately on load
applyTheme();
