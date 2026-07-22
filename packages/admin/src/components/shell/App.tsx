import { useEffect } from 'preact/hooks';
import { ComponentChildren } from 'preact';
import { isAuthenticated, currentRoute, loadApplications, loadCurrentUser, isEmbedded, isCompanion, isWorkbench, isCosEmbed, clearToken } from '../../lib/state.js';
import { setChiefOfStaffOpen } from '../../lib/chief-of-staff.js';
import { connectAdminWs } from '../../lib/admin-ws.js';
import { initNotifications } from '../../lib/notifications.js';
import { isolatedComponent, getIsolateEntry, getIsolateParams } from '../../lib/isolate.js';
import { Layout } from './Layout.js';
import { GlobalTerminalPanel } from '../panes/GlobalTerminalPanel.js';
import { LoginPage } from '../../pages/LoginPage.js';
import { StandaloneSessionPage } from '../../pages/StandaloneSessionPage.js';
import { StandalonePanelPage, parsePanelRoute } from '../../pages/StandalonePanelPage.js';
import { StandaloneFeedbackPage } from '../../pages/StandaloneFeedbackPage.js';
import { DispatchDialog } from '../dispatch/DispatchDialog.js';
import { SetupAssistantDialog } from '../dispatch/SetupAssistantDialog.js';
import { PageView } from './PageView.js';
import { ChiefOfStaffBubble } from '../cos/ChiefOfStaffBubble.js';

const isTauri = !!(window as any).__TAURI__ || !!(window as any).__TAURI_INTERNALS__;

function tauriInvoke(cmd: string) {
  const w = window as any;
  // Tauri v2: core.invoke or fallback to internals
  w.__TAURI__?.core?.invoke?.(cmd) ?? w.__TAURI_INTERNALS__?.invoke?.(cmd);
}

function tauriStartDrag() {
  const w = window as any;
  w.__TAURI__?.window?.getCurrentWindow?.()?.startDragging?.()
    ?? w.__TAURI_INTERNALS__?.invoke?.('plugin:window|start_dragging');
}

function CosEmbedRoot() {
  // Force the Ops chat open and load apps so dispatch / app context resolves.
  useEffect(() => {
    loadCurrentUser().catch(() => {});
    loadApplications();
    initNotifications();
    connectAdminWs();
    setChiefOfStaffOpen(true);
  }, []);
  return (
    <div class="pw-cos-embed-root">
      {isTauri && (
        <div
          class="tauri-drag-bar"
          data-tauri-drag-region
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).tagName === 'BUTTON') return;
            tauriStartDrag();
          }}
        >
          <span class="tauri-drag-bar-label">ProPanes</span>
          <button
            class="tauri-drag-bar-close"
            onClick={() => tauriInvoke('toggle_cos_panel')}
            title="Hide panel"
          >&times;</button>
        </div>
      )}
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
    // Host-first so environment (azstaging vs localhost vs prod) survives tab truncation.
    document.title = `${window.location.host} — ProPanes Admin`;
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
    // Re-hydrate the logged-in user from the stored token on every mount.
    // isAuthenticated is seeded synchronously from token presence, but
    // currentUser was only set during an explicit login — so after a page
    // reload currentUser stayed null and isAdminUser evaluated false, hiding
    // the entire admin Settings section (Users/Agents/Usage/Infra/Wiggum).
    loadCurrentUser()
      .then((u) => {
        // Keep the URL on the operator's own workspace path (/<username>) on
        // reload/bookmark. Skip when embedded (widget/workbench popout).
        if (u?.username && !isEmbedded.value) {
          const seg = window.location.pathname.split('/').filter(Boolean)[0] || '';
          if (seg !== u.username) {
            window.history.replaceState(null, '', '/' + encodeURIComponent(u.username) + window.location.hash);
          }
        }
      })
      .catch(() => {});
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
