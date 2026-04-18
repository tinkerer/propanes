import { useEffect } from 'preact/hooks';
import { ComponentChildren } from 'preact';
import { isAuthenticated, currentRoute, loadApplications, isEmbedded, isCompanion, isWorkbench, clearToken } from '../lib/state.js';
import { connectAdminWs } from '../lib/admin-ws.js';
import { initNotifications } from '../lib/notifications.js';
import { isolatedComponent, getIsolateEntry, getIsolateParams } from '../lib/isolate.js';
import { Layout } from './Layout.js';
import { GlobalTerminalPanel } from './GlobalTerminalPanel.js';
import { LoginPage } from '../pages/LoginPage.js';
import { StandaloneSessionPage } from '../pages/StandaloneSessionPage.js';
import { DispatchDialog } from './DispatchDialog.js';
import { PageView } from './PageView.js';

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
  const route = currentRoute.value;

  if (route === '/logout') {
    clearToken();
    window.location.hash = '/';
    return <LoginPage />;
  }

  if (!isAuthenticated.value) {
    return <LoginPage />;
  }

  useEffect(() => {
    loadApplications();
    initNotifications();
    connectAdminWs();
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

  // Standalone session page — no layout chrome
  if (route.startsWith('/session/')) {
    const sessionId = route.replace('/session/', '');
    return <StandaloneSessionPage sessionId={sessionId} />;
  }

  if (isCompanion.value) {
    return <CompanionRoot><PageView /></CompanionRoot>;
  }

  // Workbench mode: full pane-tree layout in iframe
  if (isWorkbench.value) {
    return (
      <>
        <Layout />
        <DispatchDialog />
      </>
    );
  }

  if (embedded) {
    return (
      <div class="pw-embed-root">
        <PageView />
        <GlobalTerminalPanel />
        <DispatchDialog />
      </div>
    );
  }

  return (
    <>
      <Layout />
      <DispatchDialog />
    </>
  );
}
