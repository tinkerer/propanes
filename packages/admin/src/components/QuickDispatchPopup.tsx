import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { api } from '../lib/api.js';
import { META_WIGGUM_TEMPLATE, FAFO_ASSISTANT_TEMPLATE, STRUCTURED_MODE_TEMPLATE } from '../lib/agent-constants.js';
import { openSession, loadAllSessions, ensureAgentsLoaded } from '../lib/sessions.js';

export type DispatchType = 'agent' | 'yolo' | 'wiggum' | 'fafo' | 'structured' | 'powwow';

function pickYoloAgent(agents: any[], appId: string): any | undefined {
  // Usable = not a misconfigured webhook. Prefer codex runtime over claude.
  const usable = agents.filter((a: any) => a.mode !== 'webhook' || !!a.url);
  const ordered = [...usable].sort((a, b) => {
    const order = (r: string) => (r === 'codex' ? 0 : r === 'claude' ? 1 : 2);
    return order(a.runtime || 'claude') - order(b.runtime || 'claude');
  });
  const match = (a: any) => a.permissionProfile === 'yolo';
  return ordered.find(a => match(a) && a.isDefault && a.appId === appId)
    || ordered.find(a => match(a) && a.isDefault && !a.appId)
    || ordered.find(a => match(a) && a.appId === appId)
    || ordered.find(match);
}

const DRAFT_KEY = 'pw-qdp-drafts';

interface Draft {
  text: string;
  dispatchType: DispatchType;
  agentId: string;
}

