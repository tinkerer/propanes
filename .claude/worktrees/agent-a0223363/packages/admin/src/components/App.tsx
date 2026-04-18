import { useEffect } from 'preact/hooks';
import { ComponentChildren } from 'preact';
import { isAuthenticated, currentRoute, navigate, selectedAppId, applications, loadApplications, isEmbedded, isCompanion } from '../lib/state.js';
import { isolatedComponent, getIsolateEntry, getIsolateParams } from '../lib/isolate.js';
import { Layout } from './Layout.js';
import { GlobalTerminalPanel } from './GlobalTerminalPanel.js';
import { LoginPage } from '../pages/LoginPage.js';
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
import { StandaloneSessionPage } from '../pages/StandaloneSessionPage.js';
import { DispatchDialog } from './DispatchDialog.js';

function parseAppRoute(route: string): { appId: string; sub: string; param?: string } | null {
  const m = route.match(/^\/app\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const [, appId, rest] = m;
  const slashIdx = rest.indexOf('/');
  if (slashIdx === -1) return { appId, sub: rest };
  return { appId, sub: rest.slice(0, slashIdx), param: rest.slice(slashIdx + 1) };
}

function CompanionRoot({ children }: { children: ComponentChildren }) {
  useEffect(() => {
    if (window.parent === window) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey && e.key === 'k') {
        e.preventDefault();
        window.parent.postMessage({ type: 'pw-companion-shortcut', key: 'cmd+k' }, '*');
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'Space') {
        e.preventDefault();
        window.parent.postMessage({ type: 'pw-companion-shortcut', key: 'ctrl+shift+space' }, '*');
      }
      if (e.key === 'Escape') {
        window.parent.postMessage({ type: 'pw-companion-shortcut', key: 'escape' }, '*');
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);
  return <div class="pw-companion-root">{children}</div>;
}

export function App() {
  const embedded = isEmbedded.value;

  if (!isAuthenticated.value) {
    return <LoginPage />;
  }

  useEffect(() => {
    loadApplications();
  }, []);

  // Isolate mode: render a single component with no admin chrome
  const isolateName = isolatedComponent.value;
  if (isolateName) {
    const entry = getIsolateEntry(isolateName);
    if (!entry) {
      return <div class="pw-isolate-root" style="padding:24px">Unknown isolate component: {isolateName}</div>;
    }
    if (entry.render === null) {
      return <div class="pw-isolate-root" />;
    }
    return <div class="pw-isolate-root">{entry.render(getIsolateParams())}</div>;
  }

  const route = currentRoute.value;

  // Redirect root to first app's feedback or settings
  if (route === '/' || route === '') {
    const apps = applications.value;
    if (apps.length > 0) {
      navigate(`/app/${apps[0].id}/feedback`);
      return null;
    } else {
      navigate('/settings/applications');
      return null;
    }
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
      // Legacy per-app agents route — redirect to global agents
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
    // Legacy route — redirect to first app settings
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
  } else if (route === '/settings/infrastructure') {
    page = <InfrastructurePage />;
  } else if (route === '/settings/machines' || route === '/settings/harnesses' || route === '/settings/sprites') {
    navigate('/settings/infrastructure');
    return null;
  } else if (route.startsWith('/session/')) {
    const sessionId = route.replace('/session/', '');
    return <StandaloneSessionPage sessionId={sessionId} />;
  } else if (route.startsWith('/feedback/')) {
    // Legacy route — redirect
    const id = route.replace('/feedback/', '');
    page = <FeedbackDetailPage id={id} appId={null} />;
  } else {
    // Unknown route — redirect to root
    const apps = applications.value;
    if (apps.length > 0) {
      navigate(`/app/${apps[0].id}/feedback`);
    } else {
      navigate('/settings/applications');
    }
    return null;
  }

  if (isCompanion.value) {
    return <CompanionRoot>{page}</CompanionRoot>;
  }

  if (embedded) {
    return (
      <div class="pw-embed-root">
        {page}
        <GlobalTerminalPanel />
        <DispatchDialog />
      </div>
    );
  }

  return (
    <>
      <Layout>{page}</Layout>
      <DispatchDialog />
    </>
  );
}
