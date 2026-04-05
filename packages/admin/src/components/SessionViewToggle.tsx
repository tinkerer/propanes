import { AgentTerminal } from './AgentTerminal.js';
import { StructuredView } from './StructuredView.js';
import type { InputState } from '../lib/sessions.js';

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
  const showTerminal = mode === 'terminal' || mode === 'split';
  const showStructured = mode === 'structured' || mode === 'split';

  return (
    <div class="session-view-toggle" style={{ display: 'flex', flexDirection: 'column', width: '100%', flex: 1, minHeight: 0 }}>
      <div class="view-content" style={{ flex: 1, overflow: 'hidden', display: 'flex', minHeight: 0 }}>
        {mode === 'split' && (
          <div style={{ width: '55%', height: '100%', borderRight: '1px solid #334155', overflow: 'hidden' }}>
            {showStructured && <StructuredView sessionId={sessionId} isActive={isActive} permissionProfile={permissionProfile} />}
          </div>
        )}
        <div style={{
          width: mode === 'split' ? '45%' : '100%',
          height: '100%',
          overflow: 'hidden',
          display: showTerminal ? 'block' : 'none',
        }}>
          <AgentTerminal sessionId={sessionId} isActive={isActive} onExit={onExit} onInputStateChange={onInputStateChange} />
        </div>
        {mode === 'structured' && (
          <div style={{ width: '100%', height: '100%' }}>
            <StructuredView sessionId={sessionId} isActive={isActive} permissionProfile={permissionProfile} />
          </div>
        )}
      </div>
    </div>
  );
}
