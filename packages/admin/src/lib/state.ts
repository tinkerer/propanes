import { signal, computed, effect } from '@preact/signals';
import { api } from './api.js';
import { timed, bindRouteSignal } from './perf.js';
import { isolatedComponent } from './isolate.js';
import { openPageView, openSettingsPanel } from './companion-state.js';
import { initEmbedGestures } from './embed-gestures.js';

// Embed mode detection
const params = new URLSearchParams(window.location.search);
export const isWorkbench = signal(params.get('embed') === 'workbench');
export const isCosEmbed = signal(params.get('embed') === 'cos');
export const isEmbedded = signal(params.get('embed') === 'true' || isWorkbench.value || isCosEmbed.value);
export const isCompanion = signal(params.get('companion') === 'true');
const embedAppId = params.get('appId');

if (isWorkbench.value) {
  document.body.classList.add('pw-workbench');
  // Two-finger pan + pinch-zoom relay so iOS Safari can move/zoom the popout
  initEmbedGestures();
} else if (isCosEmbed.value) {
  document.body.classList.add('pw-embed', 'pw-cos-embed');
} else if (isEmbedded.value) {
  document.body.classList.add('pw-embed');
}
if (isCompanion.value) {
  document.body.classList.add('pw-companion');
}
if (isolatedComponent.value) {
  document.body.classList.add('pw-isolate');
}

export const isAuthenticated = signal(!!localStorage.getItem('pw-admin-token'));
export const currentRoute = signal(window.location.hash.slice(1) || '/');
bindRouteSignal(currentRoute);

function extractAppIdFromRoute(route: string): string | null {
  const m = route.match(/^\/app\/([^/]+)\//);
  return m ? m[1] : null;
}

const initialAppId = embedAppId
  || extractAppIdFromRoute(window.location.hash.slice(1) || '/')
  || localStorage.getItem('pw-selected-app-id');
export const selectedAppId = signal<string | null>(initialAppId);
export const applications = signal<any[]>([]);
export const unlinkedCount = signal(0);
export const appFeedbackCounts = signal<Record<string, { total: number; new: number; running: number }>>({});
export const addAppModalOpen = signal(false);
export const spotlightOpen = signal(false);

export function openSpotlight() { spotlightOpen.value = true; }
export function closeSpotlight() { spotlightOpen.value = false; }
export function toggleSpotlight() { spotlightOpen.value = !spotlightOpen.value; }

effect(() => {
  const id = selectedAppId.value;
  if (id) localStorage.setItem('pw-selected-app-id', id);
  else localStorage.removeItem('pw-selected-app-id');
});

export async function loadApplications() {
  try {
    const apps = await timed('apps:list', () => api.getApplications());
    applications.value = apps;

    // Auto-select first app if none selected
    if (!selectedAppId.value && apps.length > 0) {
      selectedAppId.value = apps[0].id;
    }

    // Defer feedback counts so visible page content loads first
    requestAnimationFrame(() => {
      loadFeedbackCounts(apps);
    });
  } catch {
    // ignore on auth failure etc
  }
}

async function loadFeedbackCounts(apps: any[]) {
  try {
    await timed('apps:feedbackCounts', async () => {
      const counts: Record<string, { total: number; new: number; running: number }> = {};
      const results = await Promise.all([
        ...apps.map((app: any) => api.getFeedback({ appId: app.id, limit: 1 })),
        ...apps.map((app: any) => api.getFeedback({ appId: app.id, status: 'new', limit: 1 })),
        ...apps.map((app: any) => api.getFeedback({ appId: app.id, dispatchStatus: 'running', limit: 1 })),
        api.getFeedback({ appId: '__unlinked__', limit: 1 }),
      ]);
      const n = apps.length;
      apps.forEach((app: any, i: number) => {
        counts[app.id] = {
          total: results[i].total,
          new: results[n + i].total,
          running: results[2 * n + i].total,
        };
      });
      appFeedbackCounts.value = counts;
      unlinkedCount.value = results[3 * n].total;
    });
  } catch {
    // ignore
  }
}

export function setToken(token: string) {
  localStorage.setItem('pw-admin-token', token);
  isAuthenticated.value = true;
}

export function clearToken() {
  localStorage.removeItem('pw-admin-token');
  localStorage.removeItem('pw-selected-app-id');
  isAuthenticated.value = false;
}

function routeToViewId(route: string): string | null {
  if (route.startsWith('/settings/')) {
    return null;
  }
  const m = route.match(/^\/app\/[^/]+\/([^/]+)/);
  if (!m) return null;
  const map: Record<string, string> = {
    feedback: 'view:feedback',
    sessions: 'view:sessions-page',
    live: 'view:live',
    settings: 'view:app-settings',
  };
  return map[m[1]] || null;
}

export function navigate(path: string) {
  window.location.hash = path;
  currentRoute.value = path;
  const appId = extractAppIdFromRoute(path);
  if (appId) selectedAppId.value = appId;
  const viewId = routeToViewId(path);
  if (viewId) openPageView(viewId);
}

window.addEventListener('hashchange', () => {
  const route = window.location.hash.slice(1) || '/';
  currentRoute.value = route;
  const appId = extractAppIdFromRoute(route);
  if (appId) selectedAppId.value = appId;
  const viewId = routeToViewId(route);
  if (viewId) openPageView(viewId);
});

window.addEventListener('pw-navigate-view', ((e: CustomEvent) => {
  if (e.detail?.viewId) openPageView(e.detail.viewId);
}) as EventListener);

// Embed postMessage bridge
if (isEmbedded.value) {
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'pw-embed-init') {
      if (e.data.token) {
        setToken(e.data.token);
      }
      if (e.data.appId) {
        selectedAppId.value = e.data.appId;
      }
    } else if (e.data?.type === 'pw-embed-navigate') {
      if (e.data.route) {
        navigate(e.data.route);
      }
    }
  });

  // Notify parent when route changes
  const origNavigate = navigate;
  const notifyParent = () => {
    window.parent.postMessage({
      type: 'pw-embed-title',
      route: currentRoute.value,
      title: document.title,
    }, '*');
  };
  window.addEventListener('hashchange', notifyParent);
}
