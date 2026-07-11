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
export const currentUser = signal<any | null>(null);
export const isAdminUser = computed(() => currentUser.value?.role === 'admin');
// api.ts dispatches `pw-admin-401` on any 401 response. Flip the signal here
// so the App shell re-renders LoginPage immediately (no manual refresh).
window.addEventListener('pw-admin-401', () => {
  isAuthenticated.value = false;
  currentUser.value = null;
  localStorage.removeItem('pw-selected-app-id');
});
export const currentRoute = signal(window.location.hash.slice(1) || '/');
bindRouteSignal(currentRoute);

function extractAppIdFromRoute(route: string): string | null {
  const m = route.match(/^\/app\/([^/]+)\//);
  return m ? m[1] : null;
}

function extractChannelSlugFromRoute(route: string): string | null {
  const m = route.match(/^\/app\/[^/]+\/c\/([^/]+)/);
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

// Channels (CoS workspace-scoped thread buckets). Loaded per-workspace; the
// active channel is resolved either from the URL slug (#/app/X/c/SLUG) or
// from the operator's last selection persisted in localStorage.
export type ChannelKind = 'prod' | 'staging' | 'exploratory';
export type ChannelRow = {
  id: string;
  appId: string;
  slug: string;
  name: string;
  description: string;
  kind: ChannelKind;
  policy: {
    classification: ChannelKind;
    allowedProfiles: string[];
    allowedAgentIds: string[] | null;
    requireApproval: boolean;
    pathGuards: string[];
    powwow: { enabled: boolean; providers: string[] };
    retention?: { archiveAfterDays?: number };
  };
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  threadCount: number;
  openCount: number;
};

const initialChannelSlug = extractChannelSlugFromRoute(window.location.hash.slice(1) || '/');

export const channelsByApp = signal<Record<string, ChannelRow[]>>({});
export const unsortedCountByApp = signal<Record<string, { threadCount: number; openCount: number }>>({});
export const activeChannelSlug = signal<string | null>(initialChannelSlug);
export const channelOrgProposalOpen = signal(false);

// Pending approvals per workspace. Populated by loadApprovals(appId), polled
// by ApprovalQueuePage every 15s while visible. Used for the sidebar badge.
export const pendingApprovalCountByApp = signal<Record<string, number>>({});
let approvalsEndpointMissing = false;

export const activeChannel = computed(() => {
  const appId = selectedAppId.value;
  const slug = activeChannelSlug.value;
  if (!appId || !slug) return null;
  return (channelsByApp.value[appId] || []).find((c) => c.slug === slug) ?? null;
});

export async function loadChannels(appId: string): Promise<void> {
  try {
    const res = await api.getChannels(appId);
    channelsByApp.value = { ...channelsByApp.value, [appId]: res.channels };
    unsortedCountByApp.value = { ...unsortedCountByApp.value, [appId]: res.unsorted };
  } catch {
    // ignore — caller can retry
  }
}

export async function loadApprovals(appId: string): Promise<typeof api.getApprovals extends (...args: any[]) => Promise<infer R> ? R : never> {
  if (approvalsEndpointMissing) return { approvals: [] } as any;
  try {
    const res = await api.getApprovals(appId, 'pending');
    pendingApprovalCountByApp.value = { ...pendingApprovalCountByApp.value, [appId]: res.approvals.length };
    return res as any;
  } catch (err) {
    if (err instanceof Error && err.message === 'HTTP 404') approvalsEndpointMissing = true;
    return { approvals: [] } as any;
  }
}

// CoS workspace constant — spans all apps, default when none registered.
export const COS_WORKSPACE_ID = '__cos__';

// Whenever the selected workspace changes, refresh its channel list.
effect(() => {
  const id = selectedAppId.value;
  if (id && id !== COS_WORKSPACE_ID) loadChannels(id);
});

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

    // The widget passes its public apiKey (pw_…) as the appId when it opens
    // an embedded admin overlay (Settings, Feedback, etc.). Translate that
    // to the real app id once we've loaded applications, so AppSettingsPage
    // and friends can find the matching row instead of rendering blank.
    const cur = selectedAppId.value;
    if (cur && cur.startsWith('pw_')) {
      const match = apps.find((a: any) => a.apiKey === cur);
      if (match) selectedAppId.value = match.id;
    }

    // Auto-select first app if none selected, or CoS workspace if no apps exist
    if (!selectedAppId.value) {
      selectedAppId.value = apps.length > 0 ? apps[0].id : COS_WORKSPACE_ID;
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

export async function loadCurrentUser() {
  if (!localStorage.getItem('pw-admin-token')) {
    currentUser.value = null;
    return null;
  }
  const res = await api.me();
  currentUser.value = res.user;
  return res.user;
}

export function setToken(token: string, user?: any) {
  localStorage.setItem('pw-admin-token', token);
  if (user) currentUser.value = user;
  isAuthenticated.value = true;
}

export function clearToken() {
  localStorage.removeItem('pw-admin-token');
  localStorage.removeItem('pw-selected-app-id');
  currentUser.value = null;
  isAuthenticated.value = false;
}

function routeToViewId(route: string): string | null {
  if (route.startsWith('/settings/')) {
    return null;
  }
  // Channel routes — `/app/:appId/c/:slug[/...]` open the Channels pane.
  if (/^\/app\/[^/]+\/c\//.test(route)) {
    return 'view:channel';
  }
  const m = route.match(/^\/app\/[^/]+\/([^/]+)/);
  if (!m) return null;
  const map: Record<string, string> = {
    tickets: 'view:feedback',
    feedback: 'view:feedback',
    sessions: 'view:sessions-page',
    live: 'view:live',
    flatter: 'view:flatter',
    approvals: 'view:approvals',
    settings: 'view:app-settings',
    spec: 'view:spec',
  };
  return map[m[1]] || null;
}

// Settings pages render as pane tabs (settings:<key>), not through PageView —
// and PageView is itself a lazy tab that may not be mounted. Route side
// effects must therefore fire here, or deep links (e.g. the widget's ⚙
// agent-settings link opening #/settings/agents in a new browser tab) are
// silently swallowed whenever another pane tab is active.
const SETTINGS_PANEL_KEYS = new Set([
  'users', 'usage', 'agents', 'infrastructure', 'wiggum',
  'user-guide', 'getting-started', 'preferences',
]);

function openPanelsForRoute(route: string) {
  const viewId = routeToViewId(route);
  if (viewId) {
    openPageView(viewId);
    return;
  }
  // `/agents` is the legacy pre-settings route; deployed widget builds still
  // link to it.
  const key = route === '/agents' ? 'agents' : route.match(/^\/settings\/([^/]+)/)?.[1];
  if (key && SETTINGS_PANEL_KEYS.has(key)) openSettingsPanel(key);
}

export function navigate(path: string) {
  window.location.hash = path;
  currentRoute.value = path;
  const appId = extractAppIdFromRoute(path);
  if (appId) selectedAppId.value = appId;
  activeChannelSlug.value = extractChannelSlugFromRoute(path);
  openPanelsForRoute(path);
}

window.addEventListener('hashchange', () => {
  const route = window.location.hash.slice(1) || '/';
  currentRoute.value = route;
  const appId = extractAppIdFromRoute(route);
  if (appId) selectedAppId.value = appId;
  activeChannelSlug.value = extractChannelSlugFromRoute(route);
  openPanelsForRoute(route);
});

// Honor deep links on first load even when the persisted pane tree's active
// tab is a different page view.
queueMicrotask(() => {
  openPanelsForRoute(currentRoute.value);
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
