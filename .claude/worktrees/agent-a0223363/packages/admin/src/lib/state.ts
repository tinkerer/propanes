import { signal, computed } from '@preact/signals';
import { api } from './api.js';
import { timed, bindRouteSignal } from './perf.js';
import { isolatedComponent } from './isolate.js';

// Embed mode detection
const params = new URLSearchParams(window.location.search);
export const isEmbedded = signal(params.get('embed') === 'true');
export const isCompanion = signal(params.get('companion') === 'true');
const embedAppId = params.get('appId');

if (isEmbedded.value) {
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

export const selectedAppId = signal<string | null>(embedAppId);
export const applications = signal<any[]>([]);
export const unlinkedCount = signal(0);
export const appFeedbackCounts = signal<Record<string, number>>({});
export const addAppModalOpen = signal(false);

export async function loadApplications() {
  try {
    const apps = await timed('apps:list', () => api.getApplications());
    applications.value = apps;

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
      const counts: Record<string, number> = {};
      const results = await Promise.all([
        ...apps.map((app: any) => api.getFeedback({ appId: app.id, limit: 1 })),
        api.getFeedback({ appId: '__unlinked__', limit: 1 }),
      ]);
      apps.forEach((app: any, i: number) => {
        counts[app.id] = results[i].total;
      });
      appFeedbackCounts.value = counts;
      unlinkedCount.value = results[results.length - 1].total;
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
  isAuthenticated.value = false;
}

export function navigate(path: string) {
  window.location.hash = path;
  currentRoute.value = path;
}

window.addEventListener('hashchange', () => {
  currentRoute.value = window.location.hash.slice(1) || '/';
});

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
