import type {
  WidgetConfig,
  WidgetMode,
  WidgetPosition,
  Collector,
  SubmitOptions,
  UserIdentity,
} from '@propanes/shared';
import {
  DEFAULT_POSITION,
  DEFAULT_MODE,
  DEFAULT_SHORTCUT,
} from '@propanes/shared';
import { WIDGET_CSS } from './styles.js';
import { ImageEditor } from './image-editor.js';
import { installCollectors, collectContext } from './collectors.js';
import { captureScreenshot, stopScreencastStream, type ScreenshotMethod } from './screenshot.js';
import { SessionBridge } from './session.js';
import { startPicker, type SelectedElementInfo } from './element-picker.js';
import { OverlayPanelManager, type PanelType } from './overlay-panels.js';
import { VoiceRecorder, type VoiceRecordingResult, type TimelineItem } from './voice-recorder.js';

type EventHandler = (data: unknown) => void;

const HISTORY_KEY = 'pw-history';
const MAX_HISTORY = 50;

function micErrorMessage(err: unknown): string {
  const code = (err as any)?.code;
  const name = (err as any)?.name;
  if (code === 'INSECURE_CONTEXT') return 'Mic requires HTTPS — this page is loaded over HTTP';
  if (code === 'NOT_SUPPORTED') return 'Mic not supported in this browser';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Mic access denied — allow in browser settings';
  if (name === 'NotFoundError') return 'No microphone found';
  if (name === 'NotReadableError') return 'Mic is in use by another app';
  return 'Could not start microphone';
}

function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback for non-secure contexts (HTTP)
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  return Promise.resolve();
}

// iOS Safari drops `navigator.clipboard.writeText()` calls that happen after an
// `await` because the user-activation transient state expires. The documented
// workaround is `navigator.clipboard.write([new ClipboardItem({ 'text/plain':
// Promise<Blob> })])` called synchronously inside the click handler — Safari
// keeps the activation alive until the promise resolves.
function copyTextDeferred(textPromise: Promise<string>): Promise<void> {
  const Ctor = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  const fallback = () => textPromise.then(text => copyText(text)).catch(() => {});
  if (Ctor && navigator.clipboard?.write) {
    try {
      const blobPromise = textPromise.then(text => new Blob([text], { type: 'text/plain' }));
      return navigator.clipboard.write([new Ctor({ 'text/plain': blobPromise })]).catch(fallback);
    } catch {
      return fallback();
    }
  }
  return fallback();
}

// --- localStorage persistence for widget drafts ---

const STORAGE_SCREENSHOTS_KEY = 'pw-widget-screenshots';
const STORAGE_SELECTIONS_KEY = 'pw-widget-selections';

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)?.[1] || 'image/png';
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function persistScreenshots(blobs: Blob[]) {
  try {
    if (blobs.length === 0) {
      localStorage.removeItem(STORAGE_SCREENSHOTS_KEY);
      return;
    }
    const dataUrls = await Promise.all(blobs.map(blobToDataUrl));
    localStorage.setItem(STORAGE_SCREENSHOTS_KEY, JSON.stringify(dataUrls));
  } catch { /* storage full or unavailable */ }
}

function restoreScreenshotsFromStorage(): Blob[] {
  try {
    const raw = localStorage.getItem(STORAGE_SCREENSHOTS_KEY);
    if (!raw) return [];
    const urls: string[] = JSON.parse(raw);
    return urls.map(dataUrlToBlob);
  } catch { return []; }
}

function persistSelections(elements: SelectedElementInfo[]) {
  try {
    if (elements.length === 0) {
      localStorage.removeItem(STORAGE_SELECTIONS_KEY);
      return;
    }
    localStorage.setItem(STORAGE_SELECTIONS_KEY, JSON.stringify(elements));
  } catch {}
}

