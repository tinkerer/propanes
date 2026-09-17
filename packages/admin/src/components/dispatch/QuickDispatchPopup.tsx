import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { api } from '../../lib/api.js';
import { META_WIGGUM_TEMPLATE, FAFO_ASSISTANT_TEMPLATE, STRUCTURED_MODE_TEMPLATE, RUNTIME_INFO } from '../../lib/agent-constants.js';
import { formatAgentOption, agentSortCmp, isDispatchableAgent, pickYoloAgent } from '../../lib/agent-matrix.js';
import { openSession, loadAllSessions, ensureAgentsLoaded } from '../../lib/sessions.js';
import { UnifiedComposer, type UnifiedComposerData } from '../feedback/UnifiedComposer.js';
import {
  QDP_PANEL_W as PANEL_W,
  QDP_PANEL_H as PANEL_H,
  type PanelSize,
  resizeFromBottomLeft,
  clampPanelSize,
} from '../../lib/qdp-resize.js';

export type DispatchType = 'agent' | 'yolo' | 'wiggum' | 'fafo' | 'structured' | 'powwow';

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

// Store dispatch settings per app in localStorage. A `__lastUsed__` bucket
// mirrors the most recent dispatch type + agent across all apps so the
// composer stays sticky even on the first open of a never-seen app key (or
// the global "+"), matching the widget's single global agent memory.
const SETTINGS_KEY = 'pw-qdp-settings';
const LAST_USED_KEY = '__lastUsed__';

interface DispatchSettings {
  dispatchType: DispatchType;
  agentId: string;
  posX?: number;
  posY?: number;
  width?: number;
  height?: number;
}

function loadSettings(appKey: string): DispatchSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw);
    // Prefer per-app settings (incl. position); otherwise inherit the last
    // dispatch type + agent used anywhere so the choice feels sticky. The
    // panel size is a global preference, so it fills in from the shared
    // bucket whenever the per-app entry predates resizing.
    const perApp = all[appKey];
    const last = all[LAST_USED_KEY];
    if (!perApp) return last || null;
    if (perApp.width == null && last?.width != null) {
      return { ...perApp, width: last.width, height: last.height };
    }
    return perApp;
  } catch {
    return null;
  }
}

function saveSettings(appKey: string, settings: DispatchSettings) {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const all = raw ? JSON.parse(raw) : {};
    all[appKey] = settings;
    // Position is per-app/anchor-driven, so the global bucket only carries the
    // dispatch type + agent selection (and the panel size, which is a user
    // preference rather than an app-specific one).
    const prev = all[LAST_USED_KEY] || {};
    all[LAST_USED_KEY] = {
      dispatchType: settings.dispatchType,
      agentId: settings.agentId,
      width: settings.width ?? prev.width,
      height: settings.height ?? prev.height,
    };
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
  /** Screen coords of the triggering [+] button, to anchor the popup near it. */
  anchor?: { x: number; y: number } | null;
  /** Pre-fill the composer text (e.g. "review PR 757"). */
  initialText?: string;
  /** Default the agent dropdown to this runtime (yolo profiles first). */
  preferRuntime?: string;
  /**
   * One-off popup (e.g. Review PR): ignore per-app saved settings/drafts and
   * don't persist this popup's choices back into them.
   */
  transient?: boolean;
}

// Keep a point within the viewport so the popup can't open off-screen.
function clampToViewport(x: number, y: number, w = PANEL_W, h = PANEL_H): { x: number; y: number } {
  const maxX = Math.max(8, window.innerWidth - w - 8);
  const maxY = Math.max(8, window.innerHeight - h - 8);
  return { x: Math.min(Math.max(8, x), maxX), y: Math.min(Math.max(8, y), maxY) };
}

