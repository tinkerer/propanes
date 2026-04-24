import { OVERLAY_CSS } from './overlay-styles.js';

export type PanelType = 'feedback' | 'detail' | 'sessions' | 'files' | 'settings' | 'terminal' | 'workbench' | 'cos';

export type DockedEdge = 'left' | 'right' | 'bottom' | null;

interface PanelConfig {
  icon: string;
  title: string;
  path: (appId: string, param?: string) => string;
  width: number;
  height: number;
  embedMode?: string; // 'true' | 'workbench'
}

const PANEL_CONFIGS: Record<PanelType, PanelConfig> = {
  feedback: { icon: '\u{1F4CB}', title: 'Feedback', path: (a) => `/app/${a}/feedback`, width: 650, height: 500 },
  detail: { icon: '\u{1F4CB}', title: 'Feedback Detail', path: (a, p) => `/app/${a}/feedback/${p}`, width: 650, height: 600 },
  sessions: { icon: '\u26A1', title: 'Sessions', path: (a) => `/app/${a}/sessions`, width: 650, height: 500 },
  files: { icon: '\u{1F4C2}', title: 'Files', path: (a) => `/app/${a}/sessions`, width: 650, height: 500 },
  settings: { icon: '\u2699', title: 'Settings', path: () => '/settings/applications', width: 550, height: 500 },
  terminal: { icon: '\u{1F4BB}', title: 'Terminal', path: (a) => `/app/${a}/sessions`, width: 750, height: 500 },
  workbench: { icon: '\u2B1A', title: 'ProPanes Overlay', path: (a) => `/app/${a}/sessions`, width: 900, height: 600, embedMode: 'workbench' },
  cos: { icon: '★', title: 'Ops', path: () => '/', width: 480, height: 620, embedMode: 'cos' },
};

interface PanelState {
  id: string;
  type: PanelType;
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

const PERSIST_KEY = 'pw-workbench-layout';
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
  private workbenchId: string | null = null;
  public onWaitingChange: ((sessionId: string, state: string, waitingCount: number) => void) | null = null;

  constructor(shadow: ShadowRoot, endpoint: string, appId: string) {
    this.shadow = shadow;
    this.appId = appId;

    // Derive admin base URL from widget endpoint
    const url = new URL(endpoint, window.location.href);
    this.adminBaseUrl = `${url.origin}/admin/`;

    this.messageHandler = (e: MessageEvent) => this.handlePostMessage(e);
    window.addEventListener('message', this.messageHandler);
  }

  private injectStyles() {
    if (this.styleInjected) return;
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    this.shadow.appendChild(style);
    this.styleInjected = true;
  }

