import { SessionViewToggle } from './SessionViewToggle.js';
import { ChiefOfStaffBubble } from './ChiefOfStaffBubble.js';
import { JsonlView } from './JsonlView.js';
import { FeedbackCompanionView } from './FeedbackCompanionView.js';
import { IframeCompanion } from './IframeCompanion.js';
import { getIsolateEntry } from '../lib/isolate.js';
import { TerminalCompanionView } from './TerminalCompanionView.js';
import { FileCompanionView } from './FileCompanionView.js';
import { ArtifactCompanionView } from './ArtifactCompanionView.js';
import { WiggumRunsPanel } from './WiggumRunsPanel.js';
import { SessionsListView } from './SessionsListView.js';
import { TerminalsListView } from './TerminalsListView.js';
import { FilesView } from './FilesView.js';
import { SidebarNavView } from './SidebarNavView.js';
import { SidebarFilesDrawer } from './SidebarFilesDrawer.js';
import { GitChangesView } from './GitChangesView.js';
import { PageView } from './PageView.js';
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
import {
  getTerminalCompanion,
  getViewMode,
  setSessionInputState,
  markSessionExited,
} from '../lib/sessions.js';
import { applications, selectedAppId } from '../lib/state.js';

export function renderTabContent(
  sid: string,
  isVisible: boolean,
  sessionMap: Map<string, any>,
  onExit?: (exitCode: number, terminalText: string) => void,
) {
  // View tabs (sidebar sections rendered as pane content)
  const isView = sid.startsWith('view:');
  if (isView) {
    return (
      <div key={sid} style={{ display: isVisible ? 'flex' : 'none', width: '100%', flex: 1, minHeight: 0, overflow: 'auto' }}>
        {sid === 'view:page' ? (
          <PageView />
        ) : sid === 'view:feedback' ? (
          (() => {
            const aid = selectedAppId.value || applications.value[0]?.id;
            if (!aid) return <div style={{ padding: 16, color: 'var(--pw-text-muted)' }}>No apps configured</div>;
            return <FeedbackListPage appId={aid} />;
          })()
        ) : sid === 'view:sessions-page' ? (
          <SessionsPage appId={selectedAppId.value} />
        ) : sid === 'view:live' ? (
          <LiveConnectionsPage appId={selectedAppId.value} />
        ) : sid === 'view:wiggum' ? (
          <WiggumPage />
        ) : sid === 'view:app-settings' ? (
          (() => { const aid = selectedAppId.value || applications.value[0]?.id; return aid ? <AppSettingsPage appId={aid} /> : <div style={{ padding: 16, color: 'var(--pw-text-muted)' }}>No apps configured</div>; })()
        ) : sid === 'view:sessions-list' ? (
          <SessionsListView />
        ) : sid === 'view:terminals' ? (
          <TerminalsListView />
        ) : sid === 'view:files' ? (
          <FilesView />
        ) : sid === 'view:nav' ? (
          <SidebarNavView />
        ) : sid.startsWith('view:files:') ? (
          <SidebarFilesDrawer appId={sid.slice('view:files:'.length) || null} open={true} onToggle={() => {}} />
        ) : sid.startsWith('view:git:') ? (
          (() => {
            const gitAppId = sid.slice('view:git:'.length);
            const app = applications.value.find(a => a.id === gitAppId);
            return <GitChangesView appId={gitAppId} projectDir={app?.projectDir || ''} />;
          })()
        ) : (
          <div class="companion-error">Unknown view: {sid}</div>
        )}
      </div>
    );
  }

  // Feedback item tabs (fb:<feedbackId>)
  if (sid.startsWith('fb:')) {
    const feedbackId = sid.slice(3);
    const aid = selectedAppId.value || applications.value[0]?.id || null;
    return (
      <div key={sid} style={{ display: isVisible ? 'flex' : 'none', width: '100%', flex: 1, minHeight: 0, overflow: 'auto' }}>
        <FeedbackDetailPage id={feedbackId} appId={aid} embedded />
      </div>
    );
  }

  // Chief of Staff pane tab (cos:<agentId or 'main'>)
  if (sid.startsWith('cos:')) {
    return (
      <div key={sid} style={{ display: isVisible ? 'flex' : 'none', width: '100%', flex: 1, minHeight: 0 }}>
        <ChiefOfStaffBubble mode="pane" floatingButton={false} />
      </div>
    );
  }

  // Settings tabs (settings:<key>)
  if (sid.startsWith('settings:')) {
    const key = sid.slice(9);
    return (
      <div key={sid} style={{ display: isVisible ? 'flex' : 'none', width: '100%', flex: 1, minHeight: 0, overflow: 'auto' }}>
        {key === 'agents' ? <AgentsPage />
          : key === 'infrastructure' ? <InfrastructurePage />
          : key === 'wiggum' ? <WiggumPage />
          : key === 'user-guide' ? <UserGuidePage />
          : key === 'getting-started' ? <GettingStartedPage />
          : key === 'preferences' ? <SettingsPage />
          : <div class="companion-error">Unknown settings page: {key}</div>}
      </div>
    );
  }

  const isJsonl = sid.startsWith('jsonl:');
  const isFeedback = sid.startsWith('feedback:');
  const isIframe = sid.startsWith('iframe:');
  const isTerminal = sid.startsWith('terminal:');
  const isIsolate = sid.startsWith('isolate:');
  const isUrl = sid.startsWith('url:');
  const isFile = sid.startsWith('file:');
  const isWiggumRuns = sid.startsWith('wiggum-runs:');
  const isArtifact = sid.startsWith('artifact:');
  const isCompanion = isJsonl || isFeedback || isIframe || isTerminal || isIsolate || isUrl || isFile || isWiggumRuns || isArtifact;
  const realSid = isCompanion ? sid.slice(sid.indexOf(':') + 1) : sid;
  const sess = (isIsolate || isUrl || isFile || isWiggumRuns || isArtifact) ? null : sessionMap.get(realSid);

  const handleExit = onExit ?? ((code: number, text: string) => markSessionExited(sid, code, text));

  return (
    <div key={sid} style={{ display: isVisible ? 'flex' : 'none', width: '100%', flex: 1, minHeight: 0 }}>
      {isWiggumRuns ? (
        <WiggumRunsPanel sessionId={realSid} />
      ) : isArtifact ? (
        <ArtifactCompanionView artifactId={realSid} />
      ) : isFile ? (
        <FileCompanionView filePath={realSid} />
      ) : isUrl ? (
        <IframeCompanion url={realSid} />
      ) : isIsolate ? (
        (() => {
          const entry = getIsolateEntry(realSid);
          const label = entry?.label || realSid;
          const src = `${window.location.origin}${window.location.pathname}?isolate=${encodeURIComponent(realSid)}`;
          return <IframeCompanion url={src} label={label} />;
        })()
      ) : isJsonl ? (
        <JsonlView sessionId={realSid} />
      ) : isFeedback ? (
        sess?.feedbackId ? <FeedbackCompanionView feedbackId={sess.feedbackId} /> : <div class="companion-error">No feedback linked</div>
      ) : isIframe ? (
        sess?.url ? <IframeCompanion url={sess.url} /> : <div class="companion-error">No URL available</div>
      ) : isTerminal ? (
        (() => {
          const termSid = getTerminalCompanion(realSid);
          return termSid === '__loading__'
            ? <div class="companion-loading">Starting terminal...</div>
            : termSid ? <TerminalCompanionView companionSessionId={termSid} /> : <div class="companion-error">No companion terminal</div>;
        })()
      ) : (
        <SessionViewToggle
          sessionId={sid}
          isActive={isVisible}
          onExit={handleExit}
          onInputStateChange={(s) => setSessionInputState(sid, s)}
          permissionProfile={sessionMap.get(sid)?.permissionProfile}
          mode={getViewMode(sid)}
        />
      )}
    </div>
  );
}
