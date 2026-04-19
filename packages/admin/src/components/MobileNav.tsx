import { currentRoute, navigate, selectedAppId } from '../lib/state.js';

type TabKey = 'feedback' | 'sessions' | 'live' | 'settings';

function pathFor(tab: TabKey, appId: string | null): string {
  if (!appId) {
    if (tab === 'settings') return '/settings/applications';
    return '/settings/getting-started';
  }
  return `/app/${appId}/${tab}`;
}

function activeTab(route: string): TabKey | null {
  const m = route.match(/^\/app\/[^/]+\/(feedback|sessions|live|settings)(\/|$)/);
  if (m) return m[1] as TabKey;
  if (route.startsWith('/settings')) return 'settings';
  if (route.startsWith('/sessions')) return 'sessions';
  if (route.startsWith('/live')) return 'live';
  return null;
}

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'feedback', label: 'Feedback', icon: '\u{1F4DD}' },
  { key: 'sessions', label: 'Sessions', icon: '\u{1F4E1}' },
  { key: 'live', label: 'Live', icon: '\u{1F7E2}' },
  { key: 'settings', label: 'Settings', icon: '\u{2699}\u{FE0F}' },
];

export function MobileNav() {
  const route = currentRoute.value;
  const appId = selectedAppId.value;
  const active = activeTab(route);

  return (
    <nav class="mobile-nav" role="navigation" aria-label="Primary">
      {TABS.map((t) => (
        <button
          key={t.key}
          class={`mobile-nav-btn${active === t.key ? ' active' : ''}`}
          onClick={() => navigate(pathFor(t.key, appId))}
          aria-current={active === t.key ? 'page' : undefined}
        >
          <span class="mobile-nav-icon" aria-hidden="true">{t.icon}</span>
          <span class="mobile-nav-label">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