function restoreSelectionsFromStorage(): SelectedElementInfo[] {
  try {
    const raw = localStorage.getItem(STORAGE_SELECTIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function clearWidgetDraftStorage() {
  try {
    localStorage.removeItem('pw-widget-draft');
    localStorage.removeItem(STORAGE_SCREENSHOTS_KEY);
    localStorage.removeItem(STORAGE_SELECTIONS_KEY);
  } catch {}
}

export class ProPanesElement {
  private shadow: ShadowRoot;
  private host: HTMLElement;
  private config: WidgetConfig;
  private isOpen = false;
  private identity: UserIdentity | null = null;
  private pendingScreenshots: Blob[] = restoreScreenshotsFromStorage();
  private eventHandlers: Map<string, Set<EventHandler>> = new Map();
  private sessionBridge: SessionBridge;
  private history: string[] = [];
  private historyIndex = -1;
  private currentDraft = '';
  private selectedElements: SelectedElementInfo[] = restoreSelectionsFromStorage();
  private pickerCleanup: (() => void) | null = null;
  private overlayManager: OverlayPanelManager;
  private appId: string;
  private savedDraft = (() => {
    try { return localStorage.getItem('pw-widget-draft') || ''; } catch { return ''; }
  })();
  private savedCollectors = new Set<string>();
  private pickerMultiSelect = false;
  private pickerExcludeWidget = true;
  private pickerIncludeChildren = false;
  private excludeWidget = true;
  private excludeCursor = false;
  private keepStream = false;
  private screenshotMethod: ScreenshotMethod = 'html-to-image';
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private dispatchMode: 'off' | 'once' | 'auto' = 'off';
  private dispatchAgentOverride: string | null = null;
  private pendingPermissionProfile: 'interactive-yolo' | null = null;
  private cachedAgents: Array<Record<string, any>> = [];
  private annotatorOpen = false;
  private adminAlwaysShow = false;
  private voiceRecorder = new VoiceRecorder();
  private voiceResult: VoiceRecordingResult | null = null;
  private appendTargetId: string | null = null;
  private timelineItems: TimelineItem[] = [];
  private micScreenCaptures = false;
  private micHideTranscript = false;
  private micHideWidget = false;
  private voiceListenSessionId: string | null = null;
  private voiceListenSilenceTimer: ReturnType<typeof setInterval> | null = null;
  private voiceListenBlurStart: number | null = null;
  private voiceListenVisibilityHandler: (() => void) | null = null;
  private voiceListenWindowSender: ((win: import('./voice-recorder.js').AmbientWindow) => void) | null = null;
  private brainstormDisabled = false;
  private brainstormGestureHandler: (() => void) | null = null;
  private escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.isOpen) {
      // Let sub-overlays (annotator, element picker) handle Escape first
      if (this.annotatorOpen || this.pickerCleanup) return;
      e.preventDefault();
      this.close();
    }
  };

  constructor() {
    this.host = document.createElement('propanes-host');
    this.shadow = this.host.attachShadow({ mode: 'open' });
    document.body.appendChild(this.host);

    const script = (document.querySelector('script[data-endpoint]') ||
      document.currentScript) as HTMLScriptElement | null;
    // If no explicit endpoint, derive from the script's src origin so the widget
    // works when embedded cross-origin (e.g. workbench loading widget from :3001)
    let endpoint = script?.dataset.endpoint || '/api/v1/feedback';
    if (!script?.dataset.endpoint && script?.src) {
      try {
        const scriptOrigin = new URL(script.src).origin;
        if (scriptOrigin !== window.location.origin) {
          endpoint = `${scriptOrigin}/api/v1/feedback`;
        }
      } catch {}
    }
    this.config = {
      endpoint,
      mode: (script?.dataset.mode as WidgetMode) || DEFAULT_MODE,
      position: (script?.dataset.position as WidgetPosition) || DEFAULT_POSITION,
      shortcut: script?.dataset.shortcut || DEFAULT_SHORTCUT,
      collectors: (script?.dataset.collectors?.split(',').filter(Boolean) as Collector[]) || [
        'console',
        'network',
        'performance',
        'environment',
      ],
      appKey: script?.dataset.appKey || undefined,
    };

    this.appId = this.extractAppId(this.config.appKey) || '__default__';

    this.loadHistory();
    this.loadDispatchMode();
    this.loadAdminAlwaysShow();
    this.loadBrainstormPref();
    installCollectors(this.config.collectors);
    this.render();
    this.bindShortcut();

    this.sessionBridge = new SessionBridge(this.config.endpoint, this.getSessionId(), this.config.collectors, this.config.appKey);
    if (script?.dataset.screenshotIncludeWidget === 'true') {
      this.sessionBridge.screenshotIncludeWidget = true;
    }
    // Bookmarklet iframe mode: report the host page URL instead of the iframe URL
    if (script?.hasAttribute('data-bookmarklet-host-url')) {
      const params = new URLSearchParams(window.location.search);
      const hostUrl = params.get('host');
      if (hostUrl) this.sessionBridge.hostUrl = hostUrl;
    }
    this.sessionBridge.connect();

    this.overlayManager = new OverlayPanelManager(this.shadow, this.config.endpoint, this.appId);

    // Auto-jump: when a session enters waiting state, reveal the workbench
    this.overlayManager.onWaitingChange = (_sessionId, state, waitingCount) => {
      if (state === 'waiting' && waitingCount > 0 && this.overlayManager.hasWorkbench) {
        this.overlayManager.revealWorkbench();
        // Update drawer badge if collapsed
        this.updateWorkbenchBadge(waitingCount);
      } else {
        this.updateWorkbenchBadge(waitingCount);
      }
    };

    this.autoStartBrainstorm();
  }

  private updateWorkbenchBadge(waitingCount: number) {
    const handles = this.shadow.querySelectorAll('.pw-drawer-handle');
    for (const handle of handles) {
      let badge = handle.querySelector('.pw-drawer-badge') as HTMLElement | null;
      if (waitingCount > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'pw-drawer-badge';
          handle.appendChild(badge);
        }
        badge.textContent = String(waitingCount);
      } else if (badge) {
        badge.remove();
      }
    }
  }

  private extractAppId(appKey?: string): string | null {
    if (!appKey) return null;
    // appKey is like pw_XXXX, the server resolves this to an appId
    // For overlay URLs we need appId; use appKey as fallback
    return appKey;
  }

  private loadHistory() {
    try {
      const stored = localStorage.getItem(HISTORY_KEY);
      if (stored) this.history = JSON.parse(stored);
    } catch { /* ignore */ }
  }

  private saveHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(this.history.slice(-MAX_HISTORY)));
    } catch { /* ignore */ }
  }

  private loadDispatchMode() {
    try {
      const stored = localStorage.getItem('pw-dispatch-mode');
      if (stored === 'auto') this.dispatchMode = 'auto';
    } catch { /* ignore */ }
  }

  private loadAdminAlwaysShow() {
    try {
      this.adminAlwaysShow = localStorage.getItem('pw-admin-always-show') === '1';
    } catch { /* ignore */ }
  }

  private setAdminAlwaysShow(on: boolean) {
    this.adminAlwaysShow = on;
    try {
      if (on) {
        localStorage.setItem('pw-admin-always-show', '1');
      } else {
        localStorage.removeItem('pw-admin-always-show');
      }
    } catch { /* ignore */ }
  }

  private loadBrainstormPref() {
    try {
      this.brainstormDisabled = localStorage.getItem('pw-brainstorm-disabled') === '1';
    } catch { /* ignore */ }
  }

  private setBrainstormDisabled(disabled: boolean) {
    this.brainstormDisabled = disabled;
    try {
      if (disabled) localStorage.setItem('pw-brainstorm-disabled', '1');
      else localStorage.removeItem('pw-brainstorm-disabled');
    } catch { /* ignore */ }
  }

  /**
   * Brainstorm (always-on listen mode) is enabled by default. iOS Safari and
   * many desktop browsers gate getUserMedia / SpeechRecognition behind a user
   * gesture, so we attempt an immediate start and fall back to a one-shot
   * gesture listener if the browser refuses.
   */
  private autoStartBrainstorm() {
    if (this.brainstormDisabled) return;
    if (this.voiceListenSessionId) return;
    // Skip entirely when the page isn't a secure context — iOS Safari and
    // modern desktop browsers refuse getUserMedia on HTTP origins, so
    // retrying on every gesture would burn battery with no chance of working.
    if (typeof window !== 'undefined' && window.isSecureContext === false) return;

    const attempt = async () => {
      try {
        await this.startListenMode({ silent: true });
      } catch { /* swallow — gesture path will retry */ }
    };

    // Try immediately; if it fails, wait for the first user gesture.
    attempt().then(() => {
      if (this.voiceListenSessionId) return;
      // Skip the gesture fallback if the browser has no SpeechRecognition
      // at all — e.g. iOS Safari — otherwise every tap/keypress retries.
      const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SR) return;
      this.installBrainstormGestureFallback();
    });
  }

  private installBrainstormGestureFallback() {
    if (this.brainstormGestureHandler) return;
    const handler = () => {
      if (this.brainstormDisabled || this.voiceListenSessionId) {
        this.removeBrainstormGestureFallback();
        return;
      }
      this.startListenMode({ silent: true }).then(() => {
        if (this.voiceListenSessionId) this.removeBrainstormGestureFallback();
      }).catch(() => { /* keep listener for next gesture */ });
    };
    this.brainstormGestureHandler = handler;
    document.addEventListener('pointerdown', handler, { once: false, capture: true });
    document.addEventListener('keydown', handler, { once: false, capture: true });
  }

  private removeBrainstormGestureFallback() {
    if (!this.brainstormGestureHandler) return;
    document.removeEventListener('pointerdown', this.brainstormGestureHandler, true);
    document.removeEventListener('keydown', this.brainstormGestureHandler, true);
    this.brainstormGestureHandler = null;
  }

  private setDispatchMode(mode: 'off' | 'once' | 'auto') {
    this.dispatchMode = mode;
    try {
      if (mode === 'auto') {
        localStorage.setItem('pw-dispatch-mode', 'auto');
      } else {
        localStorage.removeItem('pw-dispatch-mode');
      }
    } catch { /* ignore */ }

    const sendBtn = this.shadow.querySelector('#pw-send-btn') as HTMLButtonElement | null;
    if (sendBtn) this.updateSendButtonTitle(sendBtn);
  }

  // Mirrors admin QuickDispatchPopup.pickYoloAgent: prefer interactive-yolo
  // (TTY + skip permissions), fall back to any other *-yolo profile. Within
  // each profile, prefer app-specific default, then global default, then any
  // app match, then any match.
  private pickYoloAgent(agents: Array<Record<string, any>>): Record<string, any> | undefined {
    if (!agents?.length) return undefined;
    const usable = agents.filter((a) => a.mode !== 'webhook' || !!a.url);
    for (const profile of ['interactive-yolo', 'headless-yolo', 'headless-stream-yolo'] as const) {
      const match = (a: Record<string, any>) => a.permissionProfile === profile;
      const hit =
        usable.find((a) => match(a) && a.isDefault && a.appId === this.appId) ||
        usable.find((a) => match(a) && a.isDefault && !a.appId) ||
        usable.find((a) => match(a) && a.appId === this.appId) ||
        usable.find(match);
      if (hit) return hit;
    }
    return undefined;
  }

  private getSelectedDispatchAgent(): Record<string, any> | undefined {
    const selectedId = this.dispatchAgentOverride || localStorage.getItem('pw-dispatch-agent');
    if (!selectedId || !this.cachedAgents?.length) return undefined;
    return this.cachedAgents.find((a) => a.id === selectedId);
  }

  private updateSendButtonTitle(sendBtn?: HTMLButtonElement | null) {
    const btn = sendBtn ?? (this.shadow.querySelector('#pw-send-btn') as HTMLButtonElement | null);
    if (!btn) return;
    const group = this.shadow.querySelector('.pw-send-group');
    const input = this.shadow.querySelector('#pw-chat-input') as HTMLTextAreaElement | null;
    const description = (input?.value || '').trim();
    const imageOnly = !description && this.pendingScreenshots.length > 0 && !this.voiceResult && this.timelineItems.length === 0;
    const imgCount = this.pendingScreenshots.length;
    if (this.dispatchMode === 'auto') {
      btn.title = 'Submit & dispatch (auto)';
      btn.classList.add('pw-dispatch-active');
      group?.querySelector('.pw-send-dropdown-toggle')?.classList.add('pw-dispatch-active');
    } else {
      if (this.appendTargetId) {
        btn.title = imageOnly ? `Append image${imgCount === 1 ? '' : 's'}` : 'Append to feedback';
      } else {
        btn.title = imageOnly ? `Submit image${imgCount === 1 ? '' : 's'}` : 'Send feedback';
      }
      btn.classList.remove('pw-dispatch-active');
      group?.querySelector('.pw-send-dropdown-toggle')?.classList.remove('pw-dispatch-active');
    }
  }

  private toggleSendMenu() {
    const existing = this.shadow.querySelector('.pw-send-menu');
    if (existing) { existing.remove(); return; }

    const group = this.shadow.querySelector('.pw-send-group');
    if (!group) return;

    const menu = document.createElement('div');
    menu.className = 'pw-send-menu';

    const actions: Array<{ label: string; kind: 'submit' | 'dispatch' | 'yolo'; desc: string }> = [
      { label: 'Submit', kind: 'submit', desc: 'Submit feedback only' },
      { label: 'Dispatch', kind: 'dispatch', desc: 'Submit & dispatch this time' },
      { label: '⚡ YOLO', kind: 'yolo', desc: 'Submit & dispatch with skip-permissions agent' },
    ];

    for (const item of actions) {
      const btn = document.createElement('button');
      btn.className = item.kind === 'yolo' ? 'pw-send-menu-item pw-send-menu-item-yolo' : 'pw-send-menu-item';
      btn.textContent = item.label;
      btn.title = item.desc;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (item.kind === 'yolo') {
          // Prefer a *-yolo profile agent so downstream resume/continue logic
          // sees a natively-yolo parent, but also pass an explicit
          // permissionProfile override (interactive-yolo = TTY + skip) so the
          // dispatch skips permissions even if the selected agent's stored
          // profile is mis-configured.
          const agent = this.pickYoloAgent(this.cachedAgents);
          this.dispatchAgentOverride = agent ? agent.id : null;
          this.pendingPermissionProfile = 'interactive-yolo';
          this.setDispatchMode('once');
        } else {
          this.dispatchAgentOverride = null;
          this.pendingPermissionProfile = null;
          this.setDispatchMode(item.kind === 'dispatch' ? 'once' : 'off');
        }
        menu.remove();
        this.handleSubmit();
      });
      menu.appendChild(btn);
    }

    const divider = document.createElement('div');
    divider.className = 'pw-send-menu-divider';
    menu.appendChild(divider);

    // Agent selector
    const agentRow = document.createElement('div');
    agentRow.className = 'pw-send-menu-target';
    const agentLabel = document.createElement('span');
    agentLabel.textContent = 'Agent:';
    agentLabel.style.cssText = 'font-size:11px;color:#94a3b8;flex-shrink:0';
    const agentSel = document.createElement('select');
    agentSel.className = 'pw-send-menu-target-select';
    agentSel.innerHTML = '<option value="">Default</option>';
    agentSel.value = localStorage.getItem('pw-dispatch-agent') || '';
    agentSel.addEventListener('change', () => {
      if (agentSel.value) localStorage.setItem('pw-dispatch-agent', agentSel.value);
      else localStorage.removeItem('pw-dispatch-agent');
    });
    const agentSettingsLink = document.createElement('a');
    agentSettingsLink.textContent = '\u2699';
    agentSettingsLink.title = 'Agent settings';
    agentSettingsLink.style.cssText = 'font-size:13px;color:#94a3b8;cursor:pointer;text-decoration:none;flex-shrink:0';
    agentSettingsLink.href = `${new URL(this.config.endpoint, window.location.origin).origin}/admin/#/agents`;
    agentSettingsLink.target = '_blank';
    agentSettingsLink.addEventListener('click', (e) => e.stopPropagation());
    agentRow.append(agentLabel, agentSel, agentSettingsLink);
    menu.appendChild(agentRow);

    // Populate agents from API
    const agentOrigin = new URL(this.config.endpoint, window.location.origin).origin;
    fetch(`${agentOrigin}/api/v1/admin/agents${this.appId ? `?appId=${this.appId}` : ''}`)
      .then(r => r.json())
      .then((agents: any[]) => {
        if (!agents?.length) return;
        this.cachedAgents = agents;
        for (const a of agents) {
          const opt = document.createElement('option');
          opt.value = a.id;
          const modeIcon = a.mode === 'headless' ? '\uD83D\uDCE6' : a.mode === 'webhook' ? '\uD83C\uDF10' : '\uD83D\uDCBB';
          const skipPerms = typeof a.permissionProfile === 'string' && a.permissionProfile.endsWith('-yolo');
          const profileIcon = skipPerms ? ' \u26A1' : '';
          opt.textContent = `${modeIcon} ${a.name}${profileIcon}${a.isDefault ? ' \u2605' : ''}`;
          agentSel.appendChild(opt);
        }
        agentSel.value = localStorage.getItem('pw-dispatch-agent') || '';
      })
      .catch(() => {});

    // Dispatch target selector
    const targetRow = document.createElement('div');
    targetRow.className = 'pw-send-menu-target';
    const targetLabel = document.createElement('span');
    targetLabel.textContent = 'Target:';
    targetLabel.style.cssText = 'font-size:11px;color:#94a3b8;flex-shrink:0';
    const targetSel = document.createElement('select');
    targetSel.className = 'pw-send-menu-target-select';
    targetSel.innerHTML = '<option value="">Local</option>';
    targetSel.value = localStorage.getItem('pw-dispatch-target') || '';
    targetSel.addEventListener('change', () => {
      if (targetSel.value) localStorage.setItem('pw-dispatch-target', targetSel.value);
      else localStorage.removeItem('pw-dispatch-target');
    });
    targetRow.append(targetLabel, targetSel);
    menu.appendChild(targetRow);

    // Populate targets from API
    const origin = new URL(this.config.endpoint, window.location.origin).origin;
    fetch(`${origin}/api/v1/admin/dispatch-targets`)
      .then(r => r.json())
      .then((data: any) => {
        if (!data.targets?.length) return;
        for (const t of data.targets) {
          const opt = document.createElement('option');
          opt.value = t.launcherId;
          opt.disabled = !t.online;
          opt.textContent = `${t.isHarness ? '\u{1F9EA}' : '\u{1F5A5}'} ${t.machineName || t.name}${t.online ? '' : ' (offline)'}`;
          targetSel.appendChild(opt);
        }
        targetSel.value = localStorage.getItem('pw-dispatch-target') || '';
      })
      .catch(() => {});

    const divider2 = document.createElement('div');
    divider2.className = 'pw-send-menu-divider';
    menu.appendChild(divider2);

    const label = document.createElement('label');
    label.className = 'pw-send-menu-item pw-send-menu-checkbox';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.dispatchMode === 'auto';
    cb.addEventListener('change', () => {
      this.setDispatchMode(cb.checked ? 'auto' : 'off');
    });
    const span = document.createElement('span');
    span.textContent = 'Auto-dispatch';
    label.append(cb, span);
    menu.appendChild(label);

    group.appendChild(menu);

    const closeHandler = (e: Event) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        this.shadow.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => this.shadow.addEventListener('click', closeHandler), 0);
  }

  private togglePickerMenu() {
    const existing = this.shadow.querySelector('.pw-picker-menu');
    if (existing) { existing.remove(); return; }

    const group = this.shadow.querySelector('.pw-picker-group');
    if (!group) return;

    const menu = document.createElement('div');
    menu.className = 'pw-picker-menu';

    const excludeLabel = document.createElement('label');
    excludeLabel.className = 'pw-picker-menu-item';
    const excludeCb = document.createElement('input');
    excludeCb.type = 'checkbox';
    excludeCb.checked = this.pickerExcludeWidget;
    excludeCb.addEventListener('change', () => {
      this.pickerExcludeWidget = excludeCb.checked;
    });
    const excludeSpan = document.createElement('span');
    excludeSpan.textContent = 'Exclude widget';
    excludeLabel.append(excludeCb, excludeSpan);
    menu.appendChild(excludeLabel);

    const label = document.createElement('label');
    label.className = 'pw-picker-menu-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.pickerMultiSelect;
    cb.addEventListener('change', () => {
      this.pickerMultiSelect = cb.checked;
    });
    const span = document.createElement('span');
    span.textContent = 'Multi-select';
    label.append(cb, span);
    menu.appendChild(label);

    const childrenLabel = document.createElement('label');
    childrenLabel.className = 'pw-picker-menu-item';
    const childrenCb = document.createElement('input');
    childrenCb.type = 'checkbox';
    childrenCb.checked = this.pickerIncludeChildren;
    childrenCb.addEventListener('change', () => {
      this.pickerIncludeChildren = childrenCb.checked;
    });
    const childrenSpan = document.createElement('span');
    childrenSpan.textContent = 'Include children';
    childrenLabel.append(childrenCb, childrenSpan);
    menu.appendChild(childrenLabel);

    group.appendChild(menu);

    const closeHandler = (e: Event) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        this.shadow.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => this.shadow.addEventListener('click', closeHandler), 0);
  }

  private toggleCameraMenu() {
    const existing = this.shadow.querySelector('.pw-camera-menu');
    if (existing) { existing.remove(); return; }

    const group = this.shadow.querySelector('.pw-camera-group');
    if (!group) return;

    const menu = document.createElement('div');
    menu.className = 'pw-camera-menu';

    const label = document.createElement('label');
    label.className = 'pw-camera-menu-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.excludeWidget;
    cb.addEventListener('change', () => {
      this.excludeWidget = cb.checked;
    });
    const span = document.createElement('span');
    span.textContent = 'Exclude widget';
    label.append(cb, span);
    menu.appendChild(label);

    const cursorLabel = document.createElement('label');
    cursorLabel.className = 'pw-camera-menu-item';
    const cursorCb = document.createElement('input');
    cursorCb.type = 'checkbox';
    cursorCb.checked = this.excludeCursor;
    cursorCb.addEventListener('change', () => {
      this.excludeCursor = cursorCb.checked;
    });
    const cursorSpan = document.createElement('span');
    cursorSpan.textContent = 'Exclude cursor';
    cursorLabel.append(cursorCb, cursorSpan);
    menu.appendChild(cursorLabel);

    const htmlToImageLabel = document.createElement('label');
    htmlToImageLabel.className = 'pw-camera-menu-item';
    const htmlToImageCb = document.createElement('input');
    htmlToImageCb.type = 'checkbox';
    htmlToImageCb.checked = this.screenshotMethod === 'html-to-image';
    const htmlToImageSpan = document.createElement('span');
    htmlToImageSpan.textContent = 'html-to-image';
    htmlToImageLabel.append(htmlToImageCb, htmlToImageSpan);
    menu.appendChild(htmlToImageLabel);

    const keepLabel = document.createElement('label');
    keepLabel.className = 'pw-camera-menu-item';
    const keepCb = document.createElement('input');
    keepCb.type = 'checkbox';
    keepCb.checked = this.keepStream;
    keepCb.disabled = this.screenshotMethod === 'html-to-image';
    keepCb.addEventListener('change', () => {
      this.keepStream = keepCb.checked;
      if (!keepCb.checked) stopScreencastStream();
    });
    const keepSpan = document.createElement('span');
    keepSpan.textContent = 'Multi-screenshot';
    keepLabel.append(keepCb, keepSpan);
    menu.appendChild(keepLabel);

    htmlToImageCb.addEventListener('change', () => {
      this.screenshotMethod = htmlToImageCb.checked ? 'html-to-image' : 'display-media';
      if (this.screenshotMethod === 'html-to-image') {
        this.keepStream = false;
        keepCb.checked = false;
        keepCb.disabled = true;
        stopScreencastStream();
      } else {
        keepCb.disabled = false;
      }
    });

    const divider = document.createElement('div');
    divider.className = 'pw-camera-menu-divider';
    menu.appendChild(divider);

    const timedBtn = document.createElement('button');
    timedBtn.className = 'pw-camera-menu-item pw-camera-menu-btn';
    timedBtn.textContent = 'Timed (3s)';
    timedBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.remove();
      this.startTimedScreenshot(3);
    });
    menu.appendChild(timedBtn);

    group.appendChild(menu);

    const closeHandler = (e: Event) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        this.shadow.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => this.shadow.addEventListener('click', closeHandler), 0);
  }

  private toggleAdminMenu() {
    const existing = this.shadow.querySelector('.pw-admin-menu');
    if (existing) { existing.remove(); return; }

    const group = this.shadow.querySelector('.pw-admin-group');
    if (!group) return;

    const menu = document.createElement('div');
    menu.className = 'pw-admin-menu';

    const label = document.createElement('label');
    label.className = 'pw-admin-menu-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.adminAlwaysShow;
    cb.addEventListener('change', () => {
      this.setAdminAlwaysShow(cb.checked);
    });
    const span = document.createElement('span');
    span.textContent = 'Always show';
    label.append(cb, span);
    menu.appendChild(label);

    group.appendChild(menu);

    const closeHandler = (e: Event) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        this.shadow.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => this.shadow.addEventListener('click', closeHandler), 0);
  }

  private toggleContextMenu() {
    const existing = this.shadow.querySelector('.pw-context-menu');
    if (existing) { existing.remove(); return; }

    const group = this.shadow.querySelector('.pw-context-group');
    if (!group) return;

    const menu = document.createElement('div');
    menu.className = 'pw-context-menu';

    const items: Array<{ value: string; label: string }> = [
      { value: 'console', label: 'Console' },
      { value: 'environment', label: 'Page info' },
      { value: 'network', label: 'Network' },
      { value: 'performance', label: 'Perf' },
    ];

    for (const item of items) {
      const label = document.createElement('label');
      label.className = 'pw-context-menu-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = item.value;
      cb.checked = this.savedCollectors.has(item.value);
      cb.addEventListener('change', () => {
        if (cb.checked) this.savedCollectors.add(item.value);
        else this.savedCollectors.delete(item.value);
      });
      const span = document.createElement('span');
      span.textContent = item.label;
      label.append(cb, span);
      menu.appendChild(label);
    }

    group.appendChild(menu);

    const closeHandler = (e: Event) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        this.shadow.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => this.shadow.addEventListener('click', closeHandler), 0);
  }

  private initResize() {
    const panel = this.shadow.querySelector('.pw-panel') as HTMLElement;
    const handle = this.shadow.querySelector('.pw-resize-handle') as HTMLElement;
    if (!panel || !handle) return;

    const pos = this.config.position;

    handle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = panel.offsetWidth;
      const startH = panel.offsetHeight;

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;

        let newW = startW;
        let newH = startH;

        if (pos === 'bottom-right') {
          newW = startW - dx;
          newH = startH - dy;
        } else if (pos === 'bottom-left') {
          newW = startW + dx;
          newH = startH - dy;
        } else if (pos === 'top-right') {
          newW = startW - dx;
          newH = startH + dy;
        } else {
          newW = startW + dx;
          newH = startH + dy;
        }

        panel.style.width = Math.max(280, newW) + 'px';
        panel.style.height = Math.max(200, newH) + 'px';
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  private render() {
    const style = document.createElement('style');
    style.textContent = WIDGET_CSS;
    this.shadow.appendChild(style);

    if (this.config.mode !== 'hidden') {
      this.renderTrigger();
    }
  }

  private triggerStowed = false;
  private triggerPeeking = false;
  private triggerDwellTimer: ReturnType<typeof setTimeout> | null = null;

  private renderTrigger() {
    const btn = document.createElement('button');
    btn.className = `pw-trigger ${this.config.position}`;
    btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.2L4 17.2V4h16v12z"/></svg>`;
    this.shadow.appendChild(btn);

    let dragged = false;
    let startX = 0;
    let startY = 0;
    let activePointerId: number | null = null;

    const HOVER_ZONE = 60;
    // Touch devices have no hover, so the off-screen "stowed" state would be
    // unreachable. Keep the trigger at the peek offset on touch so users can
    // still tap it to bring it back.
    const isTouchDevice = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(hover: none)').matches
      : false;

    const defaultPos = () => {
      btn.style.left = 'auto';
      btn.style.top = 'auto';
      btn.style.right = '';
      btn.style.bottom = '';
    };

    const stow = () => {
      this.triggerStowed = true;
      this.triggerPeeking = false;
      btn.classList.remove('pw-trigger-peek', 'pw-trigger-dragging');
      btn.style.left = 'auto';
      btn.style.top = 'auto';
      if (isTouchDevice) {
        // No hover — leave it peeking so it stays tappable.
        this.triggerPeeking = true;
        btn.classList.add('pw-trigger-peek');
        btn.style.right = '-15px';
        btn.style.bottom = '-15px';
      } else {
        btn.classList.add('pw-trigger-stowed');
        btn.style.right = '-48px';
        btn.style.bottom = '-48px';
      }
    };

    const peek = () => {
      if (!this.triggerStowed) return;
      this.triggerPeeking = true;
      btn.classList.remove('pw-trigger-stowed');
      btn.classList.add('pw-trigger-peek');
      btn.style.left = 'auto';
      btn.style.top = 'auto';
      btn.style.right = '-15px';
      btn.style.bottom = '-15px';
    };

    const unpeek = () => {
      if (!this.triggerPeeking) return;
      this.triggerPeeking = false;
      // Keep pw-trigger-peek class so the transition property applies during hide,
      // then swap to pw-trigger-stowed after the transition ends.
      btn.style.right = '-48px';
      btn.style.bottom = '-48px';
      const onEnd = () => {
        btn.removeEventListener('transitionend', onEnd);
        if (!this.triggerPeeking) {
          btn.classList.remove('pw-trigger-peek');
          btn.classList.add('pw-trigger-stowed');
        }
      };
      btn.addEventListener('transitionend', onEnd);
    };

    const unstow = () => {
      this.triggerStowed = false;
      this.triggerPeeking = false;
      if (this.triggerDwellTimer) {
        clearTimeout(this.triggerDwellTimer);
        this.triggerDwellTimer = null;
      }
      btn.classList.remove('pw-trigger-stowed', 'pw-trigger-peek', 'pw-trigger-dragging');
      defaultPos();
    };

    // Corner hover detection — reveal peek after 1s, hide when mouse leaves.
    // Skipped on touch devices (no hover); on those we keep the trigger peeking
    // permanently when stowed so it remains reachable.
    if (!isTouchDevice) {
      document.addEventListener('mousemove', (ev: MouseEvent) => {
        if (!this.triggerStowed) return;
        const inZone = ev.clientX >= window.innerWidth - HOVER_ZONE
          && ev.clientY >= window.innerHeight - HOVER_ZONE;

        if (inZone) {
          if (!this.triggerPeeking && !this.triggerDwellTimer) {
            this.triggerDwellTimer = setTimeout(() => {
              this.triggerDwellTimer = null;
              peek();
            }, 1000);
          }
        } else {
          if (this.triggerDwellTimer) {
            clearTimeout(this.triggerDwellTimer);
            this.triggerDwellTimer = null;
          }
          if (this.triggerPeeking) unpeek();
        }
      }, true);
    }

    btn.addEventListener('pointerdown', (e: PointerEvent) => {
      // Ignore secondary buttons (right-click) for mouse pointers
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (activePointerId !== null) return;
      e.preventDefault();
      activePointerId = e.pointerId;
      dragged = false;
      startX = e.clientX;
      startY = e.clientY;

      // If peeking, treat as tap-to-unstow
      if (this.triggerPeeking) {
        const onUp = (ev: PointerEvent) => {
          if (ev.pointerId !== activePointerId) return;
          document.removeEventListener('pointerup', onUp);
          document.removeEventListener('pointercancel', onUp);
          activePointerId = null;
          unstow();
        };
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
        return;
      }

      if (this.triggerStowed) return;

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== activePointerId) return;
        const dx = Math.max(0, ev.clientX - startX);
        const dy = Math.max(0, ev.clientY - startY);
        if (!dragged && dx < 4 && dy < 4) return;
        dragged = true;
        btn.classList.add('pw-trigger-dragging');
        btn.style.right = (20 - dx) + 'px';
        btn.style.bottom = (20 - dy) + 'px';
      };

      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== activePointerId) return;
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        activePointerId = null;
        btn.classList.remove('pw-trigger-dragging');

        if (!dragged) {
          this.toggle();
          return;
        }

        const rect = btn.getBoundingClientRect();
        const nearCorner = rect.right > window.innerWidth - 20
          && rect.bottom > window.innerHeight - 20;
        if (nearCorner) {
          stow();
        } else {
          defaultPos();
        }
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    });
  }

  private toggleAdminOptions(force?: 'show') {
    const existing = this.shadow.querySelector('.pw-admin-options');
    if (existing) {
      if (force === 'show') return;
      existing.remove();
      return;
    }

    const panel = this.shadow.querySelector('.pw-panel');
    if (!panel) return;

    const options = document.createElement('div');
    options.className = 'pw-admin-options';

    // Icon row — feedback / sessions / ProPanes overlay / Ops / terminal / settings.
    // Workbench is a small icon, not a full-width row, so it sits next to the
    // others. Opening it routes through openWorkbench() to focus the existing
    // panel if one is already open.
    type IconItem = { icon: string; label: string; onClick: () => void };
    const iconItems: IconItem[] = [
      { icon: '\u{1F4CB}', label: 'Feedback', onClick: () => this.overlayManager.openPanel('feedback') },
      { icon: '\u26A1', label: 'Sessions', onClick: () => this.overlayManager.openPanel('sessions') },
      { icon: '\u2B1A', label: 'ProPanes Overlay', onClick: () => this.overlayManager.openWorkbench() },
      { icon: '\u2605', label: 'Ops (Chief of Staff)', onClick: () => this.overlayManager.openPanel('cos') },
      { icon: '\u{1F4BB}', label: 'Terminal', onClick: () => {
          const opts: { launcherId?: string } = {};
          const stored = localStorage.getItem('pw-dispatch-target');
          if (stored) opts.launcherId = stored;
          this.overlayManager.openPanel('terminal', opts);
        } },
      { icon: '\u2699', label: 'Settings', onClick: () => this.overlayManager.openPanel('settings') },
    ];
    const iconRow = document.createElement('div');
    iconRow.className = 'pw-admin-more-row';
    for (const item of iconItems) {
      const btn = document.createElement('button');
      btn.className = 'pw-admin-option pw-admin-option-small';
      btn.innerHTML = `<span class="pw-admin-option-icon">${item.icon}</span>`;
      btn.title = item.label;
      btn.addEventListener('click', item.onClick);
      iconRow.appendChild(btn);
    }
    options.appendChild(iconRow);

    // Session ID row
    const sidRow = document.createElement('div');
    sidRow.className = 'pw-session-id-row';
    const sid = this.getSessionId();
    sidRow.innerHTML = `<span class="pw-session-id-label">Session:</span><code class="pw-session-id-value">${sid}</code>`;
    sidRow.addEventListener('click', () => {
      copyText(sid).then(() => {
        const val = sidRow.querySelector('.pw-session-id-value') as HTMLElement;
        val.textContent = 'Copied!';
        setTimeout(() => { val.textContent = sid; }, 1200);
      });
    });
    options.appendChild(sidRow);

    // Dispatch target selector
    const targetRow = document.createElement('div');
    targetRow.className = 'pw-session-id-row';
    targetRow.innerHTML = `<span class="pw-session-id-label">Target:</span><select class="pw-dispatch-target-select" style="flex:1;font-size:11px;padding:1px 2px;background:#333;color:#ccc;border:1px solid #555;border-radius:3px"><option value="">Local</option></select>`;
    const sel = targetRow.querySelector('select') as HTMLSelectElement;
    sel.value = localStorage.getItem('pw-dispatch-target') || '';
    sel.addEventListener('change', () => {
      if (sel.value) localStorage.setItem('pw-dispatch-target', sel.value);
      else localStorage.removeItem('pw-dispatch-target');
    });
    // Populate from API
    const origin = new URL(this.config.endpoint, window.location.origin).origin;
    fetch(`${origin}/api/v1/admin/dispatch-targets`)
      .then(r => r.json())
      .then((data: any) => {
        if (!data.targets?.length) { targetRow.style.display = 'none'; return; }
        for (const t of data.targets) {
          const opt = document.createElement('option');
          opt.value = t.launcherId;
          opt.textContent = t.machineName || t.name;
          sel.appendChild(opt);
        }
        sel.value = localStorage.getItem('pw-dispatch-target') || '';
      })
      .catch(() => { targetRow.style.display = 'none'; });
    options.appendChild(targetRow);

    // Insert before the error div at the bottom
    const errorEl = panel.querySelector('#pw-error');
    if (errorEl) {
      panel.insertBefore(options, errorEl);
    } else {
      panel.appendChild(options);
    }
  }

  private renderPanel() {
    const existing = this.shadow.querySelector('.pw-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.className = `pw-panel ${this.config.position}`;
    panel.style.position = 'fixed';
    panel.innerHTML = `
      <div class="pw-resize-handle"></div>
      <button class="pw-close-btn" id="pw-close-btn" title="Close" aria-label="Close">
        <svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
      <div class="pw-screenshots pw-hidden" id="pw-screenshots"></div>
      <div id="pw-selected-elements" class="pw-selected-elements pw-hidden"></div>
      <div class="pw-input-area">
        <textarea class="pw-textarea" id="pw-chat-input" placeholder="What's on your mind?" rows="3" autocomplete="off"></textarea>
        <div class="pw-toolbar">
          ${this.sessionBridge.screenshotIncludeWidget ? `
          <div class="pw-camera-group">
            <button class="pw-camera-btn" id="pw-capture-btn" title="Capture screenshot">
              <svg viewBox="0 0 24 24"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z"/><path d="M9 2 7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/></svg>
            </button>
            <button class="pw-camera-dropdown-toggle" id="pw-camera-dropdown" title="Screenshot options">
              <svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>
            </button>
          </div>
          <span class="pw-camera-countdown pw-hidden" id="pw-camera-countdown"></span>` : `
          <button class="pw-camera-btn" id="pw-capture-btn" title="Capture screenshot">
            <svg viewBox="0 0 24 24"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z"/><path d="M9 2 7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/></svg>
          </button>
          <span class="pw-camera-countdown pw-hidden" id="pw-camera-countdown"></span>`}
          <div class="pw-picker-group">
            <button class="pw-picker-btn" id="pw-picker-btn" title="Select an element">
              <svg viewBox="0 0 24 24"><path d="M3 3h4V1H1v6h2V3zm0 14H1v6h6v-2H3v-4zm14 4h-4v2h6v-6h-2v4zM17 3V1h6v6h-2V3h-4zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>
            </button>
            <button class="pw-picker-dropdown-toggle" id="pw-picker-dropdown" title="Picker options">
              <svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>
            </button>
          </div>
          <div class="pw-context-group">
            <button class="pw-context-btn" id="pw-context-btn" title="Context options">
              <svg viewBox="0 0 24 24"><path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>
            </button>
            <button class="pw-context-dropdown-toggle" id="pw-context-dropdown" title="Context options">
              <svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>
            </button>
          </div>
          <div class="pw-mic-group">
            <button class="pw-mic-btn" id="pw-mic-btn" title="Voice recording">
              <svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
            </button>
            <button class="pw-mic-dropdown-toggle" id="pw-mic-dropdown" title="Mic options">
              <svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>
            </button>
          </div>
          <div class="pw-admin-group">
            <button class="pw-admin-btn" id="pw-admin-btn" title="Admin panels"><svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg></button>
            <button class="pw-admin-dropdown-toggle" id="pw-admin-dropdown" title="Admin options"><svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg></button>
          </div>
          ${this.sessionBridge.autoDispatch ? `
          <div class="pw-send-group">
            <button class="pw-send-btn" id="pw-send-btn" title="Send feedback">
              <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            </button>
            <button class="pw-send-dropdown-toggle" id="pw-send-dropdown" title="Dispatch options">
              <svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>
            </button>
          </div>` : `
          <button class="pw-send-btn" id="pw-send-btn" title="Send feedback">
            <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>`}
        </div>
      </div>
      <div id="pw-error" class="pw-error pw-hidden"></div>
    `;

    // Append mode banner
    if (this.appendTargetId) {
      const banner = document.createElement('div');
      banner.className = 'pw-append-banner';
      const label = document.createElement('span');
      label.textContent = `Adding to #${this.appendTargetId.slice(-6)}`;
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'pw-append-cancel';
      cancelBtn.textContent = '\u00d7';
      cancelBtn.addEventListener('click', () => this.exitAppendMode());
      banner.append(label, cancelBtn);
      panel.insertBefore(banner, panel.firstChild);

      const textarea = panel.querySelector('#pw-chat-input') as HTMLTextAreaElement;
      if (textarea) textarea.placeholder = 'Add notes, select elements, capture screenshots...';
    }

    this.shadow.appendChild(panel);

    const input = panel.querySelector('#pw-chat-input') as HTMLTextAreaElement;
    const captureBtn = panel.querySelector('#pw-capture-btn') as HTMLButtonElement;
    const sendBtn = panel.querySelector('#pw-send-btn') as HTMLButtonElement;

    const pickerBtn = panel.querySelector('#pw-picker-btn') as HTMLButtonElement;
    const pickerDropdownBtn = panel.querySelector('#pw-picker-dropdown') as HTMLButtonElement | null;

    const adminBtn = panel.querySelector('#pw-admin-btn') as HTMLButtonElement | null;
    const adminDropdownBtn = panel.querySelector('#pw-admin-dropdown') as HTMLButtonElement | null;

    const cameraDropdownBtn = panel.querySelector('#pw-camera-dropdown') as HTMLButtonElement | null;

    const contextBtn = panel.querySelector('#pw-context-btn') as HTMLButtonElement | null;
    const contextDropdownBtn = panel.querySelector('#pw-context-dropdown') as HTMLButtonElement | null;

    const micBtn = panel.querySelector('#pw-mic-btn') as HTMLButtonElement;
    micBtn.addEventListener('click', () => this.toggleVoiceRecording());
    const micDropdownBtn = panel.querySelector('#pw-mic-dropdown') as HTMLButtonElement | null;
    micDropdownBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.toggleMicMenu(); });

    const closeBtn = panel.querySelector('#pw-close-btn') as HTMLButtonElement | null;
    closeBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });

    captureBtn.addEventListener('click', () => this.captureScreen());
    pickerBtn.addEventListener('click', () => this.startElementPicker());
    pickerDropdownBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.togglePickerMenu(); });
    cameraDropdownBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.toggleCameraMenu(); });
    contextBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.toggleContextMenu(); });
    contextDropdownBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.toggleContextMenu(); });
    adminBtn?.addEventListener('click', () => this.toggleAdminOptions());
    adminDropdownBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.toggleAdminMenu(); });
    sendBtn.addEventListener('click', () => this.handleSubmit());

    const dropdownBtn = panel.querySelector('#pw-send-dropdown') as HTMLButtonElement | null;
    dropdownBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.toggleSendMenu(); });

    // Restore saved state
    if (this.savedDraft) input.value = this.savedDraft;
    // Restore screenshots and selected elements
    this.renderScreenshotThumbs();
    this.renderSelectedElementChips();

    this.updateSendButtonTitle(sendBtn);

    const autoResize = () => {
      input.style.height = 'auto';
      const next = Math.max(input.scrollHeight, 40);
      input.style.height = `${next}px`;
    };
    requestAnimationFrame(autoResize);

    input.addEventListener('input', () => {
      this.updateSendButtonTitle(sendBtn);
      autoResize();
      try { localStorage.setItem('pw-widget-draft', input.value); } catch {}
    });

    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSubmit();
      } else if (e.key === 'ArrowUp' && input.value === '') {
        e.preventDefault();
        if (this.history.length === 0) return;
        if (this.historyIndex === -1) {
          this.currentDraft = input.value;
          this.historyIndex = this.history.length - 1;
        } else if (this.historyIndex > 0) {
          this.historyIndex--;
        }
        input.value = this.history[this.historyIndex];
      } else if (e.key === 'ArrowDown' && input.value === '') {
        e.preventDefault();
        if (this.historyIndex === -1) return;
        if (this.historyIndex < this.history.length - 1) {
          this.historyIndex++;
          input.value = this.history[this.historyIndex];
        } else {
          this.historyIndex = -1;
          input.value = this.currentDraft;
        }
      }
    });

    panel.addEventListener('paste', (e: Event) => {
      const ce = e as ClipboardEvent;
      const items = ce.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (blob) this.addScreenshot(blob);
        }
      }
    });

    if (this.adminAlwaysShow) {
      this.toggleAdminOptions('show');
    }

    this.initResize();

    // Restore timeline if recording is active (reopening while recording)
    if (this.voiceRecorder.recording) {
      this.showTimeline();
      const micBtnRestore = panel.querySelector('#pw-mic-btn') as HTMLButtonElement;
      if (micBtnRestore) micBtnRestore.classList.add('pw-mic-recording');
    }

    setTimeout(() => input.focus(), 50);
  }

  private async captureScreen() {
    const btn = this.shadow.querySelector('#pw-capture-btn') as HTMLButtonElement;
    const countdownEl = this.shadow.querySelector('#pw-camera-countdown') as HTMLElement | null;
    btn.disabled = true;

    const onStatus = (msg: string) => {
      if (countdownEl) {
        countdownEl.textContent = msg;
        countdownEl.classList.remove('pw-hidden');
      }
    };

    const excludeWidget = this.sessionBridge.screenshotIncludeWidget && this.excludeWidget;
    const blob = await captureScreenshot({ excludeWidget, excludeCursor: this.excludeCursor, keepStream: this.keepStream, method: this.screenshotMethod, onStatus });
    if (blob) {
      this.addScreenshot(blob);
    }

    if (countdownEl) {
      countdownEl.classList.add('pw-hidden');
      countdownEl.textContent = '';
    }
    btn.disabled = false;
  }

  private startTimedScreenshot(seconds: number) {
    if (this.countdownTimer) return;

    const countdownEl = this.shadow.querySelector('#pw-camera-countdown') as HTMLElement | null;
    const btn = this.shadow.querySelector('#pw-capture-btn') as HTMLButtonElement;
    if (btn) btn.disabled = true;

    let remaining = seconds;
    if (countdownEl) {
      countdownEl.textContent = String(remaining);
      countdownEl.classList.remove('pw-hidden');
    }

    this.countdownTimer = setInterval(() => {
      remaining--;
      if (remaining > 0) {
        if (countdownEl) countdownEl.textContent = String(remaining);
      } else {
        clearInterval(this.countdownTimer!);
        this.countdownTimer = null;
        if (countdownEl) {
          countdownEl.classList.add('pw-hidden');
          countdownEl.textContent = '';
        }
        this.captureScreen();
      }
    }, 1000);
  }

  private addScreenshot(blob: Blob) {
    this.pendingScreenshots.push(blob);
    persistScreenshots(this.pendingScreenshots);
    this.renderScreenshotThumbs();
    this.updateSendButtonTitle();
  }

  private renderScreenshotThumbs() {
    const container = this.shadow.querySelector('#pw-screenshots');
    if (!container) return;
    container.innerHTML = '';

    if (this.pendingScreenshots.length === 0) {
      container.classList.add('pw-hidden');
      return;
    }

    container.classList.remove('pw-hidden');
    this.pendingScreenshots.forEach((blob, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'pw-screenshot-wrap';

      const img = document.createElement('img');
      img.className = 'pw-screenshot-thumb';
      img.src = URL.createObjectURL(blob);
      img.title = 'Click to annotate';
      img.addEventListener('click', () => this.openAnnotator(i));

      const removeBtn = document.createElement('button');
      removeBtn.className = 'pw-screenshot-remove';
      removeBtn.textContent = '\u00d7';
      removeBtn.title = 'Remove screenshot';
      removeBtn.addEventListener('click', () => {
        this.pendingScreenshots.splice(i, 1);
        persistScreenshots(this.pendingScreenshots);
        this.renderScreenshotThumbs();
        this.updateSendButtonTitle();
      });

      wrap.appendChild(img);
      wrap.appendChild(removeBtn);
      container.appendChild(wrap);
    });

    const copyBtn = document.createElement('button');
    copyBtn.className = 'pw-screenshot-copy-paths';
    const count = this.pendingScreenshots.length;
    copyBtn.title = 'Upload and copy /tmp paths to clipboard';
    copyBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg><span>Copy path${count === 1 ? '' : 's'}</span>`;
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.copyScreenshotPaths(copyBtn);
    });
    container.appendChild(copyBtn);
  }

  private async copyScreenshotPaths(btn: HTMLButtonElement) {
    if (this.pendingScreenshots.length === 0) return;

    let resolveClipboard: (text: string) => void = () => {};
    let rejectClipboard: () => void = () => {};
    const clipboardText = new Promise<string>((res, rej) => {
      resolveClipboard = res;
      rejectClipboard = rej;
    });
    copyTextDeferred(clipboardText).catch(() => {});

    btn.disabled = true;
    const errorEl = this.shadow.querySelector('#pw-error') as HTMLElement | null;
    errorEl?.classList.add('pw-hidden');

    try {
      const result = await this.submitScreenshotsOnly();
      const paths: string[] = Array.isArray(result?.screenshots)
        ? result.screenshots.map((s: { path: string }) => s.path).filter(Boolean)
        : [];
      if (paths.length === 0) {
        rejectClipboard();
        throw new Error('No paths returned from server');
      }
      resolveClipboard(paths.join(' '));
      this.pendingScreenshots = [];
      persistScreenshots(this.pendingScreenshots);
      this.renderScreenshotThumbs();
      this.updateSendButtonTitle();
      this.showFlash(undefined, `${paths.length} path${paths.length === 1 ? '' : 's'} copied`);
    } catch (err) {
      rejectClipboard();
      if (errorEl) {
        errorEl.textContent = err instanceof Error ? err.message : 'Upload failed';
        errorEl.classList.remove('pw-hidden');
      }
      btn.disabled = false;
    }
  }

  private async toggleVoiceRecording() {
    const micBtn = this.shadow.querySelector('#pw-mic-btn') as HTMLButtonElement;
    if (this.voiceRecorder.recording) {
      // Stop recording
      micBtn.classList.remove('pw-mic-recording');
      const result = await this.voiceRecorder.stop();
      this.voiceResult = result;

      // Remove trigger recording indicator
      const trigger = this.shadow.querySelector('.pw-trigger') as HTMLElement;
      if (trigger) trigger.classList.remove('pw-trigger-recording');

      // Populate textarea with transcript
      const input = this.shadow.querySelector('#pw-chat-input') as HTMLTextAreaElement;
      const transcriptText = result.transcript.map(s => s.text).join(' ').trim();
      if (transcriptText && input) {
        input.value = (input.value ? input.value + '\n' : '') + transcriptText;
      }

      // Timeline stays visible for review — show voice indicator
      this.renderVoiceIndicator();
    } else {
      try {
        // Clear timeline
        this.timelineItems = [];

        // Wire callbacks
        this.voiceRecorder.onTranscript = (seg) => {
          if (!this.micHideTranscript) {
            const item: TimelineItem = { kind: 'speech', segment: seg };
            this.timelineItems.push(item);
            this.appendTimelineEntry(item);
          }
        };
        this.voiceRecorder.onInteraction = (event) => {
          const item: TimelineItem = { kind: 'interaction', event };
          this.timelineItems.push(item);
          this.appendTimelineEntry(item);
        };
        this.voiceRecorder.onConsole = (entry) => {
          const item: TimelineItem = { kind: 'console', entry };
          this.timelineItems.push(item);
          this.appendTimelineEntry(item);
        };
        this.voiceRecorder.onHover = (event) => {
          const item: TimelineItem = { kind: 'hover', event };
          this.timelineItems.push(item);
          this.appendTimelineEntry(item);
        };
        this.voiceRecorder.onScreenshotCapture = (capture) => {
          const item: TimelineItem = { kind: 'screenshot', capture };
          this.timelineItems.push(item);
          this.appendTimelineEntry(item);
        };

        await this.voiceRecorder.start({ screenCaptures: this.micScreenCaptures });
        micBtn.classList.add('pw-mic-recording');

        // Show timeline
        this.showTimeline();

        // Set trigger recording indicator
        const trigger = this.shadow.querySelector('.pw-trigger') as HTMLElement;
        if (trigger) trigger.classList.add('pw-trigger-recording');

        // Auto-minimize if "hide widget" option is on
        if (this.micHideWidget) {
          this.close();
        }
      } catch (err) {
        const errorEl = this.shadow.querySelector('#pw-error') as HTMLElement;
        if (errorEl) {
          errorEl.textContent = micErrorMessage(err);
          errorEl.classList.remove('pw-hidden');
        }
      }
    }
  }

  private renderVoiceIndicator() {
    let indicator = this.shadow.querySelector('.pw-voice-indicator') as HTMLElement;
    if (indicator) indicator.remove();
    if (!this.voiceResult) return;

    const duration = Math.round(this.voiceResult.duration / 1000);
    const interactions = this.voiceResult.interactions.length;
    const screenshots = this.voiceResult.screenshots.length;
    const parts = [`${duration}s recorded`, `${interactions} interaction${interactions !== 1 ? 's' : ''}`];
    if (screenshots > 0) parts.push(`${screenshots} screenshot${screenshots !== 1 ? 's' : ''}`);

    indicator = document.createElement('div');
    indicator.className = 'pw-voice-indicator';
    indicator.innerHTML = `
      <span>${parts.join(', ')}</span>
      <button class="pw-voice-discard" title="Discard recording">&times;</button>
    `;
    indicator.querySelector('.pw-voice-discard')!.addEventListener('click', () => {
      this.voiceResult = null;
      indicator.remove();
      this.exitTimeline();
    });

    const toolbar = this.shadow.querySelector('.pw-toolbar');
    if (toolbar) toolbar.parentElement!.insertBefore(indicator, toolbar);
  }

  private toggleMicMenu() {
    const existing = this.shadow.querySelector('.pw-mic-menu');
    if (existing) { existing.remove(); return; }

    const group = this.shadow.querySelector('.pw-mic-group') as HTMLElement;
    if (!group) return;

    const menu = document.createElement('div');
    menu.className = 'pw-mic-menu';

    const makeItem = (label: string, checked: boolean, onChange: (v: boolean) => void) => {
      const row = document.createElement('label');
      row.className = 'pw-mic-menu-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      cb.addEventListener('change', () => onChange(cb.checked));
      const span = document.createElement('span');
      span.textContent = label;
      row.append(cb, span);
      return row;
    };

    menu.appendChild(makeItem('Screen captures', this.micScreenCaptures, (v) => {
      this.micScreenCaptures = v;
      if (this.voiceRecorder.recording) {
        if (v) this.voiceRecorder.enableScreenCaptures();
        else this.voiceRecorder.disableScreenCaptures();
      }
    }));
    menu.appendChild(makeItem('Hide transcript', this.micHideTranscript, (v) => { this.micHideTranscript = v; }));
    menu.appendChild(makeItem('Hide widget', this.micHideWidget, (v) => { this.micHideWidget = v; }));

    const isListening = !!this.voiceListenSessionId;
    menu.appendChild(makeItem('Brainstorm (always-on mic)', isListening, (v) => {
      if (v) {
        this.setBrainstormDisabled(false);
        this.startListenMode();
      } else {
        this.setBrainstormDisabled(true);
        this.stopListenMode('user');
      }
    }));

    group.appendChild(menu);

    const closeHandler = (e: Event) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        this.shadow.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => this.shadow.addEventListener('click', closeHandler), 0);
  }

  /**
   * Start ambient listen mode: transcripts stream to the server in rolling
   * windows and the server decides when to spawn an agent. A persistent red
   * dot on the trigger button indicates listening is on.
   */
  private async startListenMode(opts?: { silent?: boolean }) {
    if (this.voiceListenSessionId) return;
    const silent = opts?.silent === true;

    const showError = (msg: string) => {
      if (silent) return;
      const errorEl = this.shadow.querySelector('#pw-error') as HTMLElement;
      if (errorEl) {
        errorEl.textContent = msg;
        errorEl.classList.remove('pw-hidden');
      }
    };

    // If silent (auto-start / gesture fallback), skip quietly on browsers
    // without SpeechRecognition — e.g. iOS Safari — so users don't see a
    // scary error for a feature they never asked for.
    if (silent) {
      const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SR) return;
    }

    const endpointUrl = new URL(this.config.endpoint, window.location.origin);
    const baseOrigin = endpointUrl.origin;

    let sessionId: string | null = null;
    try {
      const res = await fetch(`${baseOrigin}/api/v1/voice/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.apiHeaders() },
        body: JSON.stringify({
          widgetSessionId: this.getSessionId(),
          sourceUrl: location.href,
        }),
      });
      if (!res.ok) throw new Error(`voice session start failed: ${res.status}`);
      const data = await res.json();
      sessionId = data.id;
    } catch (err) {
      showError('Could not start listen mode');
      return;
    }

    try {
      await this.voiceRecorder.startAmbient({ windowMs: 30_000 });
    } catch (err) {
      showError(micErrorMessage(err));
      // Best-effort close the server session
      try {
        await fetch(`${baseOrigin}/api/v1/voice/sessions/${sessionId}/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...this.apiHeaders() },
          body: JSON.stringify({ reason: 'start-failed' }),
        });
      } catch {}
      return;
    }

    this.voiceListenSessionId = sessionId;
    this.voiceListenWindowSender = (win) => {
      fetch(`${baseOrigin}/api/v1/voice/sessions/${sessionId}/windows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.apiHeaders() },
        body: JSON.stringify({
          text: win.text,
          startedAt: win.startedAt,
          endedAt: win.endedAt,
          windowIndex: win.windowIndex,
        }),
      }).catch(() => { /* best-effort */ });
    };
    this.voiceRecorder.onAmbientWindow = this.voiceListenWindowSender;

    // Red-dot indicator on the trigger button, persistent while listening
    const trigger = this.shadow.querySelector('.pw-trigger') as HTMLElement;
    if (trigger) trigger.classList.add('pw-trigger-listening');

    // Safeguards: 30min of silence or 2min of tab-blur auto-stop.
    const SILENCE_TIMEOUT_MS = 30 * 60 * 1000;
    const BLUR_TIMEOUT_MS = 2 * 60 * 1000;
    this.voiceListenSilenceTimer = setInterval(() => {
      if (!this.voiceListenSessionId) return;
      const last = this.voiceRecorder.ambientLastSpeech;
      if (last && Date.now() - last > SILENCE_TIMEOUT_MS) {
        this.stopListenMode('silence-timeout');
        return;
      }
      if (this.voiceListenBlurStart && Date.now() - this.voiceListenBlurStart > BLUR_TIMEOUT_MS) {
        this.stopListenMode('blur-timeout');
      }
    }, 15_000);

    this.voiceListenVisibilityHandler = () => {
      if (document.visibilityState === 'hidden') {
        this.voiceListenBlurStart = Date.now();
      } else {
        this.voiceListenBlurStart = null;
      }
    };
    document.addEventListener('visibilitychange', this.voiceListenVisibilityHandler);
  }

  private async stopListenMode(reason: string) {
    const sessionId = this.voiceListenSessionId;
    if (!sessionId) return;
    this.voiceListenSessionId = null;

    if (this.voiceListenSilenceTimer) {
      clearInterval(this.voiceListenSilenceTimer);
      this.voiceListenSilenceTimer = null;
    }
    if (this.voiceListenVisibilityHandler) {
      document.removeEventListener('visibilitychange', this.voiceListenVisibilityHandler);
      this.voiceListenVisibilityHandler = null;
    }
    this.voiceListenBlurStart = null;
    this.voiceRecorder.onAmbientWindow = null;
    this.voiceListenWindowSender = null;

    try { await this.voiceRecorder.stopAmbient(); } catch {}

    const trigger = this.shadow.querySelector('.pw-trigger') as HTMLElement;
    if (trigger) trigger.classList.remove('pw-trigger-listening');

    try {
      const endpointUrl = new URL(this.config.endpoint, window.location.origin);
      await fetch(`${endpointUrl.origin}/api/v1/voice/sessions/${sessionId}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.apiHeaders() },
        body: JSON.stringify({ reason }),
      });
    } catch { /* best-effort */ }
  }

  private showTimeline() {
    const panel = this.shadow.querySelector('.pw-panel') as HTMLElement;
    if (!panel) return;

    panel.classList.add('pw-panel-recording');

    // Hide textarea, show timeline
    const textarea = this.shadow.querySelector('#pw-chat-input') as HTMLElement;
    if (textarea) textarea.style.display = 'none';

    // Remove existing live transcript
    const liveEl = this.shadow.querySelector('.pw-voice-transcript');
    if (liveEl) liveEl.remove();

    // Remove existing timeline if any
    const existing = this.shadow.querySelector('.pw-timeline');
    if (existing) existing.remove();

    const timeline = document.createElement('div');
    timeline.className = 'pw-timeline';

    // Render existing items
    for (const item of this.timelineItems) {
      const el = this.createTimelineEntryDOM(item);
      if (el) timeline.appendChild(el);
    }

    // Insert before toolbar
    const inputArea = this.shadow.querySelector('.pw-input-area') as HTMLElement;
    if (inputArea) {
      const toolbarEl = inputArea.querySelector('.pw-toolbar');
      if (toolbarEl) {
        inputArea.insertBefore(timeline, toolbarEl);
      } else {
        inputArea.appendChild(timeline);
      }
    }
  }

  private appendTimelineEntry(item: TimelineItem) {
    const timeline = this.shadow.querySelector('.pw-timeline') as HTMLElement;
    if (!timeline) return;
    const el = this.createTimelineEntryDOM(item);
    if (el) {
      timeline.appendChild(el);
      timeline.scrollTop = timeline.scrollHeight;
    }
  }

  private createTimelineEntryDOM(item: TimelineItem): HTMLElement | null {
    const entry = document.createElement('div');
    entry.className = 'pw-tl-entry';

    const ts = document.createElement('span');
    ts.className = 'pw-tl-timestamp';

    const content = document.createElement('div');
    content.className = 'pw-tl-content';

    switch (item.kind) {
      case 'speech': {
        const secs = Math.round(item.segment.timestamp / 1000);
        ts.textContent = `${secs}s`;
        entry.classList.add('pw-tl-speech');
        content.textContent = item.segment.text;
        break;
      }
      case 'interaction': {
        const secs = Math.round(item.event.timestamp / 1000);
        ts.textContent = `${secs}s`;
        entry.classList.add('pw-tl-interaction');

        const badge = document.createElement('span');
        badge.className = `pw-tl-badge pw-tl-badge-${item.event.type}`;
        badge.textContent = item.event.type;

        const selector = document.createElement('span');
        selector.className = 'pw-tl-selector';
        selector.textContent = item.event.target.selector;

        content.appendChild(badge);
        content.appendChild(selector);

        if (item.event.target.textContent) {
          const preview = document.createElement('span');
          preview.className = 'pw-tl-text-preview';
          preview.textContent = item.event.target.textContent.slice(0, 40);
          content.appendChild(preview);
        }

        // Remove button
        const removeBtn = document.createElement('button');
        removeBtn.className = 'pw-tl-remove';
        removeBtn.textContent = '\u00d7';
        removeBtn.addEventListener('click', () => {
          const idx = this.timelineItems.indexOf(item);
          if (idx >= 0) this.timelineItems.splice(idx, 1);
          this.voiceRecorder.removeInteraction(item.event.id);
          entry.remove();
        });
        entry.appendChild(ts);
        entry.appendChild(content);
        entry.appendChild(removeBtn);
        return entry;
      }
      case 'console': {
        const secs = Math.round(item.entry.timestamp / 1000);
        ts.textContent = `${secs}s`;
        entry.classList.add('pw-tl-console', `pw-tl-console-${item.entry.level}`);
        content.textContent = item.entry.args.join(' ');
        break;
      }
      case 'hover': {
        const secs = Math.round(item.event.timestamp / 1000);
        ts.textContent = `${secs}s`;
        entry.classList.add('pw-tl-hover');

        const badge = document.createElement('span');
        badge.className = 'pw-tl-badge pw-tl-badge-hover';
        badge.textContent = 'hover';

        const selector = document.createElement('span');
        selector.className = 'pw-tl-selector';
        selector.textContent = item.event.target.selector;

        content.appendChild(badge);
        content.appendChild(selector);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'pw-tl-remove';
        removeBtn.textContent = '\u00d7';
        removeBtn.addEventListener('click', () => {
          const idx = this.timelineItems.indexOf(item);
          if (idx >= 0) this.timelineItems.splice(idx, 1);
          this.voiceRecorder.removeInteraction(item.event.id);
          entry.remove();
        });
        entry.appendChild(ts);
        entry.appendChild(content);
        entry.appendChild(removeBtn);
        return entry;
      }
      case 'screenshot': {
        const secs = Math.round(item.capture.timestamp / 1000);
        ts.textContent = `${secs}s`;
        entry.classList.add('pw-tl-screenshot');

        const img = document.createElement('img');
        img.className = 'pw-tl-thumb';
        img.src = URL.createObjectURL(item.capture.blob);

        const dims = document.createElement('span');
        dims.className = 'pw-tl-dims';
        dims.textContent = `${item.capture.boundingBox.width}\u00d7${item.capture.boundingBox.height}`;

        content.appendChild(img);
        content.appendChild(dims);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'pw-tl-remove';
        removeBtn.textContent = '\u00d7';
        removeBtn.addEventListener('click', () => {
          const idx = this.timelineItems.indexOf(item);
          if (idx >= 0) this.timelineItems.splice(idx, 1);
          this.voiceRecorder.removeScreenshot(item.capture.id);
          URL.revokeObjectURL(img.src);
          entry.remove();
        });
        entry.appendChild(ts);
        entry.appendChild(content);
        entry.appendChild(removeBtn);
        return entry;
      }
    }

    entry.appendChild(ts);
    entry.appendChild(content);
    return entry;
  }

  private exitTimeline() {
    this.timelineItems = [];

    const timeline = this.shadow.querySelector('.pw-timeline');
    if (timeline) timeline.remove();

    const textarea = this.shadow.querySelector('#pw-chat-input') as HTMLElement;
    if (textarea) textarea.style.display = '';

    const panel = this.shadow.querySelector('.pw-panel') as HTMLElement;
    if (panel) panel.classList.remove('pw-panel-recording');
  }

  private startElementPicker() {
    const panel = this.shadow.querySelector('.pw-panel') as HTMLElement;
    if (panel && this.pickerExcludeWidget) panel.style.opacity = '0.3';

    const liveUpdate = this.pickerMultiSelect;
    const previousElements = [...this.selectedElements];
    this.pickerCleanup = startPicker((infos) => {
      if (panel) panel.style.opacity = '1';
      this.pickerCleanup = null;
      if (infos.length > 0) {
        this.selectedElements = [...previousElements, ...infos];
      }
      persistSelections(this.selectedElements);
      this.renderSelectedElementChips();
    }, this.host, {
      multiSelect: this.pickerMultiSelect,
      excludeWidget: this.pickerExcludeWidget,
      includeChildren: this.pickerIncludeChildren,
      onSelectionChange: liveUpdate ? (infos) => {
        this.selectedElements = [...previousElements, ...infos];
        persistSelections(this.selectedElements);
        this.renderSelectedElementChips();
      } : undefined,
    });
  }

  private renderSelectedElementChips() {
    const container = this.shadow.querySelector('#pw-selected-elements');
    if (!container) return;

    if (this.selectedElements.length === 0) {
      container.classList.add('pw-hidden');
      container.innerHTML = '';
      return;
    }

    container.classList.remove('pw-hidden');
    container.innerHTML = '';

    for (let i = 0; i < this.selectedElements.length; i++) {
      const el = this.selectedElements[i];
      let display = el.tagName;
      if (el.id) display += '#' + el.id;
      const cls = el.classes.filter(c => !c.startsWith('pw-')).slice(0, 2);
      if (cls.length) display += '.' + cls.join('.');

      const fullPath = el.selector || display;

      const chip = document.createElement('div');
      chip.className = 'pw-selected-element';
      chip.innerHTML = `<code title="${fullPath.replace(/"/g, '&quot;')}">${display}</code><button class="pw-selected-element-remove" title="Remove">\u00d7</button>`;

      const idx = i;
      chip.querySelector('.pw-selected-element-remove')!.addEventListener('click', () => {
        this.selectedElements.splice(idx, 1);
        persistSelections(this.selectedElements);
        this.renderSelectedElementChips();
      });

      container.appendChild(chip);
    }
  }

  private openAnnotator(index: number) {
    const blob = this.pendingScreenshots[index];
    if (!blob) return;

    const overlay = document.createElement('div');
    overlay.className = 'pw-annotator';
    this.shadow.appendChild(overlay);

    const dismiss = () => {
      editor.destroy();
      overlay.remove();
      this.annotatorOpen = false;
      document.removeEventListener('keydown', escHandler, true);
    };

    const editor = new ImageEditor({
      container: overlay,
      image: blob,
      tools: ['highlight', 'crop'],
      initialTool: 'highlight',
      saveActions: [{
        label: 'Done',
        primary: true,
        handler: async (resultBlob) => {
          this.pendingScreenshots[index] = resultBlob;
          persistScreenshots(this.pendingScreenshots);
          this.renderScreenshotThumbs();
          dismiss();
        },
      }],
      onCancel: () => dismiss(),
    });

    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        dismiss();
      }
    };
    document.addEventListener('keydown', escHandler, true);
    this.annotatorOpen = true;
  }

  private getCheckedCollectors(): Collector[] {
    return Array.from(this.savedCollectors) as Collector[];
  }

  private async handleSubmit() {
    const input = this.shadow.querySelector('#pw-chat-input') as HTMLTextAreaElement;
    const errorEl = this.shadow.querySelector('#pw-error') as HTMLElement;
    const description = input.value.trim();

    if (!description && this.pendingScreenshots.length === 0 && !this.voiceResult && this.timelineItems.length === 0) {
      return;
    }

    errorEl.classList.add('pw-hidden');
    input.disabled = true;

    // Schedule the clipboard write synchronously so iOS Safari preserves the
    // tap's user-activation state through the network request. The ClipboardItem
    // resolves once we know what to copy; rejecting it cancels the write.
    let resolveClipboard: (text: string) => void = () => {};
    let rejectClipboard: () => void = () => {};
    const clipboardText = new Promise<string>((res, rej) => {
      resolveClipboard = res;
      rejectClipboard = rej;
    });
    copyTextDeferred(clipboardText).catch(() => {});

    if (this.appendTargetId) {
      try {
        const appendResult = await this.submitAppend(this.appendTargetId, description);
        this.pendingScreenshots = [];
        this.selectedElements = [];
        input.value = '';
        this.savedDraft = '';
        clearWidgetDraftStorage();
        this.appendTargetId = null;
        const appendedPaths: string[] = Array.isArray(appendResult?.screenshots)
          ? appendResult.screenshots.map((s: { path: string }) => s.path).filter(Boolean)
          : [];
        if (!description && appendedPaths.length > 0) {
          resolveClipboard(appendedPaths.join(' '));
          this.showFlash(undefined, `${appendedPaths.length} path${appendedPaths.length === 1 ? '' : 's'} copied`);
        } else {
          rejectClipboard();
          this.showFlash(undefined, 'Appended');
        }
      } catch (err) {
        rejectClipboard();
        errorEl.textContent = err instanceof Error ? err.message : 'Append failed';
        errorEl.classList.remove('pw-hidden');
        input.disabled = false;
        input.focus();
      }
      return;
    }

    const shouldDispatch = this.dispatchMode === 'auto' || this.dispatchMode === 'once';
    if (this.dispatchMode === 'once') {
      this.dispatchMode = 'off';
    }

    // Screenshot-only submission (no description, no voice, no selected elements, no timeline):
    // upload directly to /api/v1/screenshots — no feedback item created.
    const isScreenshotOnly =
      !description &&
      this.pendingScreenshots.length > 0 &&
      !this.voiceResult &&
      this.selectedElements.length === 0 &&
      this.timelineItems.length === 0;

    try {
      if (isScreenshotOnly) {
        const result = await this.submitScreenshotsOnly();
        this.pendingScreenshots = [];
        input.value = '';
        clearWidgetDraftStorage();
        this.exitTimeline();
        const screenshotPaths: string[] = Array.isArray(result?.screenshots)
          ? result.screenshots.map((s: { path: string }) => s.path).filter(Boolean)
          : [];
        if (screenshotPaths.length > 0) {
          resolveClipboard(screenshotPaths.join(' '));
          this.showFlash(undefined, `${screenshotPaths.length} path${screenshotPaths.length === 1 ? '' : 's'} copied`);
        } else {
          rejectClipboard();
          this.showFlash(undefined, 'Uploaded');
        }
        return;
      }

      const result = await this.submitFeedback({ type: 'manual', title: '', description, autoDispatch: shouldDispatch }, this.getCheckedCollectors());

      if (description) {
        this.history.push(description);
        this.saveHistory();
      }
      this.historyIndex = -1;
      this.currentDraft = '';
      this.savedDraft = '';
      this.pendingScreenshots = [];
      this.selectedElements = [];
      input.value = '';
      clearWidgetDraftStorage();
      this.exitTimeline();

      this.emit('submit', { type: 'manual', title: '', description, id: result?.id, appId: result?.appId });

      const endpointUrl = new URL(this.config.endpoint, window.location.origin);
      const feedbackUrl = `${endpointUrl.origin}/admin/#/fb/${result.id}`;
      const screenshotPaths: string[] = Array.isArray(result?.screenshots)
        ? result.screenshots.map((s: { path: string }) => s.path).filter(Boolean)
        : [];
      if (!description && screenshotPaths.length > 0) {
        resolveClipboard(screenshotPaths.join(' '));
        this.showFlash(undefined, `${screenshotPaths.length} path${screenshotPaths.length === 1 ? '' : 's'} copied`);
      } else {
        resolveClipboard(feedbackUrl);
        this.showFlash(feedbackUrl);
      }
    } catch (err) {
      rejectClipboard();
      errorEl.textContent = err instanceof Error ? err.message : 'Submission failed';
      errorEl.classList.remove('pw-hidden');
      input.disabled = false;
      input.focus();
    } finally {
      this.dispatchAgentOverride = null;
      this.pendingPermissionProfile = null;
    }
  }

  private showFlash(feedbackUrl?: string, label?: string) {
    const panel = this.shadow.querySelector('.pw-panel');
    if (!panel) return;

    const flash = document.createElement('div');
    flash.className = 'pw-flash';
    const flashLabel = label || (feedbackUrl ? 'Link copied' : '');
    if (flashLabel) {
      flash.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg><span class="pw-flash-label">${flashLabel}</span>`;
    } else {
      flash.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`;
    }
    panel.appendChild(flash);

    setTimeout(() => this.close(), 1000);
  }

  private async submitScreenshotsOnly() {
    const endpointUrl = new URL(this.config.endpoint, window.location.origin);
    const screenshotsUrl = `${endpointUrl.origin}/api/v1/screenshots`;
    const formData = new FormData();
    formData.append('meta', JSON.stringify({
      sessionId: this.getSessionId(),
      userId: this.identity?.id,
      sourceUrl: location.href,
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    for (const blob of this.pendingScreenshots) {
      formData.append('screenshots', blob, `screenshot-${Date.now()}.png`);
    }
    const res = await this.fetchWithContext(screenshotsUrl, {
      method: 'POST',
      headers: this.apiHeaders(),
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  private async submitFeedback(opts: { type: string; title: string; description: string; autoDispatch?: boolean }, collectors?: Collector[]) {
    const context = collectContext(collectors ?? this.config.collectors);

    const feedbackPayload: Record<string, unknown> = {
      type: opts.type,
      title: opts.title,
      description: opts.description,
      context,
      sourceUrl: location.href,
      userAgent: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      sessionId: this.getSessionId(),
      userId: this.identity?.id,
    };
    if (opts.autoDispatch) {
      feedbackPayload.autoDispatch = true;
      const dispatchTarget = localStorage.getItem('pw-dispatch-target');
      if (dispatchTarget) {
        feedbackPayload.launcherId = dispatchTarget;
      }
      // One-shot override (e.g., YOLO action) wins over the sticky localStorage choice.
      const dispatchAgent = this.dispatchAgentOverride || localStorage.getItem('pw-dispatch-agent');
      if (dispatchAgent) {
        feedbackPayload.agentEndpointId = dispatchAgent;
      }
      if (this.pendingPermissionProfile) {
        feedbackPayload.permissionProfile = this.pendingPermissionProfile;
      } else {
        const selectedAgent = this.getSelectedDispatchAgent();
        const selectedProfile = selectedAgent?.permissionProfile;
        if (selectedProfile === 'yolo' || selectedProfile === 'headless' || selectedProfile === 'interactive-json') {
          feedbackPayload.permissionProfile = selectedProfile;
        }
      }
    }
    const dataObj: Record<string, unknown> = {};
    if (this.selectedElements.length > 0) {
      dataObj.selectedElements = this.selectedElements;
    }
    if (this.voiceResult) {
      // Use cleaned interactions from timeline (only items still present)
      const cleanedInteractions = this.timelineItems
        .filter(i => i.kind === 'interaction')
        .map(i => (i as { kind: 'interaction'; event: any }).event);
      dataObj.voiceRecording = {
        duration: this.voiceResult.duration,
        transcript: this.voiceResult.transcript,
        interactions: cleanedInteractions.length > 0 ? cleanedInteractions : this.voiceResult.interactions,
        consoleLogs: this.voiceResult.consoleLogs,
      };
      // Collect timeline screenshots into pendingScreenshots
      for (const item of this.timelineItems) {
        if (item.kind === 'screenshot') {
          this.pendingScreenshots.push(item.capture.blob);
        }
      }
    }
    if (Object.keys(dataObj).length > 0) {
      feedbackPayload.data = dataObj;
    }

    const useFormData = this.pendingScreenshots.length > 0 || !!this.voiceResult;

    if (useFormData) {
      const formData = new FormData();
      formData.append('feedback', JSON.stringify(feedbackPayload));
      for (const blob of this.pendingScreenshots) {
        formData.append('screenshots', blob, `screenshot-${Date.now()}.png`);
      }
      if (this.voiceResult) {
        formData.append('audio', this.voiceResult.audioBlob, `voice-${Date.now()}.webm`);
        this.voiceResult = null;
        const indicator = this.shadow.querySelector('.pw-voice-indicator');
        if (indicator) indicator.remove();
      }

      const res = await this.fetchWithContext(this.config.endpoint, {
        method: 'POST',
        headers: this.apiHeaders(),
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      return res.json();
    } else {
      const res = await this.fetchWithContext(this.config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.apiHeaders() },
        body: JSON.stringify(feedbackPayload),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      return res.json();
    }
  }

  private async submitAppend(feedbackId: string, description: string) {
    const context = collectContext(this.getCheckedCollectors());
    const payload: Record<string, unknown> = {
      description,
      context,
      sourceUrl: location.href,
      userAgent: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      sessionId: this.getSessionId(),
      userId: this.identity?.id,
    };
    if (this.selectedElements.length > 0) {
      payload.data = { selectedElements: this.selectedElements };
    }

    const url = this.config.endpoint.replace(/\/?$/, '') + '/' + feedbackId + '/append';

    if (this.pendingScreenshots.length > 0) {
      const formData = new FormData();
      formData.append('feedback', JSON.stringify(payload));
      for (const blob of this.pendingScreenshots) {
        formData.append('screenshots', blob, `screenshot-${Date.now()}.png`);
      }
      const res = await this.fetchWithContext(url, {
        method: 'POST',
        headers: this.apiHeaders(),
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      return res.json();
    } else {
      const res = await this.fetchWithContext(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.apiHeaders() },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      return res.json();
    }
  }

  private apiHeaders(): Record<string, string> {
    return this.config.appKey ? { 'X-API-Key': this.config.appKey } : {};
  }

  // Wraps fetch so that iOS Safari's opaque "Load failed" TypeError gets
  // a useful message (which URL failed). Mobile users only ever saw the
  // raw error text, which left them with no way to diagnose a cross-origin
  // reachability or CORS failure.
  private async fetchWithContext(url: string, opts: RequestInit): Promise<Response> {
    try {
      return await fetch(url, opts);
    } catch (e: any) {
      const msg = e?.message || 'Network error';
      throw new Error(`${msg} — could not reach ${url}`);
    }
  }

  private getSessionId(): string {
    let sid = sessionStorage.getItem('pw-session-id');
    if (!sid) {
      sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('pw-session-id', sid);
    }
    return sid;
  }

  private bindShortcut() {
    const parts = this.config.shortcut.toLowerCase().split('+');
    document.addEventListener('keydown', (e) => {
      const ctrl = parts.includes('ctrl') ? e.ctrlKey || e.metaKey : true;
      const shift = parts.includes('shift') ? e.shiftKey : true;
      const alt = parts.includes('alt') ? e.altKey : true;
      const key = parts.find((p) => !['ctrl', 'shift', 'alt', 'meta'].includes(p));
      if (ctrl && shift && alt && key && e.key.toLowerCase() === key) {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  private emit(event: string, data: unknown) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) handler(data);
    }
  }

  // Public API
  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.historyIndex = -1;
    this.renderPanel();
    // Hide the trigger while the panel is open on narrow viewports. On
    // mobile the panel covers the trigger, so the only way to dismiss was
    // to tap through the panel — now the panel has a pw-close-btn instead.
    const trigger = this.shadow.querySelector('.pw-trigger') as HTMLElement | null;
    if (trigger && window.matchMedia('(max-width: 480px)').matches) {
      trigger.classList.add('pw-trigger-hidden');
    }
    document.addEventListener('keydown', this.escHandler, true);
  }

  appendToFeedback(feedbackId: string) {
    this.appendTargetId = feedbackId;
    this.pendingScreenshots = [];
    this.selectedElements = [];
    persistScreenshots([]);
    persistSelections([]);
    if (!this.isOpen) this.open();
    else this.renderPanel();
  }

  exitAppendMode() {
    this.appendTargetId = null;
    if (this.isOpen) this.renderPanel();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    document.removeEventListener('keydown', this.escHandler, true);
    const trigger = this.shadow.querySelector('.pw-trigger') as HTMLElement | null;
    if (trigger) trigger.classList.remove('pw-trigger-hidden');
    if (this.pickerCleanup) {
      this.pickerCleanup();
      this.pickerCleanup = null;
    }
    // Save state before removing panel
    const input = this.shadow.querySelector('#pw-chat-input') as HTMLTextAreaElement;
    if (input) {
      this.savedDraft = input.value;
      try { localStorage.setItem('pw-widget-draft', input.value); } catch {}
    }
    persistScreenshots(this.pendingScreenshots);
    persistSelections(this.selectedElements);
    const panel = this.shadow.querySelector('.pw-panel');
    if (panel) panel.remove();
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  async submit(opts: SubmitOptions) {
    const context = collectContext(this.config.collectors);
    const screenshots: Blob[] = [];

    if (opts.screenshot) {
      const excludeWidget = this.sessionBridge.screenshotIncludeWidget && this.excludeWidget;
      const blob = await captureScreenshot({ excludeWidget, excludeCursor: this.excludeCursor, keepStream: this.keepStream, method: this.screenshotMethod });
      if (blob) screenshots.push(blob);
    }

    const payload = {
      type: opts.type || 'programmatic',
      title: opts.title || '',
      description: opts.description || '',
      data: opts.data,
      context,
      sourceUrl: location.href,
      userAgent: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      sessionId: this.getSessionId(),
      userId: this.identity?.id,
      tags: opts.tags,
    };

    if (screenshots.length > 0) {
      const formData = new FormData();
      formData.append('feedback', JSON.stringify(payload));
      for (const blob of screenshots) {
        formData.append('screenshots', blob, `screenshot-${Date.now()}.png`);
      }
      const res = await fetch(this.config.endpoint, { method: 'POST', headers: this.apiHeaders(), body: formData });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      this.emit('submit', { ...opts, id: result.id });
      return result;
    } else {
      const res = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.apiHeaders() },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      this.emit('submit', { ...opts, id: result.id });
      return result;
    }
  }

  identify(user: UserIdentity) {
    this.identity = user;
  }

  configure(opts: Partial<WidgetConfig>) {
    Object.assign(this.config, opts);
    if (opts.collectors) installCollectors(opts.collectors);
  }

  on(event: string, handler: EventHandler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  off(event: string, handler: EventHandler) {
    this.eventHandlers.get(event)?.delete(handler);
  }

  openAdmin(panel?: PanelType, opts?: { param?: string }) {
    if (panel) {
      this.overlayManager.openPanel(panel, opts);
    } else {
      if (!this.isOpen) this.open();
      this.toggleAdminOptions();
    }
  }

  closeAdmin() {
    this.overlayManager.closeAll();
  }

  setAdminToken(token: string) {
    sessionStorage.setItem('pw-admin-token-overlay', token);
  }

  destroy() {
    this.close();
    stopScreencastStream();
    this.overlayManager.destroy();
    this.sessionBridge.disconnect();
    this.host.remove();
  }
}
