import { OVERLAY_CSS } from './overlay-styles.js';
import { cascadeLayout, centerLayout, clampRectToViewport, type PanelRect } from './panel-layout.js';

export type ArrangeMode = 'cascade' | 'center';

/** Ctrl/Cmd+Shift tapped this many times within SHIFT_TAP_WINDOW_MS enters move mode. */
const MOVE_MODE_TAPS = 3;
const SHIFT_TAP_WINDOW_MS = 800;

export type PanelType = 'feedback' | 'detail' | 'sessions' | 'files' | 'settings' | 'terminal' | 'panes' | 'cos';

export type DockedEdge = 'left' | 'right' | 'bottom' | null;

interface PanelConfig {
  icon: string;
  title: string;
  path: (appId: string, param?: string) => string;
  width: number;
  height: number;
  embedMode?: string; // 'true' | 'panes'
}

const PANEL_CONFIGS: Record<PanelType, PanelConfig> = {
  feedback: { icon: '\u{1F4CB}', title: 'Feedback', path: (a) => `/app/${a}/feedback`, width: 650, height: 500 },
  detail: { icon: '\u{1F4CB}', title: 'Feedback Detail', path: (a, p) => `/app/${a}/feedback/${p}`, width: 650, height: 600 },
  sessions: { icon: '\u26A1', title: 'Sessions', path: (a, p) => p ? `/app/${a}/sessions/${p}` : `/app/${a}/sessions`, width: 650, height: 500 },
  files: { icon: '\u{1F4C2}', title: 'Files', path: (a) => `/app/${a}/sessions`, width: 650, height: 500 },
  settings: { icon: '\u2699', title: 'Settings', path: () => '/settings/preferences', width: 550, height: 500 },
  terminal: { icon: '\u{1F4BB}', title: 'Terminal', path: (a) => `/app/${a}/sessions`, width: 750, height: 500 },
  panes: { icon: '\u2B1A', title: 'ProPanes Overlay', path: (a) => `/app/${a}/sessions`, width: 900, height: 600, embedMode: 'panes' },
  cos: { icon: '★', title: 'Ops', path: () => '/', width: 480, height: 620, embedMode: 'cos' },
};

interface PanelState {
  id: string;
  type: PanelType;
  /** Open options + latest hash route, so the panel can be re-created after a reload. */
  appId: string;
  param?: string;
  launcherId?: string;
  route: string;
  el: HTMLElement;
  iframe: HTMLIFrameElement;
  iframeScale: HTMLElement;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  minimized: boolean;
  zIndex: number;
  dockedEdge: DockedEdge;
  drawerCollapsed: boolean;
}

interface PersistedLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  scale?: number;
  dockedEdge: DockedEdge;
  drawerCollapsed: boolean;
}

const MIN_SCALE = 0.4;
const MAX_SCALE = 2.5;

const PERSIST_KEY = 'pw-panes-layout';
/** Every open overlay panel (type, route, rect) — rewritten on each change so a
 *  reload can offer to bring the previous windows back (Settings → Overlay windows). */
const OPEN_PANELS_KEY = 'pw-overlay-open-panels';

export interface PersistedPanel {
  type: PanelType;
  appId: string;
  param?: string;
  launcherId?: string;
  route: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  minimized: boolean;
  dockedEdge: DockedEdge;
}

/** What the embedded Settings page needs to render the restore offer. */
export interface RestorablePanelSummary {
  type: PanelType;
  title: string;
}
export const ALPHA_FEATURES_KEY = 'pw-alpha-features';

export function alphaFeaturesEnabled(): boolean {
  try { return localStorage.getItem(ALPHA_FEATURES_KEY) === 'true'; } catch { return false; }
}
const DOCK_SNAP_DISTANCE = 40;

let nextZ = 2147483600;
let panelCounter = 0;