function loadSize(settings: DispatchSettings | null): PanelSize | null {
  if (!settings) return null;
  return clampPanelSize(settings.width, settings.height, window.innerWidth);
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

export function QuickDispatchPopup({ appKey, appName, onClose, onSubmitClose, initialDispatchType, anchor, initialText, preferRuntime, transient }: Props) {
  const settings = transient ? null : loadSettings(appKey);
  const [dispatchType, setDispatchType] = useState<DispatchType>(
    (transient && initialDispatchType) || settings?.dispatchType || initialDispatchType || 'agent'
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [agents, setAgents] = useState<any[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(settings?.agentId || '');
  // null = default CSS width + natural (content-driven) height. Set once the
  // user drags the corner handle; persisted alongside the position.
  const [size, setSize] = useState<PanelSize | null>(() => loadSize(settings));
  const [isResizing, setIsResizing] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    const w = size?.w ?? PANEL_W;
    const h = size?.h ?? PANEL_H;
    // Anchor next to the [+] that opened us. The button position is the user's
    // point of focus, so the composer appears right where they clicked instead
    // of stranded at screen-center or a stale dragged-off-screen position.
    if (anchor) return clampToViewport(anchor.x, anchor.y, w, h);
    if (settings?.posX != null && settings?.posY != null) {
      return clampToViewport(settings.posX, settings.posY, w, h);
    }
    return clampToViewport(Math.round(window.innerWidth / 2 - w / 2), Math.round(window.innerHeight * 0.3), w, h);
  });
  const dragging = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizing = useRef<{ startX: number; startY: number; origX: number; origW: number; origH: number } | null>(null);
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
          const usable = (list as any[]).filter(isDispatchableAgent);
          // Runtime preference (e.g. Review PR defaults to the opposite runtime
          // of the reviewed session): pick a yolo agent of that runtime first.
          const preferred = preferRuntime
            ? pickYoloAgent(usable.filter((a: any) => (a.runtime || 'claude') === preferRuntime), appId)
              || usable.filter((a: any) => (a.runtime || 'claude') === preferRuntime).sort(agentSortCmp)[0]
            : null;
          const appDefault = appId ? usable.find((a: any) => a.isDefault && a.appId === appId) : null;
          const globalDefault = usable.find((a: any) => a.isDefault && !a.appId);
          const def = preferred || appDefault || globalDefault || usable[0];
          if (def) setSelectedAgentId(def.id);
        }
      } catch { /* ignore */ }
    })();
  }, [appId]);

  // Save settings when they change (transient popups don't clobber the
  // user's per-app defaults)
  useEffect(() => {
    if (transient) return;
    saveSettings(appKey, {
      dispatchType,
      agentId: selectedAgentId,
      posX: pos.x,
      posY: pos.y,
      width: size?.w,
      height: size?.h,
    });
  }, [dispatchType, selectedAgentId, appKey, pos.x, pos.y, size?.w, size?.h, transient]);

  // Drag handling
  const onMouseDown = useCallback((e: MouseEvent) => {
    dragging.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    e.preventDefault();
  }, [pos]);

  // Resize handling (bottom-left corner handle, like the widget's panel).
  // The handle sits inside the panel so the click-away listener ignores it.
  const onResizeMouseDown = useCallback((e: MouseEvent) => {
    const panel = panelRef.current;
    if (!panel) return;
    resizing.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: pos.x,
      origW: panel.offsetWidth,
      origH: panel.offsetHeight,
    };
    setIsResizing(true);
    e.preventDefault();
    e.stopPropagation();
  }, [pos.x]);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (resizing.current) {
        const r = resizing.current;
        const next = resizeFromBottomLeft(
          { x: r.origX, w: r.origW, h: r.origH },
          e.clientX - r.startX,
          e.clientY - r.startY,
          window.innerWidth,
        );
        setSize({ w: next.w, h: next.h });
        setPos((p) => ({ x: next.x, y: p.y }));
        return;
      }
      if (!dragging.current) return;
      const dx = e.clientX - dragging.current.startX;
      const dy = e.clientY - dragging.current.startY;
      setPos({ x: dragging.current.origX + dx, y: dragging.current.origY + dy });
    }
    function onMouseUp() {
      dragging.current = null;
      if (resizing.current) {
        resizing.current = null;
        setIsResizing(false);
      }
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

      // YOLO Auto picks a skip-permissions agent; an explicit dropdown choice
      // uses that endpoint and overrides it to interactive-yolo at dispatch.
      const usable = agents.filter(isDispatchableAgent);
      const selectedAgent = usable.find((a: any) => a.id === selectedAgentId);
      const agent = dispatchType === 'yolo'
        ? (selectedAgent || pickYoloAgent(agents, appId) || usable[0])
        : (selectedAgent || usable[0]);
      if (!agent) throw new Error('No agent endpoints configured');
      const explicitYoloAgent = dispatchType === 'yolo' && !!selectedAgent;
      if (dispatchType === 'yolo' && !explicitYoloAgent && typeof agent.permissionProfile === 'string' && !agent.permissionProfile.endsWith('-yolo')) {
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
        permissionProfile: dispatchType === 'yolo' && explicitYoloAgent ? 'interactive-yolo' : undefined,
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
      class={`qdp-panel${size ? ' is-sized' : ''}${isResizing ? ' is-resizing' : ''}`}
      style={size
        ? { left: pos.x, top: pos.y, width: size.w, height: size.h }
        : { left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        class="qdp-resize-handle"
        title="Drag to resize"
        onMouseDown={onResizeMouseDown}
      />
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
          initialText={initialText}
          draftKey={transient ? undefined : `qdp-${appKey}`}
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
              title={dispatchType === 'yolo' ? 'Pick a specific endpoint, or Auto for Claude-first YOLO' : 'Pick agent (runtime + permission profile)'}
            >
              {dispatchType === 'yolo' && <option value="">Auto</option>}
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
