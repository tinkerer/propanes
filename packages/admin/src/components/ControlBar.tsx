import { useState, useRef, useMemo } from 'preact/hooks';
import { selectedAppId, applications, navigate, addAppModalOpen } from '../lib/state.js';
import { api } from '../lib/api.js';
import {
  focusOrDockSession,
  spawnTerminal,
  popoutPanels,
  paneMruHistory,
  bringToFront,
  activePanelId,
  activeTabId,
  sessionMapComputed,
  getSessionLabel,
  openSession,
  openPageView,
} from '../lib/sessions.js';
import type { PaneMruEntry } from '../lib/sessions.js';
import { PopupMenu } from './PopupMenu.js';
import { unreadNotificationCount, openNotificationCenter } from '../lib/notifications.js';

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

  const [running, setRunning] = useState<string | null>(null);
  const [appDropdown, setAppDropdown] = useState(false);
  const [mruDropdown, setMruDropdown] = useState(false);
  const appBtnRef = useRef<HTMLButtonElement>(null);
  const mruBtnRef = useRef<HTMLButtonElement>(null);

  const panels = popoutPanels.value;
  const mruHistory = paneMruHistory.value;
  const sessionMap = sessionMapComputed.value;
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

  function openSetup() {
    if (appId) {
      navigate(`/app/${appId}/settings`);
      openPageView('view:app-settings');
    }
  }

  return (
    <div class="control-bar">
      {/* App selector */}
      <button
        ref={appBtnRef}
        class="control-bar-btn control-bar-app-btn"
        onClick={() => setAppDropdown(!appDropdown)}
      >
        <span class="control-bar-icon">{'\u{1F4BB}'}</span>
        {app?.name || 'Select App'}
        <span class="control-bar-caret">{'\u25BE'}</span>
      </button>
      {appDropdown && (
        <PopupMenu anchorRef={appBtnRef} onClose={() => setAppDropdown(false)}>
          {apps.map((a: any) => (
            <button
              key={a.id}
              class={`popup-menu-item ${a.id === appId ? 'active' : ''}`}
              onClick={() => selectApp(a.id)}
            >
              {a.name}
            </button>
          ))}
          <div class="popup-menu-divider" />
          <button
            class="popup-menu-item"
            onClick={() => { setAppDropdown(false); addAppModalOpen.value = true; }}
          >
            + New App
          </button>
        </PopupMenu>
      )}

      <div class="control-bar-sep" />

      {/* Control actions or setup assistant */}
      {actions.length > 0 ? (
        <div class="control-bar-actions">
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
        </div>
      ) : app ? (
        <button
          class="control-bar-btn control-bar-setup-btn"
          onClick={openSetup}
          title="Configure control bar actions for this app"
        >
          <span class="control-bar-icon">{'\u2699'}</span>
          Setup Controls
        </button>
      ) : null}

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
      <div class="control-bar-sep" />
      <button
        ref={mruBtnRef}
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
        <PopupMenu anchorRef={mruBtnRef} onClose={() => setMruDropdown(false)}>
          {mruHistory.length === 0 && (
            <div class="popup-menu-item" style="opacity:0.5;cursor:default">No history</div>
          )}
          {mruHistory.map((entry: PaneMruEntry) => {
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
                class={`popup-menu-item ${isActive ? 'active' : ''}`}
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
        </PopupMenu>
      )}

      <div style="flex:1" />

      <button
        class="control-bar-btn control-bar-notif-btn"
        onClick={openNotificationCenter}
        title="Notifications"
      >
        <span class="control-bar-icon">{'\u{1F514}'}</span>
        {unreadNotificationCount.value > 0 && (
          <span class="control-bar-notif-badge">{unreadNotificationCount.value}</span>
        )}
      </button>
    </div>
  );
}
