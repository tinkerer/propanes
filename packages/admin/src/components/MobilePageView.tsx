import { currentRoute, selectedAppId, applications } from '../lib/state.js';
import { FeedbackListPage } from '../pages/FeedbackListPage.js';
import { FeedbackDetailPage } from '../pages/FeedbackDetailPage.js';
import { SessionsPage } from '../pages/SessionsPage.js';
import { LiveConnectionsPage } from '../pages/LiveConnectionsPage.js';
import { AppSettingsPage } from '../pages/AppSettingsPage.js';
import { AgentsPage } from '../pages/AgentsPage.js';
import { InfrastructurePage } from '../pages/InfrastructurePage.js';
import { UserGuidePage } from '../pages/UserGuidePage.js';
import { GettingStartedPage } from '../pages/GettingStartedPage.js';
import { SettingsPage } from '../pages/SettingsPage.js';
import { WiggumPage } from '../pages/WiggumPage.js';
import { StandaloneSessionPage } from '../pages/StandaloneSessionPage.js';

function NoApp() {
  return (
    <div style={{ padding: 24, color: 'var(--pw-text-muted)', textAlign: 'center' }}>
      No apps configured. Open Settings to add one.
    </div>
  );
}

function renderMobileRoute(route: string) {
  const appMatch = route.match(/^\/app\/([^/]+)(?:\/(.+))?$/);
  if (appMatch) {
    const appId = appMatch[1];
    const rest = appMatch[2] || 'feedback';

    if (rest === 'feedback') return <FeedbackListPage appId={appId} />;
    const fbDetail = rest.match(/^feedback\/(.+)$/);
    if (fbDetail) return <FeedbackDetailPage id={fbDetail[1]} appId={appId} />;
    if (rest === 'sessions') return <SessionsPage appId={appId} />;
    if (rest === 'live') return <LiveConnectionsPage appId={appId} />;
    if (rest === 'settings' || rest.startsWith('settings/')) return <AppSettingsPage appId={appId} />;
    if (rest === 'wiggum') return <WiggumPage />;
    return <FeedbackListPage appId={appId} />;
  }

  if (route.startsWith('/session/')) {
    const sid = route.replace('/session/', '');
    return <StandaloneSessionPage sessionId={sid} />;
  }

  if (route.startsWith('/settings/agents')) return <AgentsPage />;
  if (route.startsWith('/settings/infrastructure')) return <InfrastructurePage />;
  if (route.startsWith('/settings/user-guide')) return <UserGuidePage />;
  if (route.startsWith('/settings/getting-started')) return <GettingStartedPage />;
  if (route.startsWith('/settings/preferences')) return <SettingsPage />;
  if (route.startsWith('/settings')) return <GettingStartedPage />;

  const aid = selectedAppId.value || applications.value[0]?.id;
  if (!aid) return <NoApp />;
  return <FeedbackListPage appId={aid} />;
}

export function MobilePageView() {
  const route = currentRoute.value;
  return (
    <div class="mobile-page-view">
      {renderMobileRoute(route)}
    </div>
  );
}
