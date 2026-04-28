import {
  killSession,
  resumeSession,
  closeTab,
  resolveSession,
  popBackIn,
  getSessionLabel,
  setSessionLabel,
  getSessionColor,
  setSessionColor,
  SESSION_COLOR_PRESETS,
  exitedSessions,
  allSessions,
} from '../lib/sessions.js';
import { showHotkeyHints } from '../lib/settings.js';
import {
  popoutStatusMenuOpen,
  popoutHotkeyMenuOpen,
  popoutIdMenuOpen,
  popoutWindowMenuOpen,
  renamingSessionId,
  renameValue,
} from './popout-signals.js';

// Floating status-dot context menu (Kill / Resolve / Rename / Close / colour swatches)
export function PopoutStatusMenu() {
  const statusMenu = popoutStatusMenuOpen.value;
  const sessions = allSessions.value;
  const exited = exitedSessions.value;
  if (!statusMenu) return null;
  const menuSid = statusMenu.sessionId;
  const menuSess = sessions.find((s: any) => s.id === menuSid);
  const menuExited = exited.has(menuSid);
  return (
    <div
      class="status-dot-menu"
      style={{ left: `${statusMenu.x}px`, top: `${statusMenu.y}px`, zIndex: 1100 }}
      onClick={(e) => e.stopPropagation()}
    >
      {!menuExited && (
        <button onClick={() => { popoutStatusMenuOpen.value = null; killSession(menuSid); }}>
          Kill {showHotkeyHints.value && <kbd>{'\u2303\u21E7'}K</kbd>}
        </button>
      )}
      {menuSess?.feedbackId && (
        <button onClick={() => { popoutStatusMenuOpen.value = null; resolveSession(menuSid, menuSess.feedbackId); }}>
          Resolve {showHotkeyHints.value && <kbd>{'\u2303\u21E7'}R</kbd>}
        </button>
      )}
      {!menuExited && (
        <button onClick={() => { popoutStatusMenuOpen.value = null; popBackIn(menuSid); }}>
          Pop back in
        </button>
      )}
      {menuExited && (
        <button onClick={() => { popoutStatusMenuOpen.value = null; resumeSession(menuSid); }}>Resume</button>
      )}
      <button onClick={() => {
        popoutStatusMenuOpen.value = null;
        renameValue.value = getSessionLabel(menuSid) || '';
        renamingSessionId.value = menuSid;
      }}>
        Rename
      </button>
      {getSessionLabel(menuSid) && (
        <button onClick={() => { popoutStatusMenuOpen.value = null; setSessionLabel(menuSid, ''); }}>
          Clear name
        </button>
      )}
      <button onClick={() => { closeTab(menuSid); popoutStatusMenuOpen.value = null; }}>
        Close tab {showHotkeyHints.value && <kbd>{'\u2303\u21E7'}W</kbd>}
      </button>
      <div style="display:flex;gap:4px;padding:4px 8px;align-items:center">
        {SESSION_COLOR_PRESETS.map((c) => (
          <span
            key={c}
            onClick={() => { setSessionColor(menuSid, getSessionColor(menuSid) === c ? '' : c); }}
            style={{
              width: '14px', height: '14px', borderRadius: '50%', background: c, cursor: 'pointer',
              border: getSessionColor(menuSid) === c ? '2px solid #fff' : '2px solid transparent',
              boxSizing: 'border-box',
            }}
          />
        ))}
        {getSessionColor(menuSid) && (
          <span
            onClick={() => setSessionColor(menuSid, '')}
            style={{ cursor: 'pointer', fontSize: '12px', opacity: 0.7, marginLeft: '2px' }}
            title="Clear color"
          >{'\u00D7'}</span>
        )}
      </div>
    </div>
  );
}

// Ctrl+Shift hotkey hint menu (Kill / Resolve / Session menu / Window menu / Resume / Close)
export function PopoutHotkeyMenu() {
  const hotkeyMenu = popoutHotkeyMenuOpen.value;
  const statusMenu = popoutStatusMenuOpen.value;
  const sessions = allSessions.value;
  const exited = exitedSessions.value;
  if (!hotkeyMenu || statusMenu) return null;
  const hkSid = hotkeyMenu.sessionId;
  const hkSess = sessions.find((s: any) => s.id === hkSid);
  const hkExited = exited.has(hkSid);
  return (
    <div
      class="status-dot-menu"
      style={{ left: `${hotkeyMenu.x}px`, top: `${hotkeyMenu.y}px`, zIndex: 1100 }}
      onClick={(e) => e.stopPropagation()}
    >
      {!hkExited && (
        <button onClick={() => killSession(hkSid)}>
          Kill <kbd>K</kbd>
        </button>
      )}
      {hkSess?.feedbackId && (
        <button onClick={() => resolveSession(hkSid, hkSess.feedbackId)}>
          Resolve <kbd>R</kbd>
        </button>
      )}
      <button onClick={() => { popoutIdMenuOpen.value = popoutIdMenuOpen.value ? null : hkSid; }}>
        Session menu <kbd>P</kbd>
      </button>
      <button onClick={() => { popoutWindowMenuOpen.value = popoutWindowMenuOpen.value ? null : hotkeyMenu.panelId; }}>
        Window menu <kbd>E</kbd>
      </button>
      {hkExited && (
        <button onClick={() => resumeSession(hkSid)}>Resume</button>
      )}
      <button onClick={() => closeTab(hkSid)}>
        Close tab <kbd>W</kbd>
      </button>
    </div>
  );
}