function loadDrafts(): Record<string, Draft> {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveDraft(appKey: string, draft: Draft) {
  const all = loadDrafts();
  if (!draft.text.trim()) {
    delete all[appKey];
  } else {
    all[appKey] = draft;
  }
  localStorage.setItem(DRAFT_KEY, JSON.stringify(all));
}

function clearDraft(appKey: string) {
  const all = loadDrafts();
  delete all[appKey];
  localStorage.setItem(DRAFT_KEY, JSON.stringify(all));
}

interface Props {
  appKey: string;
  appName?: string;
  onClose: () => void;
}

export function QuickDispatchPopup({ appKey, appName, onClose }: Props) {
  const draft = loadDrafts()[appKey];
  const [text, setText] = useState(draft?.text || '');
  const [dispatchType, setDispatchType] = useState<DispatchType>(draft?.dispatchType || 'agent');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [agents, setAgents] = useState<any[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(draft?.agentId || '');
  const [pos, setPos] = useState<{ x: number; y: number }>(() => ({
    x: Math.round(window.innerWidth / 2 - 200),
    y: Math.round(window.innerHeight * 0.3),
  }));
  const dragging = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const appId = appKey === '__unlinked__' ? '' : appKey;

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const list = appId
          ? await api.getAgents(appId)
          : await ensureAgentsLoaded();
        setAgents(list);
        // Only pick default if we don't have a saved agent
        if (!selectedAgentId || !list.some((a: any) => a.id === selectedAgentId)) {
          // Skip webhook endpoints with no URL — they'd fail dispatch immediately.
          const usable = (list as any[]).filter((a: any) => a.mode !== 'webhook' || !!a.url);
          const appDefault = appId ? usable.find((a: any) => a.isDefault && a.appId === appId) : null;
          const globalDefault = usable.find((a: any) => a.isDefault && !a.appId);
          const def = appDefault || globalDefault || usable[0];
          if (def) setSelectedAgentId(def.id);
        }
      } catch { /* ignore */ }
    })();
  }, [appId]);

  // Persist draft on every change
  useEffect(() => {
    saveDraft(appKey, { text, dispatchType, agentId: selectedAgentId });
  }, [text, dispatchType, selectedAgentId, appKey]);

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

  // Escape to close (hides, draft preserved)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Close on click outside (blur)
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [onClose]);

  function handleClear() {
    setText('');
    setDispatchType('agent');
    clearDraft(appKey);
    textareaRef.current?.focus();
  }

  async function submit() {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const fb = await api.createFeedback({
        title: text.trim().slice(0, 200),
        description: text.trim(),
        type: 'manual',
        appId,
        tags: dispatchType === 'agent' ? [] : [dispatchType],
      });

      // YOLO mode auto-picks a yolo-profile agent, ignoring the manual selection.
      const agent = dispatchType === 'yolo'
        ? (pickYoloAgent(agents, appId) || agents.find((a: any) => a.id === selectedAgentId) || agents[0])
        : (agents.find((a: any) => a.id === selectedAgentId) || agents[0]);
      if (!agent) throw new Error('No agent endpoints configured');
      if (dispatchType === 'yolo' && agent.permissionProfile !== 'yolo') {
        throw new Error('No YOLO agent configured (need an agent with permissionProfile: yolo)');
      }

      if (dispatchType === 'powwow') {
        const moderator = agent;
        const participantAgents = agents.filter((a: any) => a.mode !== 'webhook' && a.id !== moderator.id);
        if (participantAgents.length === 0) throw new Error('Powwow needs at least one additional agent');
        const result = await api.powwow({
          feedbackId: fb.id,
          moderatorAgentId: moderator.id,
          participantAgentIds: participantAgents.map((a: any) => a.id),
          instructions: text.trim(),
          rounds: 2,
        });
        if (result.sessionId) {
          openSession(result.sessionId);
        }
        loadAllSessions();
        setText('');
        setDispatchType('agent');
        clearDraft(appKey);
        onClose();
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
      // Clear draft on successful submit
      setText('');
      setDispatchType('agent');
      clearDraft(appKey);
      onClose();
    } catch (err: any) {
      console.error('Quick dispatch failed:', err.message);
      setError(err.message || 'Cook failed');
    }
    setSubmitting(false);
  }

  const headerLabel = appName && appName !== 'Unlinked'
    ? `Cook Something — ${appName}`
    : 'Cook Something';

  return createPortal(
    <div
      ref={panelRef}
      class="qdp-panel"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div class="qdp-header" onMouseDown={onMouseDown}>
        <span class="qdp-title">{headerLabel}</span>
        <button class="qdp-close" onClick={onClose}>{'\u2715'}</button>
      </div>
      <textarea
        ref={textareaRef}
        class="qdp-textarea"
        placeholder="What should we cook up?"
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        rows={3}
      />
      <div class="qdp-footer">
        <div class="qdp-types">
          {(['agent', 'yolo', 'wiggum', 'fafo', 'structured', 'powwow'] as const).map((t) => (
            <button
              key={t}
              class={`qdp-type-btn ${dispatchType === t ? 'active' : ''}`}
              onClick={() => setDispatchType(t)}
            >
              {t === 'agent'
                ? '\u{1F525} Cook It'
                : t === 'yolo'
                  ? '\u{26A1} YOLO'
                  : t === 'wiggum'
                    ? '\u{1F575} Wiggum'
                    : t === 'fafo'
                      ? '\u{1F9EC} FAFO'
                      : t === 'structured'
                        ? '\u{1F4CB} Structured'
                        : '\u{1FAD6} Powwow'}
            </button>
          ))}
        </div>
        <div class="qdp-actions">
          {agents.length > 1 && (
            <select
              class="qdp-agent-select"
              value={selectedAgentId}
              onChange={(e) => setSelectedAgentId((e.target as HTMLSelectElement).value)}
            >
              {agents.map((a: any) => (
                <option key={a.id} value={a.id}>
                  {a.name}{a.isDefault ? ' *' : ''}
                </option>
              ))}
            </select>
          )}
          {text.trim() && (
            <button class="qdp-clear" onClick={handleClear} title="Clear draft">Clear</button>
          )}
          <button
            class="qdp-submit"
            disabled={!text.trim() || submitting}
            onClick={submit}
          >
            {submitting
              ? 'Cooking…'
              : dispatchType === 'yolo'
                ? '\u{26A1} YOLO Cook'
                : '\u{1F525} Cook It'}
          </button>
        </div>
        {error && (
          <div class="qdp-error">{error}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
