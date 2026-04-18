import { OVERLAY_CSS } from './overlay-styles.js';

export type PanelType = 'feedback' | 'detail' | 'sessions' | 'aggregate' | 'settings' | 'terminal';

interface PanelConfig {
  icon: string;
  title: string;
  path: (appId: string, param?: string) => string;
  width: number;
  height: number;
}

const PANEL_CONFIGS: Record<PanelType, PanelConfig> = {
  feedback: { icon: '\u{1F4CB}', title: 'Feedback', path: (a) => `/app/${a}/feedback`, width: 650, height: 500 },
  detail: { icon: '\u{1F4CB}', title: 'Feedback Detail', path: (a, p) => `/app/${a}/feedback/${p}`, width: 650, height: 600 },
  sessions: { icon: '\u26A1', title: 'Sessions', path: (a) => `/app/${a}/sessions`, width: 650, height: 500 },
  aggregate: { icon: '\u{1F4CA}', title: 'Aggregate', path: (a) => `/app/${a}/aggregate`, width: 650, height: 500 },
  settings: { icon: '\u2699', title: 'Settings', path: () => '/settings/applications', width: 550, height: 500 },
  terminal: { icon: '\u{1F4BB}', title: 'Terminal', path: (a) => `/app/${a}/sessions`, width: 750, height: 500 },
};

interface PanelState {
  id: string;
  type: PanelType;
  el: HTMLElement;
  iframe: HTMLIFrameElement;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  zIndex: number;
}

let nextZ = 2147483600;
let panelCounter = 0;

export class OverlayPanelManager {
  private panels = new Map<string, PanelState>();
  private shadow: ShadowRoot;
  private adminBaseUrl: string;
  private appId: string;
  private styleInjected = false;
  private messageHandler: (e: MessageEvent) => void;

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
    const autoTerminal = type === 'terminal' ? '&autoTerminal=1' : '';
    const launcherParam = opts?.launcherId ? `&launcherId=${encodeURIComponent(opts.launcherId)}` : '';
    const iframeUrl = `${this.adminBaseUrl}?embed=true&appId=${encodeURIComponent(appId)}${autoTerminal}${launcherParam}#${hashRoute}`;
    console.log('[pw] openPanel', type, 'url:', iframeUrl, 'appId:', appId);

    const width = config.width;
    const height = config.height;
    const x = Math.max(20, (window.innerWidth - width) / 2 + panelCounter * 30);
    const y = Math.max(20, (window.innerHeight - height) / 2 + panelCounter * 20);

    const panel = this.createPanelDOM(id, config, iframeUrl, x, y, width, height);
    const iframe = panel.querySelector('.pw-overlay-iframe') as HTMLIFrameElement;

    const state: PanelState = { id, type, el: panel, iframe, x, y, width, height, minimized: false, zIndex: ++nextZ };
    panel.style.zIndex = String(state.zIndex);
    this.panels.set(id, state);

    this.shadow.appendChild(panel);
    this.sendInitToIframe(iframe);

    return id;
  }

  closePanel(id: string) {
    const state = this.panels.get(id);
    if (!state) return;
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
    }
  }

  private createPanelDOM(id: string, config: PanelConfig, iframeUrl: string, x: number, y: number, width: number, height: number): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'pw-overlay-panel';
    panel.dataset.panelId = id;
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;

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

    const minBtn = document.createElement('button');
    minBtn.className = 'pw-overlay-btn';
    minBtn.innerHTML = '\u2013';
    minBtn.title = 'Minimize';
    minBtn.addEventListener('click', (e) => { e.stopPropagation(); this.minimizePanel(id); });

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

    const iframe = document.createElement('iframe');
    iframe.className = 'pw-overlay-iframe';
    iframe.src = iframeUrl;
    iframe.sandbox.add('allow-same-origin', 'allow-scripts', 'allow-forms', 'allow-popups');

    // Transparent mask to capture mouse events during drag/resize over iframe
    const mask = document.createElement('div');
    mask.className = 'pw-overlay-iframe-mask';

    iframeWrap.append(iframe, mask);

    // Resize handles
    const resizeHandles = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    const resizeEls = resizeHandles.map((dir) => {
      const handle = document.createElement('div');
      handle.className = `pw-resize pw-resize-${dir}`;
      handle.addEventListener('mousedown', (e) => { e.stopPropagation(); this.startResize(id, dir, e); });
      return handle;
    });

    panel.append(header, iframeWrap, ...resizeEls);

    // Drag
    header.addEventListener('mousedown', (e) => this.startDrag(id, e));

    // Focus on click
    panel.addEventListener('mousedown', () => this.bringToFront(id));

    return panel;
  }

  private startDrag(id: string, e: MouseEvent) {
    const state = this.panels.get(id);
    if (!state) return;
    e.preventDefault();

    this.bringToFront(id);
    state.el.classList.add('pw-dragging');

    // Read actual position from DOM to avoid drift
    const rect = state.el.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    const onMove = (ev: MouseEvent) => {
      state.x = ev.clientX - offsetX;
      state.y = ev.clientY - offsetY;
      state.el.style.left = `${state.x}px`;
      state.el.style.top = `${state.y}px`;
    };

    const onUp = () => {
      state.el.classList.remove('pw-dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  private startResize(id: string, dir: string, e: MouseEvent) {
    const state = this.panels.get(id);
    if (!state) return;
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

    const onMove = (ev: MouseEvent) => {
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

    const onUp = () => {
      state.el.classList.remove('pw-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  destroy() {
    window.removeEventListener('message', this.messageHandler);
    this.closeAll();
  }
}
