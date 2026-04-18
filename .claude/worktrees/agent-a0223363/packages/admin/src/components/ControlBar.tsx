import { useState, useRef, useEffect, useMemo } from 'preact/hooks';
import { selectedAppId, applications, navigate, addAppModalOpen } from '../lib/state.js';
import { api } from '../lib/api.js';
import {
  focusOrDockSession,
  spawnTerminal,
  controlBarMinimized,
  toggleControlBarMinimized,
  popoutPanels,
  paneMruHistory,
  bringToFront,
  activePanelId,
  activeTabId,
  allSessions,
  getSessionLabel,
  openSession,
} from '../lib/sessions.js';
import type { PaneMruEntry } from '../lib/sessions.js';

function getSessionMruLabel(sessionId: string, sessionMap: Map<string, any>): string {
  const custom = getSessionLabel(sessionId);
  if (custom) return custom;
  const sess = sessionMap.get(sessionId);
  if (sess?.feedbackTitle) return sess.feedbackTitle;
  if (sess?.agentName) return sess.agentName;
  return `Session ${sessionId.slice(-6)}`;
}

function getPanelMruLabel(panel: { id: string; sessionIds: string[]; activeSessionId: string; label?: string }, sessionMap: Map<string, any>): string {
  if (panel.label) return panel.label;
  const sid = panel.activeSessionId || panel.sessionIds[0];
  if (!sid) return panel.id.slice(-6);
  return getSessionMruLabel(sid, sessionMap);
}

export function ControlBar() {
  const appId = selectedAppId.value;
  const apps = applications.value;
  const app = appId ? apps.find((a: any) => a.id === appId) : null;
  const actions: { id: string; label: string; command: string; icon?: string }[] =
    app?.controlActions || [];
  const minimized = controlBarMinimized.value;

  const [running, setRunning] = useState<string | null>(null);
  const [appDropdown, setAppDropdown] = useState(false);
  const [mruDropdown, setMruDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const mruDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!appDropdown && !mruDropdown) return;
    const handler = (e: MouseEvent) => {
      if (appDropdown && dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setAppDropdown(false);
      }
      if (mruDropdown && mruDropdownRef.current && !mruDropdownRef.current.contains(e.target as Node)) {
        setMruDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [appDropdown, mruDropdown]);

  const panels = popoutPanels.value;
  const mruHistory = paneMruHistory.value;
  const sessions = allSessions.value;
  const sessionMap = useMemo(() => new Map(sessions.map((s: any) => [s.id, s])), [sessions]);
  const panelMap = useMemo(() => new Map(panels.map((p: any) => [p.id, p])), [panels]);

  async function run(actionId: string) {
    if (!appId || running) return;
    setRunning(actionId);
    try {
      const res = await api.runControlAction(appId, actionId);
      if (res.sessionId) {
        focusOrDockSession(res.sessionId);
      }
    } catch (err) {
      console.error('Control action failed:', err);
    }
    setRunning(null);
  }

  function selectApp(id: string) {
    setAppDropdown(false);
    navigate(`/app/${id}/feedback`);
  }

  if (minimized) {
    return (
      <div class="control-bar control-bar-minimized">
        <button
          class="control-bar-btn control-bar-app-btn"
          onClick={toggleControlBarMinimized}
          title="Expand control bar"
        >
          <span class="control-bar-icon">{'\u{1F4BB}'}</span>
          {app?.name || 'Select App'}
          <span class="control-bar-caret">{'\u25B8'}</span>
        </button>
      </div>
    );
  }

  return (
    <div class="control-bar">
      {/* App selector */}
      <div class="control-bar-dropdown" ref={dropdownRef}>
        <button
          class="control-bar-btn control-bar-app-btn"
          onClick={() => setAppDropdown(!appDropdown)}
        >
          <span class="control-bar-icon">{'\u{1F4BB}'}</span>
          {app?.name || 'Select App'}
          <span class="control-bar-caret">{'\u25BE'}</span>
        </button>
        {appDropdown && (
          <div class="control-bar-menu">
            {apps.map((a: any) => (
              <button
                key={a.id}
                class={`control-bar-menu-item ${a.id === appId ? 'active' : ''}`}
                onClick={() => selectApp(a.id)}
              >
                {a.name}
              </button>
            ))}
            <div class="control-bar-menu-divider" />
            <button
              class="control-bar-menu-item"
              onClick={() => { setAppDropdown(false); addAppModalOpen.value = true; }}
            >
              + New App
            </button>
          </div>
        )}
      </div>

      <div class="control-bar-sep" />

      {/* Control actions */}
      {actions.map((a) => (
        <button
          key={a.id}
          class="control-bar-btn"
          onClick={() => run(a.id)}
          disabled={running === a.id}
          title={a.command}
        >
          {a.icon && <span class="control-bar-icon">{a.icon}</span>}
          {running === a.id ? 'Running\u2026' : a.label}
        </button>
      ))}

      {actions.length > 0 && <div class="control-bar-sep" />}

      {/* Utility buttons */}
      <button
        class="control-bar-btn"
        onClick={() => spawnTerminal(appId)}
        title="New terminal"
      >
        <span class="control-bar-icon">{'\u{1F4DF}'}</span>
        Terminal
      </button>

      {/* MRU pane history dropdown */}
      <>
        <div class="control-bar-sep" />
        <div class="control-bar-dropdown" ref={mruDropdownRef}>
          <button
            class="control-bar-btn control-bar-mru-btn control-bar-mru-active"
            onClick={() => setMruDropdown(!mruDropdown)}
          >
            {(() => {
              if (mruHistory.length === 0) return 'History';
              const top = mruHistory[0];
              if (top.type === 'tab') return getSessionMruLabel(top.sessionId, sessionMap);
              const p = panelMap.get(top.panelId);
              return p ? getPanelMruLabel(p, sessionMap) : top.panelId.slice(-6);
            })()}
            <span class="control-bar-caret">{'\u25BE'}</span>
          </button>
          {mruDropdown && (
            <div class="control-bar-menu">
              {mruHistory.length === 0 && (
                <div class="control-bar-menu-item" style="opacity:0.5;cursor:default">No history</div>
              )}
              {mruHistory.map((entry: PaneMruEntry, i: number) => {
                const key = entry.type === 'tab' ? `tab:${entry.sessionId}` : `panel:${entry.panelId}`;
                const isActive = entry.type === 'tab'
                  ? activeTabId.value === entry.sessionId
                  : activePanelId.value === entry.panelId;
                const label = entry.type === 'tab'
                  ? getSessionMruLabel(entry.sessionId, sessionMap)
                  : (() => { const p = panelMap.get(entry.panelId); return p ? getPanelMruLabel(p, sessionMap) : entry.panelId.slice(-6); })();
                return (
                  <button
                    key={key}
                    class={`control-bar-menu-item ${isActive ? 'active' : ''}`}
                    onClick={() => {
                      if (entry.type === 'tab') {
                        openSession(entry.sessionId);
                      } else {
                        const p = panelMap.get(entry.panelId);
                        if (p) {
                          bringToFront(entry.panelId);
                          activePanelId.value = entry.panelId;
                        }
                      }
                      setMruDropdown(false);
                    }}
                  >
                    <span style="opacity:0.5;margin-right:6px">{entry.type === 'tab' ? '\u{1F4CB}' : '\u{1F5D7}'}</span>
                    {label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </>

      <div style="flex:1" />
      <button
        class="control-bar-btn control-bar-minimize-btn"
        onClick={toggleControlBarMinimized}
        title="Minimize control bar"
      >
        {'\u2212'}
      </button>
    </div>
  );
}