function clampScale(s: number): number {
  if (!Number.isFinite(s)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

function applyScale(state: { iframeScale: HTMLElement; iframe: HTMLIFrameElement; scale: number }) {
  const inv = 1 / state.scale;
  // Scale the iframe content. We size the iframe at inv * 100% so post-scale it matches the wrapper.
  state.iframeScale.style.transformOrigin = '0 0';
  state.iframeScale.style.transform = `scale(${state.scale})`;
  state.iframeScale.style.width = `${inv * 100}%`;
  state.iframeScale.style.height = `${inv * 100}%`;
}

export class OverlayPanelManager {
  private panels = new Map<string, PanelState>();
  private shadow: ShadowRoot;
  private adminBaseUrl: string;
  private appId: string;
  private styleInjected = false;
  private messageHandler: (e: MessageEvent) => void;
  private panesId: string | null = null;
  public onWaitingChange: ((sessionId: string, state: string, waitingCount: number) => void) | null = null;

  // --- Move mode (Ctrl+Shift ×3) ---
  // Mirrors the admin SPA's sticky "triple-shift" mode: once active, the whole
  // panel (iframe body included) becomes a drag surface so a panel whose header
  // has slipped off the top of the viewport can still be pulled back. Exit with
  // Ctrl+Shift (after releasing the modifiers), Escape or Enter.
  // Panels that were open when the previous page instance unloaded. Captured
  // once at construction (before anything here rewrites OPEN_PANELS_KEY) and
  // offered to the user via the embedded Settings page rather than reopened
  // automatically — a reload is often meant to clear the deck.
  private restorable: PersistedPanel[] = [];

  private moveMode = false;
  private moveModeArmed = false;
  private shiftTaps: number[] = [];
  private keyDownHandler: (e: KeyboardEvent) => void;
  private keyUpHandler: (e: KeyboardEvent) => void;
  private blurHandler: () => void;

  constructor(shadow: ShadowRoot, endpoint: string, appId: string) {
    this.shadow = shadow;
    this.appId = appId;

    // Derive admin base URL from widget endpoint. Strip the `/api/v1/feedback`
    // suffix rather than taking `.origin`, so any path prefix the widget is
    // proxied under (e.g. the dashboard's same-origin `/propanes` mount) is
    // preserved — otherwise overlay panels load the host SPA's `/admin` route
    // instead of the widget server's.
    const url = new URL(endpoint, window.location.href);
    url.pathname = url.pathname.replace(/\/api\/v1\/feedback\/?$/, '');
    url.search = '';
    url.hash = '';
    this.adminBaseUrl = `${(url.origin + url.pathname).replace(/\/$/, '')}/admin/`;

    this.restorable = this.loadOpenPanels();

    this.messageHandler = (e: MessageEvent) => this.handlePostMessage(e);
    window.addEventListener('message', this.messageHandler);

    // Capture on `window` so we run before the host page's own document-level
    // handlers (the admin SPA's shortcuts.ts calls stopImmediatePropagation on
    // the activating Shift press). We never stop propagation ourselves, so a
    // host that has its own triple-shift mode enters/exits in lockstep.
    this.keyDownHandler = (e: KeyboardEvent) => this.handleMoveModeKeyDown(e);
    this.keyUpHandler = (e: KeyboardEvent) => this.handleMoveModeKeyUp(e);
    this.blurHandler = () => { this.shiftTaps.length = 0; };
    window.addEventListener('keydown', this.keyDownHandler, true);
    window.addEventListener('keyup', this.keyUpHandler, true);
    window.addEventListener('blur', this.blurHandler);
  }

  private floatingPanels(): PanelState[] {
    const list: PanelState[] = [];
    for (const [, state] of this.panels) {
      if (state.dockedEdge || state.drawerCollapsed) continue;
      list.push(state);
    }
    return list;
  }

  private handleMoveModeKeyDown(e: KeyboardEvent) {
    if (this.moveMode) {
      if (e.key === 'Escape' || e.key === 'Enter') {
        this.exitMoveMode();
        return;
      }
      if (e.key === 'Shift' && !e.repeat && (e.ctrlKey || e.metaKey) && this.moveModeArmed) {
        this.exitMoveMode();
      }
      return;
    }
    if (e.key !== 'Shift' || e.repeat) return;
    if (!(e.ctrlKey || e.metaKey)) {
      this.shiftTaps.length = 0;
      return;
    }
    const now = Date.now();
    this.shiftTaps.push(now);
    while (this.shiftTaps.length > 0 && now - this.shiftTaps[0] > SHIFT_TAP_WINDOW_MS) this.shiftTaps.shift();
    if (this.shiftTaps.length >= MOVE_MODE_TAPS) {
      this.shiftTaps.length = 0;
      // Nothing to move — don't flip into a mode with no visible effect.
      if (this.floatingPanels().length === 0) return;
      this.enterMoveMode(false);
    }
  }

  private handleMoveModeKeyUp(e: KeyboardEvent) {
    if (!this.moveMode || this.moveModeArmed) return;
    // Arm the exit chord only once every modifier has been released after
    // activation, otherwise the third tap's own key-up would exit at once.
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) this.moveModeArmed = true;
  }

  /**
   * @param armed true when the chord was completed elsewhere (e.g. inside an
   * embedded admin iframe) so our key-up never sees the modifiers release.
   */
  enterMoveMode(armed: boolean) {
    if (this.moveMode) return;
    this.moveMode = true;
    this.moveModeArmed = armed;
    this.shiftTaps.length = 0;
    for (const [, state] of this.panels) state.el.classList.add('pw-move-mode');
    this.broadcastMoveMode(true);
  }

  exitMoveMode() {
    if (!this.moveMode) return;
    this.moveMode = false;
    this.moveModeArmed = false;
    for (const [, state] of this.panels) state.el.classList.remove('pw-move-mode');
    this.broadcastMoveMode(false);
  }

  get isMoveMode(): boolean {
    return this.moveMode;
  }

  private broadcastMoveMode(active: boolean) {
    for (const [, state] of this.panels) {
      try {
        state.iframe.contentWindow?.postMessage({ type: 'pw-embed-move-mode', active }, '*');
      } catch { /* ignore */ }
    }
  }

  private rectOf(state: PanelState): PanelRect {
    return { x: state.x, y: state.y, width: state.width, height: state.height };
  }

  private applyRect(state: PanelState, rect: PanelRect) {
    state.x = rect.x;
    state.y = rect.y;
    state.width = rect.width;
    state.height = rect.height;
    state.el.style.left = `${rect.x}px`;
    state.el.style.top = `${rect.y}px`;
    if (!state.minimized) {
      state.el.style.width = `${rect.width}px`;
      state.el.style.height = `${rect.height}px`;
    }
  }

  /** Pull a floating panel back so its header is reachable. */
  private clampToViewport(state: PanelState) {
    if (state.dockedEdge || state.drawerCollapsed) return;
    const vp = { width: window.innerWidth, height: window.innerHeight };
    const clamped = clampRectToViewport(this.rectOf(state), vp);
    if (clamped.x !== state.x || clamped.y !== state.y) this.applyRect(state, clamped);
  }

  /**
   * Re-lay out every floating panel: `cascade` staggers them diagonally from
   * the top-left in z-order (front-most last), `center` stacks them all in the
   * middle of the viewport. Docked / drawer-collapsed panels are left alone —
   * their position is already deterministic and visible.
   */
  arrangePanels(mode: ArrangeMode) {
    const panels = this.floatingPanels().sort((a, b) => a.zIndex - b.zIndex);
    if (panels.length === 0) return;
    const vp = { width: window.innerWidth, height: window.innerHeight };
    const rects = panels.map((p) => this.rectOf(p));
    const laidOut = mode === 'cascade' ? cascadeLayout(rects, vp) : centerLayout(rects, vp);
    panels.forEach((state, i) => {
      if (state.minimized) {
        state.minimized = false;
        state.el.classList.remove('pw-minimized');
      }
      this.applyRect(state, laidOut[i]);
      if (state.type === 'panes') this.persistLayout(state);
    });
    this.persistOpenPanels();
  }

  private injectStyles() {
    if (this.styleInjected) return;
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    this.shadow.appendChild(style);
    this.styleInjected = true;
  }

  openPanel(type: PanelType, opts?: { param?: string; appId?: string; launcherId?: string; route?: string; rect?: Partial<PanelRect> & { scale?: number } }): string {
    this.injectStyles();

    const id = `pw-panel-${++panelCounter}`;
    const config = PANEL_CONFIGS[type];
    const appId = opts?.appId || this.appId;
    const hashRoute = opts?.route || config.path(appId, opts?.param);
    const embedMode = config.embedMode || 'true';
    // A restored terminal panel carries the route of the session it was
    // already showing — autoTerminal=1 would spawn a second one on top.
    const autoTerminal = type === 'terminal' && !opts?.route ? '&autoTerminal=1' : '';
    const launcherParam = opts?.launcherId ? `&launcherId=${encodeURIComponent(opts.launcherId)}` : '';
    const iframeUrl = `${this.adminBaseUrl}?embed=${embedMode}&appId=${encodeURIComponent(appId)}${autoTerminal}${launcherParam}#${hashRoute}`;
    console.log('[pw] openPanel', type, 'url:', iframeUrl, 'appId:', appId);

    // For the panes panel, restore persisted layout if available
    let width = config.width;
    let height = config.height;
    let x = Math.max(20, (window.innerWidth - width) / 2 + panelCounter * 30);
    let y = Math.max(20, (window.innerHeight - height) / 2 + panelCounter * 20);
    let scale = 1;
    let dockedEdge: DockedEdge = null;
    let drawerCollapsed = false;

    if (type === 'panes') {
      const persisted = this.loadPersistedLayout();
      if (persisted) {
        x = persisted.x;
        y = persisted.y;
        width = persisted.width;
        height = persisted.height;
        scale = clampScale(persisted.scale ?? 1);
        dockedEdge = persisted.dockedEdge;
        drawerCollapsed = persisted.drawerCollapsed;
      }
    }

    if (opts?.rect) {
      if (typeof opts.rect.x === 'number') x = opts.rect.x;
      if (typeof opts.rect.y === 'number') y = opts.rect.y;
      if (typeof opts.rect.width === 'number') width = opts.rect.width;
      if (typeof opts.rect.height === 'number') height = opts.rect.height;
      if (typeof opts.rect.scale === 'number') scale = clampScale(opts.rect.scale);
    }

    if (!dockedEdge) {
      // A persisted or computed rect may be off-screen (smaller window than
      // last time, negative y from an old drag) — keep the header grabbable.
      ({ x, y } = clampRectToViewport({ x, y, width, height }, { width: window.innerWidth, height: window.innerHeight }));
    }

    const panel = this.createPanelDOM(id, config, iframeUrl, x, y, width, height, type === 'panes');
    const iframe = panel.querySelector('.pw-overlay-iframe') as HTMLIFrameElement;
    const iframeScale = panel.querySelector('.pw-overlay-iframe-scale') as HTMLElement;

    const state: PanelState = { id, type, appId, param: opts?.param, launcherId: opts?.launcherId, route: hashRoute, el: panel, iframe, iframeScale, x, y, width, height, scale, minimized: false, zIndex: ++nextZ, dockedEdge, drawerCollapsed };
    applyScale(state);
    panel.style.zIndex = String(state.zIndex);
    if (this.moveMode) panel.classList.add('pw-move-mode');
    this.panels.set(id, state);

    this.shadow.appendChild(panel);
    this.sendInitToIframe(iframe);

    if (dockedEdge) {
      this.applyDockedPosition(state);
    }
    if (drawerCollapsed) {
      panel.classList.add('pw-drawer-collapsed');
    }

    if (type === 'panes') {
      this.panesId = id;
    }

    this.persistOpenPanels();
    return id;
  }

  // --- Reload restore ---

  private initPayload(token: string | null) {
    return {
      type: 'pw-embed-init',
      token,
      appId: this.appId,
      restorablePanels: this.restorableSummaries(),
    };
  }

  restorableSummaries(): RestorablePanelSummary[] {
    return this.restorable.map((p) => ({ type: p.type, title: p.title }));
  }

  /** Re-open every panel from the previous page instance, then drop the offer. */
  restorePreviousPanels() {
    const list = this.restorable;
    this.restorable = [];
    for (const p of list) {
      if (!PANEL_CONFIGS[p.type]) continue;
      if (p.type === 'panes') {
        this.openPanes();
        continue;
      }
      const id = this.openPanel(p.type, {
        appId: p.appId,
        param: p.param,
        launcherId: p.launcherId,
        route: p.route,
        rect: { x: p.x, y: p.y, width: p.width, height: p.height, scale: p.scale },
      });
      const state = this.panels.get(id);
      if (!state) continue;
      if (p.dockedEdge) this.dockToEdge(id, p.dockedEdge);
      if (p.minimized) this.minimizePanel(id);
    }
    this.broadcastRestorable();
  }

  /** Forget the previous page's windows without reopening them. */
  dismissRestorable() {
    this.restorable = [];
    this.broadcastRestorable();
  }

  private broadcastRestorable() {
    const restorablePanels = this.restorableSummaries();
    for (const [, state] of this.panels) {
      try {
        state.iframe.contentWindow?.postMessage({ type: 'pw-embed-overlay-state', restorablePanels }, '*');
      } catch { /* ignore */ }
    }
  }

  private persistOpenPanels() {
    const list: PersistedPanel[] = [];
    for (const [, state] of this.panels) {
      list.push({
        type: state.type,
        appId: state.appId,
        param: state.param,
        launcherId: state.launcherId,
        route: state.route,
        // The header text mirrors the iframe's document.title ("ProPanes
        // <host>"), which says nothing about the window — name it by kind.
        title: PANEL_CONFIGS[state.type].title,
        x: state.x, y: state.y, width: state.width, height: state.height,
        scale: state.scale,
        minimized: state.minimized,
        dockedEdge: state.dockedEdge,
      });
    }
    try {
      localStorage.setItem(OPEN_PANELS_KEY, JSON.stringify(list));
    } catch { /* ignore */ }
  }

  private loadOpenPanels(): PersistedPanel[] {
    try {
      const raw = localStorage.getItem(OPEN_PANELS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((p) => p && typeof p.type === 'string' && PANEL_CONFIGS[p.type as PanelType]);
    } catch { return []; }
  }

  /**
   * Re-route an existing panel's iframe to a new hash route. The embed query
   * string is kept identical so only the fragment changes — the browser
   * performs an in-place fragment navigation and the admin SPA's hash router
   * picks it up without a full reload. Returns false if the panel is gone
   * (user closed it).
   */
  navigatePanel(id: string, type: PanelType, opts?: { param?: string; appId?: string }): boolean {
    const state = this.panels.get(id);
    if (!state) return false;
    const config = PANEL_CONFIGS[type];
    const appId = opts?.appId || this.appId;
    const hashRoute = config.path(appId, opts?.param);
    const embedMode = config.embedMode || 'true';
    state.iframe.src = `${this.adminBaseUrl}?embed=${embedMode}&appId=${encodeURIComponent(appId)}#${hashRoute}`;
    state.route = hashRoute;
    state.appId = appId;
    state.param = opts?.param;
    this.bringToFront(id);
    this.persistOpenPanels();
    return true;
  }

  /**
   * Show (message) or clear (null) a slim status ribbon over the top of a
   * panel's iframe — used e.g. while a freshly dispatched session is still
   * spinning up. Deliberately a ribbon rather than a full veil so the iframe
   * underneath (session list, or the login form when un-authed) stays usable.
   */
  setPanelStatus(id: string, message: string | null) {
    const state = this.panels.get(id);
    if (!state) return;
    const wrap = state.el.querySelector('.pw-overlay-iframe-wrap');
    if (!wrap) return;
    let ribbon = wrap.querySelector('.pw-overlay-status') as HTMLElement | null;
    if (!message) {
      ribbon?.remove();
      return;
    }
    if (!ribbon) {
      ribbon = document.createElement('div');
      ribbon.className = 'pw-overlay-status';
      ribbon.innerHTML = '<span class="pw-overlay-status-spinner"></span><span class="pw-overlay-status-text"></span>';
      wrap.appendChild(ribbon);
    }
    (ribbon.querySelector('.pw-overlay-status-text') as HTMLElement).textContent = message;
  }

  /** Open or focus the panes panel */
  openPanes(): string {
    if (this.panesId && this.panels.has(this.panesId)) {
      const state = this.panels.get(this.panesId)!;
      // If drawer-collapsed, expand it
      if (state.drawerCollapsed) {
        this.toggleDrawer(this.panesId);
      }
      // If minimized, restore
      if (state.minimized) {
        this.minimizePanel(this.panesId);
      }
      this.bringToFront(this.panesId);
      return this.panesId;
    }
    return this.openPanel('panes');
  }

  /** Show the panes panel if hidden (for auto-jump) */
  revealPanes() {
    if (!this.panesId) return;
    const state = this.panels.get(this.panesId);
    if (!state) return;
    if (state.drawerCollapsed) {
      this.toggleDrawer(this.panesId);
    }
    if (state.minimized) {
      this.minimizePanel(this.panesId);
    }
    this.bringToFront(this.panesId);
  }

  get hasPanes(): boolean {
    return !!this.panesId && this.panels.has(this.panesId);
  }

  closePanel(id: string) {
    const state = this.panels.get(id);
    if (!state) return;
    if (state.type === 'panes') {
      this.persistLayout(state);
      this.panesId = null;
    }
    state.el.remove();
    this.panels.delete(id);
    this.persistOpenPanels();
  }

  closeAll() {
    for (const [id] of this.panels) this.closePanel(id);
  }

  minimizePanel(id: string) {
    const state = this.panels.get(id);
    if (!state) return;
    state.minimized = !state.minimized;
    state.el.classList.toggle('pw-minimized', state.minimized);
    if (!state.minimized) {
      state.el.style.width = `${state.width}px`;
      state.el.style.height = `${state.height}px`;
    }
    this.persistOpenPanels();
  }

  bringToFront(id: string) {
    const state = this.panels.get(id);
    if (!state) return;
    state.zIndex = ++nextZ;
    state.el.style.zIndex = String(state.zIndex);
  }

  get panelCount() {
    return this.panels.size;
  }

  private sendInitToIframe(iframe: HTMLIFrameElement) {
    const token = sessionStorage.getItem('pw-admin-token-overlay');
    const sendInit = () => {
      iframe.contentWindow?.postMessage(this.initPayload(token), '*');
    };
    iframe.addEventListener('load', sendInit);
  }

  private handlePostMessage(e: MessageEvent) {
    const data = e.data;
    if (!data?.type) return;

    if (data.type === 'pw-embed-auth') {
      if (data.token) {
        sessionStorage.setItem('pw-admin-token-overlay', data.token);
        // Forward token to all iframes
        for (const [, state] of this.panels) {
          state.iframe.contentWindow?.postMessage(this.initPayload(data.token), '*');
        }
      }
    } else if (data.type === 'pw-embed-navigate') {
      if (data.route && data.openNew) {
        // User clicked something that should open in a new panel
        const route = data.route as string;
        const feedbackMatch = route.match(/\/app\/([^/]+)\/feedback\/(.+)/);
        if (feedbackMatch) {
          this.openPanel('detail', { appId: feedbackMatch[1], param: feedbackMatch[2] });
        }
      }
    } else if (data.type === 'pw-embed-title') {
      // Update panel header title from iframe
      for (const [, state] of this.panels) {
        if (state.iframe.contentWindow === e.source) {
          const titleEl = state.el.querySelector('.pw-overlay-header-title');
          if (titleEl && data.title) {
            titleEl.textContent = data.title;
          }
          if (typeof data.route === 'string' && data.route) state.route = data.route;
        }
      }
      this.persistOpenPanels();
    } else if (data.type === 'pw-embed-waiting') {
      // Session waiting for input notification
      if (this.onWaitingChange) {
        this.onWaitingChange(data.sessionId, data.state, data.waitingCount);
      }
    } else if (data.type === 'pw-embed-gesture') {
      // Two-finger pan / pinch-zoom from inside the iframe
      this.handleGesture(e, data);
    } else if (data.type === 'pw-embed-move-mode') {
      // Chord completed (or exited) inside an embedded admin iframe — key
      // events there never reach the host document, so the iframe relays it.
      if (data.active === true) this.enterMoveMode(true);
      else if (data.active === false) this.exitMoveMode();
    } else if (data.type === 'pw-embed-arrange') {
      // "Cascade / center windows" buttons on the embedded Settings page.
      if (data.mode === 'cascade' || data.mode === 'center') this.arrangePanels(data.mode);
    } else if (data.type === 'pw-embed-restore') {
      // "Restore previous windows" / "Dismiss" on the embedded Settings page.
      if (data.dismiss) this.dismissRestorable();
      else this.restorePreviousPanels();
    } else if (data.type === 'pw-embed-prefs') {
      // Browser-local admin preferences mirrored into the host origin so the
      // widget's admin menu can honor them on cross-origin host pages too.
      if (typeof data.alphaFeatures === 'boolean') {
        try { localStorage.setItem(ALPHA_FEATURES_KEY, String(data.alphaFeatures)); } catch { /* ignore */ }
      }
    }
  }

  private handleGesture(e: MessageEvent, data: any) {
    // Find which panel sent this
    let target: PanelState | null = null;
    for (const [, state] of this.panels) {
      if (state.iframe.contentWindow === e.source) {
        target = state;
        break;
      }
    }
    if (!target) return;
    // Don't gesture-move docked or drawer-collapsed panels
    if (target.dockedEdge || target.drawerCollapsed || target.minimized) return;

    if (data.phase === 'start') {
      target.el.classList.add('pw-gesturing');
      this.bringToFront(target.id);
    } else if (data.phase === 'move') {
      // Pan
      if (typeof data.dx === 'number' && typeof data.dy === 'number' && (data.dx || data.dy)) {
        target.x += data.dx;
        target.y += data.dy;
        target.el.style.left = `${target.x}px`;
        target.el.style.top = `${target.y}px`;
      }
      // Pinch zoom
      if (typeof data.scaleDelta === 'number' && data.scaleDelta !== 1) {
        const newScale = clampScale(target.scale * data.scaleDelta);
        if (newScale !== target.scale) {
          target.scale = newScale;
          applyScale(target);
        }
      }
    } else if (data.phase === 'end') {
      target.el.classList.remove('pw-gesturing');
      this.clampToViewport(target);
      if (target.type === 'panes') this.persistLayout(target);
      this.persistOpenPanels();
    }
  }

  private createPanelDOM(id: string, config: PanelConfig, iframeUrl: string, x: number, y: number, width: number, height: number, isPanes = false): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'pw-overlay-panel';
    if (isPanes) panel.classList.add('pw-panes-panel');
    panel.dataset.panelId = id;
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;

    // Drawer handle (visible when collapsed to edge)
    const drawerHandle = document.createElement('div');
    drawerHandle.className = 'pw-drawer-handle';
    drawerHandle.innerHTML = '<span class="pw-drawer-handle-icon">\u2B1A</span><span class="pw-drawer-handle-label">ProPanes</span>';
    drawerHandle.addEventListener('click', () => this.toggleDrawer(id));
    panel.appendChild(drawerHandle);

    // Header
    const header = document.createElement('div');
    header.className = 'pw-overlay-header';

    const icon = document.createElement('span');
    icon.className = 'pw-overlay-header-icon';
    icon.textContent = config.icon;

    const title = document.createElement('span');
    title.className = 'pw-overlay-header-title';
    title.textContent = config.title;

    const btns = document.createElement('div');
    btns.className = 'pw-overlay-header-btns';

    if (isPanes) {
      // Dock buttons for the panes panel
      const dockLeftBtn = document.createElement('button');
      dockLeftBtn.className = 'pw-overlay-btn';
      dockLeftBtn.innerHTML = '\u25E7'; // left half
      dockLeftBtn.title = 'Dock left';
      dockLeftBtn.addEventListener('click', (e) => { e.stopPropagation(); this.dockToEdge(id, 'left'); });

      const dockRightBtn = document.createElement('button');
      dockRightBtn.className = 'pw-overlay-btn';
      dockRightBtn.innerHTML = '\u25E8'; // right half
      dockRightBtn.title = 'Dock right';
      dockRightBtn.addEventListener('click', (e) => { e.stopPropagation(); this.dockToEdge(id, 'right'); });

      const dockBottomBtn = document.createElement('button');
      dockBottomBtn.className = 'pw-overlay-btn';
      dockBottomBtn.innerHTML = '\u2B13'; // bottom half
      dockBottomBtn.title = 'Dock bottom';
      dockBottomBtn.addEventListener('click', (e) => { e.stopPropagation(); this.dockToEdge(id, 'bottom'); });

      const undockBtn = document.createElement('button');
      undockBtn.className = 'pw-overlay-btn pw-undock-btn';
      undockBtn.innerHTML = '\u29C9'; // float
      undockBtn.title = 'Float';
      undockBtn.addEventListener('click', (e) => { e.stopPropagation(); this.dockToEdge(id, null); });

      btns.append(dockLeftBtn, dockRightBtn, dockBottomBtn, undockBtn);
    }

    const minBtn = document.createElement('button');
    minBtn.className = 'pw-overlay-btn';
    minBtn.innerHTML = '\u2013';
    minBtn.title = isPanes ? 'Hide to drawer' : 'Minimize';
    minBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isPanes) {
        this.toggleDrawer(id);
      } else {
        this.minimizePanel(id);
      }
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'pw-overlay-btn';
    closeBtn.innerHTML = '\u00D7';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.closePanel(id); });

    btns.append(minBtn, closeBtn);
    header.append(icon, title, btns);

    // iframe wrapper
    const iframeWrap = document.createElement('div');
    iframeWrap.className = 'pw-overlay-iframe-wrap';

    // Scale container — pinch-zoom transforms this without resizing the iframe pixels
    const iframeScale = document.createElement('div');
    iframeScale.className = 'pw-overlay-iframe-scale';

    const iframe = document.createElement('iframe');
    iframe.className = 'pw-overlay-iframe';
    iframe.src = iframeUrl;
    iframe.sandbox.add('allow-same-origin', 'allow-scripts', 'allow-forms', 'allow-popups');

    iframeScale.appendChild(iframe);

    // Transparent mask to capture mouse events during drag/resize over iframe.
    // In move mode it stays up permanently and doubles as the drag surface.
    const mask = document.createElement('div');
    mask.className = 'pw-overlay-iframe-mask';
    const moveHint = document.createElement('div');
    moveHint.className = 'pw-move-mode-hint';
    moveHint.textContent = 'Move mode \u2014 drag anywhere \u00B7 Ctrl+Shift or Esc to exit';
    mask.appendChild(moveHint);
    mask.addEventListener('pointerdown', (e) => {
      if (!this.moveMode) return;
      this.startDrag(id, e);
    });

    iframeWrap.append(iframeScale, mask);

    // Resize handles — pointer events so they work for mouse + touch + pen
    const resizeHandles = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    const resizeEls = resizeHandles.map((dir) => {
      const handle = document.createElement('div');
      handle.className = `pw-resize pw-resize-${dir}`;
      handle.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.startResize(id, dir, e); });
      return handle;
    });

    panel.append(header, iframeWrap, ...resizeEls);

    // Drag from header (pointer events: mouse + touch + pen)
    header.addEventListener('pointerdown', (e) => this.startDrag(id, e));

    // Focus on press
    panel.addEventListener('pointerdown', () => this.bringToFront(id));

    return panel;
  }

  // --- Edge Docking ---

  dockToEdge(id: string, edge: DockedEdge) {
    const state = this.panels.get(id);
    if (!state) return;

    const prev = state.dockedEdge;
    state.dockedEdge = edge;
    state.drawerCollapsed = false;
    state.el.classList.remove('pw-drawer-collapsed', 'pw-docked-left', 'pw-docked-right', 'pw-docked-bottom');

    if (edge) {
      this.applyDockedPosition(state);
    } else {
      // Float — restore to center if was docked
      if (prev) {
        state.x = Math.max(20, (window.innerWidth - state.width) / 2);
        state.y = Math.max(20, (window.innerHeight - state.height) / 2);
        state.el.style.left = `${state.x}px`;
        state.el.style.top = `${state.y}px`;
        state.el.style.width = `${state.width}px`;
        state.el.style.height = `${state.height}px`;
      }
    }

    if (state.type === 'panes') this.persistLayout(state);
    this.persistOpenPanels();
  }

  private applyDockedPosition(state: PanelState) {
    const edge = state.dockedEdge;
    if (!edge) return;

    state.el.classList.add(`pw-docked-${edge}`);

    if (edge === 'left') {
      state.el.style.left = '0px';
      state.el.style.top = '0px';
      state.el.style.width = `${Math.min(state.width, window.innerWidth * 0.5)}px`;
      state.el.style.height = '100vh';
    } else if (edge === 'right') {
      const w = Math.min(state.width, window.innerWidth * 0.5);
      state.el.style.left = `${window.innerWidth - w}px`;
      state.el.style.top = '0px';
      state.el.style.width = `${w}px`;
      state.el.style.height = '100vh';
    } else if (edge === 'bottom') {
      const h = Math.min(state.height, window.innerHeight * 0.6);
      state.el.style.left = '0px';
      state.el.style.top = `${window.innerHeight - h}px`;
      state.el.style.width = '100vw';
      state.el.style.height = `${h}px`;
    }
  }

  toggleDrawer(id: string) {
    const state = this.panels.get(id);
    if (!state) return;

    state.drawerCollapsed = !state.drawerCollapsed;
    state.el.classList.toggle('pw-drawer-collapsed', state.drawerCollapsed);

    if (state.type === 'panes') this.persistLayout(state);
  }

  // --- Persistence ---

  private persistLayout(state: PanelState) {
    const data: PersistedLayout = {
      x: state.x, y: state.y,
      width: state.width, height: state.height,
      scale: state.scale,
      dockedEdge: state.dockedEdge,
      drawerCollapsed: state.drawerCollapsed,
    };
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify(data));
    } catch { /* ignore */ }
  }

  private loadPersistedLayout(): PersistedLayout | null {
    try {
      const raw = localStorage.getItem(PERSIST_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }

  // --- Edge snap detection for drag ---

  private detectEdgeSnap(x: number, y: number, width: number, height: number): DockedEdge {
    if (x <= DOCK_SNAP_DISTANCE) return 'left';
    if (x + width >= window.innerWidth - DOCK_SNAP_DISTANCE) return 'right';
    if (y + height >= window.innerHeight - DOCK_SNAP_DISTANCE) return 'bottom';
    return null;
  }

  private startDrag(id: string, e: PointerEvent) {
    const state = this.panels.get(id);
    if (!state) return;
    // Only react to primary button / first contact
    if (e.button !== 0) return;
    // Don't hijack pointerdown when the user is clicking a header button —
    // setPointerCapture on the header otherwise swallows the pointerup so the
    // child button never fires its click event (close / dock buttons fail).
    const tgt = e.target as HTMLElement | null;
    if (tgt?.closest('button')) return;
    e.preventDefault();

    // If docked, undock first and start drag from float
    if (state.dockedEdge) {
      state.dockedEdge = null;
      state.el.classList.remove('pw-docked-left', 'pw-docked-right', 'pw-docked-bottom');
      state.el.style.width = `${state.width}px`;
      state.el.style.height = `${state.height}px`;
    }

    this.bringToFront(id);
    state.el.classList.add('pw-dragging');

    // Read actual position from DOM to avoid drift
    const rect = state.el.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    // Edge snap preview
    let snapPreview = this.shadow.querySelector('.pw-snap-preview') as HTMLElement | null;
    if (!snapPreview && state.type === 'panes') {
      snapPreview = document.createElement('div');
      snapPreview.className = 'pw-snap-preview';
      this.shadow.appendChild(snapPreview);
    }

    const target = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    try { target.setPointerCapture(pointerId); } catch { /* ignore */ }

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      state.x = ev.clientX - offsetX;
      state.y = ev.clientY - offsetY;
      state.el.style.left = `${state.x}px`;
      state.el.style.top = `${state.y}px`;

      // Show snap preview for the panes panel
      if (snapPreview && state.type === 'panes') {
        const edge = this.detectEdgeSnap(ev.clientX, ev.clientY, 0, 0);
        if (edge) {
          snapPreview.className = `pw-snap-preview pw-snap-${edge}`;
          snapPreview.style.display = 'block';
        } else {
          snapPreview.style.display = 'none';
        }
      }
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      state.el.classList.remove('pw-dragging');
      if (snapPreview) snapPreview.style.display = 'none';

      // Snap to edge if close enough
      if (state.type === 'panes') {
        const edge = this.detectEdgeSnap(ev.clientX, ev.clientY, 0, 0);
        if (edge) {
          this.dockToEdge(id, edge);
        } else {
          this.clampToViewport(state);
          this.persistLayout(state);
        }
      } else {
        this.clampToViewport(state);
      }
      this.persistOpenPanels();

      try { target.releasePointerCapture(pointerId); } catch { /* ignore */ }
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
    };

    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }

  private startResize(id: string, dir: string, e: PointerEvent) {
    const state = this.panels.get(id);
    if (!state) return;
    if (e.button !== 0) return;
    e.preventDefault();

    this.bringToFront(id);
    state.el.classList.add('pw-resizing');

    const startX = e.clientX;
    const startY = e.clientY;
    const rect = state.el.getBoundingClientRect();
    const origX = rect.left;
    const origY = rect.top;
    const origW = rect.width;
    const origH = rect.height;

    const target = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    try { target.setPointerCapture(pointerId); } catch { /* ignore */ }

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let newX = origX, newY = origY, newW = origW, newH = origH;

      if (dir.includes('e')) newW = Math.max(320, origW + dx);
      if (dir.includes('w')) { newW = Math.max(320, origW - dx); newX = origX + origW - newW; }
      if (dir.includes('s')) newH = Math.max(200, origH + dy);
      if (dir.includes('n')) { newH = Math.max(200, origH - dy); newY = origY + origH - newH; }

      state.x = newX;
      state.y = newY;
      state.width = newW;
      state.height = newH;
      state.el.style.left = `${newX}px`;
      state.el.style.top = `${newY}px`;
      state.el.style.width = `${newW}px`;
      state.el.style.height = `${newH}px`;
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      state.el.classList.remove('pw-resizing');
      if (state.type === 'panes') this.persistLayout(state);
      this.persistOpenPanels();
      try { target.releasePointerCapture(pointerId); } catch { /* ignore */ }
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
    };

    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }

  destroy() {
    window.removeEventListener('message', this.messageHandler);
    window.removeEventListener('keydown', this.keyDownHandler, true);
    window.removeEventListener('keyup', this.keyUpHandler, true);
    window.removeEventListener('blur', this.blurHandler);
    this.moveMode = false;
    this.closeAll();
  }
}
