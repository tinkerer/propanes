import { SessionViewToggle } from './SessionViewToggle.js';
import { JsonlView } from './JsonlView.js';
import { FeedbackCompanionView } from './FeedbackCompanionView.js';
import { IframeCompanionView } from './IframeCompanionView.js';
import { IsolateCompanionView } from './IsolateCompanionView.js';
import { TerminalCompanionView } from './TerminalCompanionView.js';
import { FileCompanionView } from './FileCompanionView.js';
import {
  getTerminalCompanion,
  getViewMode,
  setSessionInputState,
  markSessionExited,
} from '../lib/sessions.js';

export function renderTabContent(
  sid: string,
  isVisible: boolean,
  sessionMap: Map<string, any>,
  onExit?: (exitCode: number, terminalText: string) => void,
) {
  const isJsonl = sid.startsWith('jsonl:');
  const isFeedback = sid.startsWith('feedback:');
  const isIframe = sid.startsWith('iframe:');
  const isTerminal = sid.startsWith('terminal:');
  const isIsolate = sid.startsWith('isolate:');
  const isUrl = sid.startsWith('url:');
  const isFile = sid.startsWith('file:');
  const isCompanion = isJsonl || isFeedback || isIframe || isTerminal || isIsolate || isUrl || isFile;
  const realSid = isCompanion ? sid.slice(sid.indexOf(':') + 1) : sid;
  const sess = (isIsolate || isUrl || isFile) ? null : sessionMap.get(realSid);

  const handleExit = onExit ?? ((code: number, text: string) => markSessionExited(sid, code, text));

  return (
    <div key={sid} style={{ display: isVisible ? 'flex' : 'none', width: '100%', flex: 1, minHeight: 0 }}>
      {isFile ? (
        <FileCompanionView filePath={realSid} />
      ) : isUrl ? (
        <IframeCompanionView url={realSid} />
      ) : isIsolate ? (
        <IsolateCompanionView componentName={realSid} />
      ) : isJsonl ? (
        <JsonlView sessionId={realSid} />
      ) : isFeedback ? (
        sess?.feedbackId ? <FeedbackCompanionView feedbackId={sess.feedbackId} /> : <div class="companion-error">No feedback linked</div>
      ) : isIframe ? (
        sess?.url ? <IframeCompanionView url={sess.url} /> : <div class="companion-error">No URL available</div>
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
