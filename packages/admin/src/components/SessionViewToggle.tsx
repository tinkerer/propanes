import { AgentTerminal } from './AgentTerminal.js';
import { StructuredView } from './StructuredView.js';
import { InterruptBar } from './InterruptBar.js';
import type { InputState } from '../lib/sessions.js';
import { isMobile } from '../lib/viewport.js';

export type ViewMode = 'terminal' | 'structured' | 'split';

interface Props {
  sessionId: string;
  isActive?: boolean;
  onExit?: (exitCode: number, terminalText: string) => void;
  onInputStateChange?: (state: InputState) => void;
  permissionProfile?: string;
  mode: ViewMode;
}

export function SessionViewToggle({ sessionId, isActive, onExit, onInputStateChange, permissionProfile, mode }: Props) {
  // Mobile: force structured view — xterm + split are not usable on a phone.
  const effectiveMode: ViewMode = isMobile.value ? 'structured' : mode;
  const showTerminal = effectiveMode === 'terminal' || effectiveMode === 'split';
  const showStructured = effectiveMode === 'structured' || effectiveMode === 'split';

  return (
    <div class="session-view-toggle" style={{ display: 'flex', flexDirection: 'column', width: '100%', flex: 1, minHeight: 0 }}>
      <div class="view-content" style={{ flex: 1, overflow: 'hidden', display: 'flex', minHeight: 0 }}>
        {effectiveMode === 'split' && (
          <div style={{ width: '55%', height: '100%', borderRight: '1px solid #334155', overflow: 'hidden' }}>
            {showStructured && <StructuredView sessionId={sessionId} isActive={isActive} permissionProfile={permissionProfile} />}
          </div>
        )}
        {showTerminal && (
          <div style={{
            width: effectiveMode === 'split' ? '45%' : '100%',
            height: '100%',
            overflow: 'hidden',
          }}>
            <AgentTerminal sessionId={sessionId} isActive={isActive} onExit={onExit} onInputStateChange={onInputStateChange} />
          </div>
        )}
        {effectiveMode === 'structured' && (
          <div style={{ width: '100%', height: '100%' }}>
            <StructuredView sessionId={sessionId} isActive={isActive} permissionProfile={permissionProfile} />
          </div>
        )}
      </div>
      <InterruptBar sessionId={sessionId} permissionProfile={permissionProfile} />
    </div>
  );
}
