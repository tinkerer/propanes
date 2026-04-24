import { useEffect } from 'preact/hooks';
import { ComponentChildren } from 'preact';
import { isAuthenticated, currentRoute, loadApplications, isEmbedded, isCompanion, isWorkbench, isCosEmbed, clearToken } from '../lib/state.js';
import { setChiefOfStaffOpen } from '../lib/chief-of-staff.js';
import { connectAdminWs } from '../lib/admin-ws.js';
import { initNotifications } from '../lib/notifications.js';
import { isolatedComponent, getIsolateEntry, getIsolateParams } from '../lib/isolate.js';
import { Layout } from './Layout.js';
import { GlobalTerminalPanel } from './GlobalTerminalPanel.js';
import { LoginPage } from '../pages/LoginPage.js';
import { StandaloneSessionPage } from '../pages/StandaloneSessionPage.js';
import { StandalonePanelPage, parsePanelRoute } from '../pages/StandalonePanelPage.js';
import { StandaloneFeedbackPage } from '../pages/StandaloneFeedbackPage.js';
import { DispatchDialog } from './DispatchDialog.js';
import { SetupAssistantDialog } from './SetupAssistantDialog.js';
import { PageView } from './PageView.js';
import { ChiefOfStaffBubble } from './ChiefOfStaffBubble.js';

function CosEmbedRoot() {
  // Force the Ops chat open and load apps so dispatch / app context resolves.
  useEffect(() => {
    loadApplications();
    initNotifications();
    connectAdminWs();
    setChiefOfStaffOpen(true);
  }, []);
  return (
    <div class="pw-cos-embed-root">
      <ChiefOfStaffBubble floatingButton={false} mode="pane" />
    </div>
  );
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
  const route = currentRoute.value;

  useEffect(() => {
    document.title = 'ProPanes Admin';
  }, []);

  if (route === '/logout') {
    clearToken();
    window.location.hash = '/';
    return <LoginPage />;
  }

  // Isolate mode: render a single component with no admin chrome and no auth.
  // This is a standalone surface used for embedded snippets, the widget host
  // page, and visual-regression fixtures.
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

  if (!isAuthenticated.value) {
    return <LoginPage />;
  }

  useEffect(() => {
    loadApplications();
    initNotifications();
    connectAdminWs();
  }, []);

  // Standalone session page — no layout chrome. Decode the id so companion
  // prefixes like `jsonl:` / `feedback:` survive the encodeURIComponent in
  // openSessionExternally (location.hash keeps percent-encoding intact).
  if (route.startsWith('/session/')) {
    const sessionId = decodeURIComponent(route.replace('/session/', ''));
    return <StandaloneSessionPage sessionId={sessionId} />;
  }

  // Standalone feedback page — shareable link from the widget. Shows just the
  // feedback detail without the admin layout/sidebar.
  if (route.startsWith('/fb/')) {
    const feedbackId = decodeURIComponent(route.replace('/fb/', ''));
    return <StandaloneFeedbackPage feedbackId={feedbackId} />;
  }

  // Standalone multi-tab panel page — opened when dragging a pane's hamburger
  // out of the window. Encodes all tabs + active tab + optional split in URL.
  if (route.startsWith('/panel/')) {
    const params = parsePanelRoute(route);
    if (!params) return <div style="padding:24px">Invalid panel URL</div>;
    return <StandalonePanelPage params={params} />;
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
        <SetupAssistantDialog />
        <ChiefOfStaffBubble floatingButton={false} />
      </>
    );
  }

  // CoS-only embed: just the Ops chat in pane mode, filling the iframe.
  if (isCosEmbed.value) {
    return <CosEmbedRoot />;
  }

  if (embedded) {
    return (
      <div class="pw-embed-root">
        <PageView />
        <GlobalTerminalPanel />
        <DispatchDialog />
        <SetupAssistantDialog />
        <ChiefOfStaffBubble />
      </div>
    );
  }

  return (
    <>
      <Layout />
      <DispatchDialog />
      <SetupAssistantDialog />
      <ChiefOfStaffBubble floatingButton={false} />
    </>
  );
}
