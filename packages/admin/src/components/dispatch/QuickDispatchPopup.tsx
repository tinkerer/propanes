import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { api } from '../../lib/api.js';
import { META_WIGGUM_TEMPLATE, FAFO_ASSISTANT_TEMPLATE, STRUCTURED_MODE_TEMPLATE, RUNTIME_INFO } from '../../lib/agent-constants.js';
import { formatAgentOption, agentSortCmp } from '../../lib/agent-matrix.js';
import { openSession, loadAllSessions, ensureAgentsLoaded } from '../../lib/sessions.js';
import { UnifiedComposer, type UnifiedComposerData } from '../feedback/UnifiedComposer.js';

export type DispatchType = 'agent' | 'yolo' | 'wiggum' | 'fafo' | 'structured' | 'powwow';

function pickYoloAgent(agents: any[], appId: string): any | undefined {
  // YOLO button prefers interactive-yolo (TTY + skip permissions), falling
  // back to any *-yolo profile if no interactive-yolo endpoint is configured.
  // Either way the user gets an agent that won't pause for permission prompts.
  const usable = agents.filter((a: any) => a.mode !== 'webhook' || !!a.url);
  const ordered = [...usable].sort((a, b) => agentSortCmp(a, b, ['codex', 'claude']));
  for (const profile of ['interactive-yolo', 'headless-yolo', 'headless-stream-yolo'] as const) {
    const match = (a: any) => a.permissionProfile === profile;
    const hit = ordered.find(a => match(a) && a.isDefault && a.appId === appId)
      || ordered.find(a => match(a) && a.isDefault && !a.appId)
      || ordered.find(a => match(a) && a.appId === appId)
      || ordered.find(match);
    if (hit) return hit;
  }
  return undefined;
}

function groupAgentsByRuntime(agents: any[]): Array<[string, any[]]> {
  const sorted = [...agents].sort(agentSortCmp);
  const groups = new Map<string, any[]>();
  for (const a of sorted) {
    const key = a.runtime || 'claude';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(a);
  }
  return Array.from(groups.entries());
}

// Store dispatch settings per app in localStorage
const SETTINGS_KEY = 'pw-qdp-settings';

interface DispatchSettings {
  dispatchType: DispatchType;
  agentId: string;
  posX?: number;
  posY?: number;
}

function loadSettings(appKey: string): DispatchSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw);
    return all[appKey] || null;
  } catch {
    return null;
  }
}

function saveSettings(appKey: string, settings: DispatchSettings) {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const all = raw ? JSON.parse(raw) : {};
    all[appKey] = settings;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(all));
  } catch { /* ignore */ }
}

interface Props {
  appKey: string;
  appName?: string;
  onClose: () => void;
  /** Called after successful submit — use to clear persistent open state */
  onSubmitClose?: () => void;
  initialDispatchType?: DispatchType;
}

function isComposerFloatingChrome(target: EventTarget | null): boolean {
  return !!(
    target instanceof Element
    && target.closest('.interrupt-bar-expand-menu, .cos-tool-menu')
  );
}

function isElementPickerActive(): boolean {
  return document.body.classList.contains('pw-element-picker-active');
}

