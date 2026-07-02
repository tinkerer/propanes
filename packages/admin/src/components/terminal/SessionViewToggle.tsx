import { AgentTerminal } from './AgentTerminal.js';
import { StructuredView } from './StructuredView.js';
import { InterruptBar } from './InterruptBar.js';
import type { InputState } from '../../lib/sessions.js';
import { allSessions } from '../../lib/sessions.js';
import { isMobile } from '../../lib/viewport.js';
import { useCallback, useRef, useState } from 'preact/hooks';

export type ViewMode = 'terminal' | 'structured' | 'split';

const SPLIT_RATIO_KEY = 'pw-session-view-split-ratio';
const DEFAULT_SPLIT_RATIO = 0.55;

function clampSplitRatio(ratio: number) {
  return Math.max(0.2, Math.min(0.8, ratio));
}

function readSplitRatio() {
  try {
    const raw = localStorage.getItem(SPLIT_RATIO_KEY);
    const parsed = raw ? Number(JSON.parse(raw)) : DEFAULT_SPLIT_RATIO;
    return Number.isFinite(parsed) ? clampSplitRatio(parsed) : DEFAULT_SPLIT_RATIO;
  } catch {
    return DEFAULT_SPLIT_RATIO;
  }
}

interface Props {
  sessionId: string;
  isActive?: boolean;
  onExit?: (exitCode: number, terminalText: string) => void;
  onInputStateChange?: (state: InputState) => void;
  onLoginRequired?: (companionSessionId: string) => void;
  permissionProfile?: string;
  mode: ViewMode;
}

export function SessionViewToggle({ sessionId, isActive, onExit, onInputStateChange, onLoginRequired, permissionProfile, mode }: Props) {
  const [splitRatio, setSplitRatio] = useState(readSplitRatio);
  const [dragging, setDragging] = useState(false);
  const splitDragging = useRef(false);
  const sessionRecord = allSessions.value.find((s: any) => s.id === sessionId);
  const hasStructuredTranscript = !!sessionRecord?.jsonlPath;
  // Mobile: prefer structured when a transcript exists, but do not force an
  // empty JSONL view for live sessions that only have PTY output so far.
  const effectiveMode: ViewMode = isMobile.value
    ? (hasStructuredTranscript ? (mode === 'terminal' ? 'terminal' : 'structured') : 'terminal')
    : mode;
  const showTerminal = effectiveMode === 'terminal' || effectiveMode === 'split';
  const showStructured = effectiveMode === 'structured' || effectiveMode === 'split';

  const onSplitDividerMouseDown = useCallback((e: MouseEvent) => {
    e.preventDefault();
    const container = (e.currentTarget as HTMLElement).closest('.view-content') as HTMLElement | null;
    if (!container) return;
    splitDragging.current = true;
    setDragging(true);
    const containerRect = container.getBoundingClientRect();
    const updateRatio = (clientX: number) => {
      const next = clampSplitRatio((clientX - containerRect.left) / containerRect.width);
      setSplitRatio(next);
      localStorage.setItem(SPLIT_RATIO_KEY, JSON.stringify(next));
    };
    const onMove = (ev: MouseEvent) => {
      if (!splitDragging.current) return;
      updateRatio(ev.clientX);
    };
    const onUp = () => {
      splitDragging.current = false;
      setDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  return (
    <div class="session-view-toggle">
      <div class={`view-content${dragging ? ' resizing-session-split' : ''}`}>
        {effectiveMode === 'split' && (
          <div class="session-view-pane session-view-pane-structured" style={{ flex: splitRatio }}>
            {showStructured && <StructuredView sessionId={sessionId} />}
          </div>
        )}
        {effectiveMode === 'split' && (
          <div
            class="session-view-split-divider"
            onMouseDown={onSplitDividerMouseDown}
            title="Drag to resize structured view and terminal"
          />
        )}
        {showTerminal && (
          <div class="session-view-pane session-view-pane-terminal" style={{ flex: effectiveMode === 'split' ? 1 - splitRatio : 1 }}>
            <AgentTerminal
              sessionId={sessionId}
              isActive={isActive}
              onExit={onExit}
              onInputStateChange={onInputStateChange}
              onLoginRequired={onLoginRequired}
            />
          </div>
        )}
        {effectiveMode === 'structured' && (
          <div class="session-view-pane session-view-pane-full">
            <StructuredView sessionId={sessionId} />
          </div>
        )}
      </div>
      <InterruptBar sessionId={sessionId} permissionProfile={permissionProfile} />
    </div>
  );
}
