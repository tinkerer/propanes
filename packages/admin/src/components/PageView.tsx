import { currentRoute, navigate, selectedAppId, applications } from '../lib/state.js';
import { RequestPanel } from './RequestPanel.js';
import { FeedbackListPage } from '../pages/FeedbackListPage.js';
import { FeedbackDetailPage } from '../pages/FeedbackDetailPage.js';
import { AgentsPage } from '../pages/AgentsPage.js';
import { GettingStartedPage } from '../pages/GettingStartedPage.js';
import { SessionsPage } from '../pages/SessionsPage.js';
import { AggregatePage } from '../pages/AggregatePage.js';
import { LiveConnectionsPage } from '../pages/LiveConnectionsPage.js';
import { SettingsPage } from '../pages/SettingsPage.js';
import { AppSettingsPage } from '../pages/AppSettingsPage.js';
import { InfrastructurePage } from '../pages/InfrastructurePage.js';
import { UserGuidePage } from '../pages/UserGuidePage.js';
import { WiggumPage } from '../pages/WiggumPage.js';

function parseAppRoute(route: string): { appId: string; sub: string; param?: string } | null {
  const m = route.match(/^\/app\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const [, appId, rest] = m;
  const slashIdx = rest.indexOf('/');
  if (slashIdx === -1) return { appId, sub: rest };
  return { appId, sub: rest.slice(0, slashIdx), param: rest.slice(slashIdx + 1) };
}

export function PageView() {
  const route = currentRoute.value;

  if (route === '/' || route === '') {
    const apps = applications.value;
    if (apps.length > 0) {
      navigate(`/app/${apps[0].id}/feedback`);
    } else {
      navigate('/settings/applications');
    }
    return null;
  }

  let page;
  const parsed = parseAppRoute(route);

  if (parsed) {
    selectedAppId.value = parsed.appId;
    if (parsed.sub === 'feedback' && parsed.param) {
      page = <FeedbackDetailPage id={parsed.param} appId={parsed.appId} />;
    } else if (parsed.sub === 'feedback') {
      page = <FeedbackListPage appId={parsed.appId} />;
    } else if (parsed.sub === 'agents') {
      navigate('/settings/agents');
      return null;
    } else if (parsed.sub === 'sessions') {
      page = <SessionsPage appId={parsed.appId} />;
    } else if (parsed.sub === 'aggregate') {
      page = <AggregatePage appId={parsed.appId} />;
    } else if (parsed.sub === 'live') {
      page = <LiveConnectionsPage appId={parsed.appId} />;
    } else if (parsed.sub === 'settings') {
      page = <AppSettingsPage appId={parsed.appId} />;
    } else {
      page = <FeedbackListPage appId={parsed.appId} />;
    }
  } else if (route === '/settings/agents') {
    page = <AgentsPage />;
  } else if (route === '/settings/applications') {
    const apps = applications.value;
    if (apps.length > 0) {
      navigate(`/app/${apps[0].id}/settings`);
    } else {
      navigate('/settings/getting-started');
    }
    return null;
  } else if (route === '/settings/getting-started') {
    page = <GettingStartedPage />;
  } else if (route === '/settings/user-guide') {
    page = <UserGuidePage />;
  } else if (route === '/settings/preferences') {
    page = <SettingsPage />;
  } else if (route === '/settings/wiggum' || route.startsWith('/settings/wiggum/')) {
    page = <WiggumPage />;
  } else if (route === '/settings/infrastructure') {
    page = <InfrastructurePage />;
  } else if (route === '/settings/machines' || route === '/settings/harnesses' || route === '/settings/sprites') {
    navigate('/settings/infrastructure');
    return null;
  } else if (route.startsWith('/feedback/')) {
    const id = route.replace('/feedback/', '');
    page = <FeedbackDetailPage id={id} appId={null} />;
  } else {
    const apps = applications.value;
    if (apps.length > 0) {
      navigate(`/app/${apps[0].id}/feedback`);
    } else {
      navigate('/settings/applications');
    }
    return null;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflow: 'hidden' }}>
      <RequestPanel />
      <div class="main" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {page}
      </div>
    </div>
  );
}