export function QuickDispatchPopup({ appKey, appName, onClose, onSubmitClose, initialDispatchType }: Props) {
  const settings = loadSettings(appKey);
  const [dispatchType, setDispatchType] = useState<DispatchType>(
    settings?.dispatchType || initialDispatchType || 'agent'
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [agents, setAgents] = useState<any[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(settings?.agentId || '');
  const [pos, setPos] = useState<{ x: number; y: number }>(() => ({
    x: settings?.posX ?? Math.round(window.innerWidth / 2 - 200),
    y: settings?.posY ?? Math.round(window.innerHeight * 0.3),
  }));
  const dragging = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const appId = appKey === '__unlinked__' ? '' : appKey;

  useEffect(() => {
    (async () => {
      try {
        const list = appId
          ? await api.getAgents(appId)
          : await ensureAgentsLoaded();
        setAgents(list);
        if (!selectedAgentId || !list.some((a: any) => a.id === selectedAgentId)) {
          const usable = (list as any[]).filter((a: any) => a.mode !== 'webhook' || !!a.url);
          const appDefault = appId ? usable.find((a: any) => a.isDefault && a.appId === appId) : null;
          const globalDefault = usable.find((a: any) => a.isDefault && !a.appId);
          const def = appDefault || globalDefault || usable[0];
          if (def) setSelectedAgentId(def.id);
        }
      } catch { /* ignore */ }
    })();
  }, [appId]);

  // Save settings when they change
  useEffect(() => {
    saveSettings(appKey, { dispatchType, agentId: selectedAgentId, posX: pos.x, posY: pos.y });
  }, [dispatchType, selectedAgentId, appKey, pos.x, pos.y]);

  // Drag handling
  const onMouseDown = useCallback((e: MouseEvent) => {
    dragging.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    e.preventDefault();
  }, [pos]);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragging.current) return;
      const dx = e.clientX - dragging.current.startX;
      const dy = e.clientY - dragging.current.startY;
      setPos({ x: dragging.current.origX + dx, y: dragging.current.origY + dy });
    }
    function onMouseUp() {
      dragging.current = null;
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // Escape to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Click-away close
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (isElementPickerActive() || isComposerFloatingChrome(e.target)) return;
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onFocusIn(e: FocusEvent) {
      if (isElementPickerActive() || isComposerFloatingChrome(e.target)) return;
      const target = e.target as Node | null;
      if (!target || !panelRef.current) return;
      if (!panelRef.current.contains(target)) onClose();
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [onClose]);

  async function handleSubmit(data: UnifiedComposerData) {
    if (!data.text.trim() || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const fileBlock = data.files.length > 0
        ? `\n\n---\nAttached files (read from these local paths if you are on the server host):\n${data.files.map((f) => `- ${f.path}${f.url ? ` (download: ${f.url})` : ''}`).join('\n')}`
        : '';
      const fb = await api.createFeedback({
        title: data.text.trim().slice(0, 200),
        description: `${data.text.trim()}${fileBlock}`,
        type: 'manual',
        appId,
        tags: dispatchType === 'agent' ? [] : [dispatchType],
      });

      // Upload images (pasted screenshots + captured screenshots)
      if (data.images.length > 0) {
        await Promise.all(
          data.images.map((img) => api.saveImageAsNew(fb.id, img)),
        );
      }

      // If we have element selections, append them to the feedback description
      if (data.elements.length > 0) {
        const elDesc = data.elements.map((el) =>
          `[${el.tagName}${el.id ? `#${el.id}` : ''}${el.classes?.length ? `.${el.classes.join('.')}` : ''}] ${el.textContent?.slice(0, 100) || ''}`,
        ).join('\n');
        await api.updateFeedback(fb.id, {
          customData: JSON.stringify({ selectedElements: data.elements }),
        }).catch(() => {});
      }

      // YOLO mode auto-picks a skip-permissions agent, ignoring the manual selection.
      // Fallbacks skip webhook endpoints with no URL — those can't dispatch.
      const usable = agents.filter((a: any) => a.mode !== 'webhook' || !!a.url);
      const agent = dispatchType === 'yolo'
        ? (pickYoloAgent(agents, appId) || usable.find((a: any) => a.id === selectedAgentId) || usable[0])
        : (agents.find((a: any) => a.id === selectedAgentId) || usable[0]);
      if (!agent) throw new Error('No agent endpoints configured');
      if (dispatchType === 'yolo' && typeof agent.permissionProfile === 'string' && !agent.permissionProfile.endsWith('-yolo')) {
        throw new Error('No skip-permissions (*-yolo) agent configured');
      }

      if (dispatchType === 'powwow') {
        const moderator = agent;
        const participantAgents = agents.filter((a: any) => a.mode !== 'webhook' && a.id !== moderator.id);
        if (participantAgents.length === 0) throw new Error('Powwow needs at least one additional agent');
        const result = await api.powwow({
          feedbackId: fb.id,
          moderatorAgentId: moderator.id,
          participantAgentIds: participantAgents.map((a: any) => a.id),
          instructions: data.text.trim(),
          rounds: 2,
        });
        if (result.sessionId) {
          openSession(result.sessionId);
        }
        loadAllSessions();
        (onSubmitClose || onClose)();
        return;
      }

      let instructions: string | undefined;
      if (dispatchType === 'wiggum') {
        instructions = META_WIGGUM_TEMPLATE;
      } else if (dispatchType === 'fafo') {
        instructions = FAFO_ASSISTANT_TEMPLATE;
      } else if (dispatchType === 'structured') {
        instructions = STRUCTURED_MODE_TEMPLATE;
      }

      const result = await api.dispatch({
        feedbackId: fb.id,
        agentEndpointId: agent.id,
        instructions,
      });

      if (result.sessionId) {
        openSession(result.sessionId);
      }
      loadAllSessions();
      (onSubmitClose || onClose)();
    } catch (err: any) {
      console.error('Quick dispatch failed:', err.message);
      setError(err.message || 'Cook failed');
    }
    setSubmitting(false);
  }

  const headerAppLabel = appName && appName !== 'Unlinked' ? appName : 'Unlinked';

  return createPortal(
    <div
      ref={panelRef}
      class="qdp-panel"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div class="qdp-header" onMouseDown={onMouseDown}>
        <span class="qdp-title">
          <span class="qdp-title-kicker">New Session</span>
          <span class="qdp-title-sep">{'·'}</span>
          <span class="qdp-title-app">{headerAppLabel}</span>
        </span>
        <button class="qdp-close" onClick={onClose}>{'\u2715'}</button>
      </div>
      <div class="qdp-composer-wrap">
        <UnifiedComposer
          onSubmit={handleSubmit}
          placeholder="What should we cook up?"
          submitTitle={dispatchType === 'yolo' ? 'YOLO Cook' : 'Cook It'}
          submitIcon="send"
          disabled={submitting}
          draftKey={`qdp-${appKey}`}
          className="qdp-unified-composer"
          error={error || null}
          rows={3}
          autoFocus
          draftStorage="local"
          uploadMeta={{ appId }}
        />
      </div>
      <div class="qdp-footer">
        <div class="qdp-selects">
          <select
            class="qdp-dispatch-select"
            value={dispatchType}
            onChange={(e) => setDispatchType((e.target as HTMLSelectElement).value as DispatchType)}
          >
            <option value="agent">{'\u{1F525}'} Cook It</option>
            <option value="yolo">{'\u{26A1}'} YOLO</option>
            <option value="wiggum">{'\u{1F575}'} Wiggum</option>
            <option value="fafo">{'\u{1F9EC}'} FAFO</option>
            <option value="structured">{'\u{1F4CB}'} Structured</option>
            <option value="powwow">{'\u{1FAD6}'} Powwow</option>
          </select>
          {agents.length > 1 && (
            <select
              class="qdp-agent-select"
              value={selectedAgentId}
              onChange={(e) => setSelectedAgentId((e.target as HTMLSelectElement).value)}
              disabled={dispatchType === 'yolo'}
              title={dispatchType === 'yolo' ? 'YOLO auto-picks a yolo-profile agent' : 'Pick agent (runtime + permission profile)'}
            >
              {groupAgentsByRuntime(agents).map(([runtime, group]) => (
                <optgroup key={runtime} label={`${(RUNTIME_INFO[runtime] || RUNTIME_INFO.claude).label}`}>
                  {group.map((a: any) => (
                    <option key={a.id} value={a.id}>
                      {formatAgentOption(a)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