  openPanel(type: PanelType, opts?: { param?: string; appId?: string; launcherId?: string }): string {
    this.injectStyles();

    const id = `pw-panel-${++panelCounter}`;
    const config = PANEL_CONFIGS[type];
    const appId = opts?.appId || this.appId;
    const hashRoute = config.path(appId, opts?.param);
    const embedMode = config.embedMode || 'true';
    const autoTerminal = type === 'terminal' ? '&autoTerminal=1' : '';
    const launcherParam = opts?.launcherId ? `&launcherId=${encodeURIComponent(opts.launcherId)}` : '';
    const iframeUrl = `${this.adminBaseUrl}?embed=${embedMode}&appId=${encodeURIComponent(appId)}${autoTerminal}${launcherParam}#${hashRoute}`;
    console.log('[pw] openPanel', type, 'url:', iframeUrl, 'appId:', appId);

    // For workbench, restore persisted layout if available
    let width = config.width;
    let height = config.height;
    let x = Math.max(20, (window.innerWidth - width) / 2 + panelCounter * 30);
    let y = Math.max(20, (window.innerHeight - height) / 2 + panelCounter * 20);
    let scale = 1;
    let dockedEdge: DockedEdge = null;
    let drawerCollapsed = false;

    if (type === 'workbench') {
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

    const panel = this.createPanelDOM(id, config, iframeUrl, x, y, width, height, type === 'workbench');
    const iframe = panel.querySelector('.pw-overlay-iframe') as HTMLIFrameElement;
    const iframeScale = panel.querySelector('.pw-overlay-iframe-scale') as HTMLElement;

    const state: PanelState = { id, type, el: panel, iframe, iframeScale, x, y, width, height, scale, minimized: false, zIndex: ++nextZ, dockedEdge, drawerCollapsed };
    applyScale(state);
    panel.style.zIndex = String(state.zIndex);
    this.panels.set(id, state);

    this.shadow.appendChild(panel);
    this.sendInitToIframe(iframe);

    if (dockedEdge) {
      this.applyDockedPosition(state);
    }
    if (drawerCollapsed) {
      panel.classList.add('pw-drawer-collapsed');
    }

    if (type === 'workbench') {
      this.workbenchId = id;
    }

    return id;
  }

  /** Open or focus the workbench panel */
  openWorkbench(): string {
    if (this.workbenchId && this.panels.has(this.workbenchId)) {
      const state = this.panels.get(this.workbenchId)!;
      // If drawer-collapsed, expand it
      if (state.drawerCollapsed) {
        this.toggleDrawer(this.workbenchId);
      }
      // If minimized, restore
      if (state.minimized) {
        this.minimizePanel(this.workbenchId);
      }
      this.bringToFront(this.workbenchId);
      return this.workbenchId;
    }
    return this.openPanel('workbench');
  }

  /** Show the workbench if hidden (for auto-jump) */
  revealWorkbench() {
    if (!this.workbenchId) return;
    const state = this.panels.get(this.workbenchId);
    if (!state) return;
    if (state.drawerCollapsed) {
      this.toggleDrawer(this.workbenchId);
    }
    if (state.minimized) {
      this.minimizePanel(this.workbenchId);
    }
    this.bringToFront(this.workbenchId);
  }

  get hasWorkbench(): boolean {
    return !!this.workbenchId && this.panels.has(this.workbenchId);
  }

  closePanel(id: string) {
    const state = this.panels.get(id);
    if (!state) return;
    if (state.type === 'workbench') {
      this.persistLayout(state);
      this.workbenchId = null;
    }
    state.el.remove();
    this.panels.delete(id);
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
      iframe.contentWindow?.postMessage({
        type: 'pw-embed-init',
        token,
        appId: this.appId,
      }, '*');
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
          state.iframe.contentWindow?.postMessage({
            type: 'pw-embed-init',
            token: data.token,
            appId: this.appId,
          }, '*');
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
        }
      }
    } else if (data.type === 'pw-embed-waiting') {
      // Session waiting for input notification
      if (this.onWaitingChange) {
        this.onWaitingChange(data.sessionId, data.state, data.waitingCount);
      }
    } else if (data.type === 'pw-embed-gesture') {
      // Two-finger pan / pinch-zoom from inside the iframe
      this.handleGesture(e, data);
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
      if (target.type === 'workbench') this.persistLayout(target);
    }
  }

  private createPanelDOM(id: string, config: PanelConfig, iframeUrl: string, x: number, y: number, width: number, height: number, isWorkbench = false): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'pw-overlay-panel';
    if (isWorkbench) panel.classList.add('pw-workbench-panel');
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

    if (isWorkbench) {
      // Dock buttons for workbench
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
    minBtn.title = isWorkbench ? 'Hide to drawer' : 'Minimize';
    minBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isWorkbench) {
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

    // Transparent mask to capture mouse events during drag/resize over iframe
    const mask = document.createElement('div');
    mask.className = 'pw-overlay-iframe-mask';

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

    if (state.type === 'workbench') this.persistLayout(state);
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

    if (state.type === 'workbench') this.persistLayout(state);
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
    if (!snapPreview && state.type === 'workbench') {
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

      // Show snap preview for workbench
      if (snapPreview && state.type === 'workbench') {
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
      if (state.type === 'workbench') {
        const edge = this.detectEdgeSnap(ev.clientX, ev.clientY, 0, 0);
        if (edge) {
          this.dockToEdge(id, edge);
        } else {
          this.persistLayout(state);
        }
      }

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
      if (state.type === 'workbench') this.persistLayout(state);
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
    this.closeAll();
  }
}
