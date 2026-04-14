import { useState, useEffect } from 'preact/hooks';
import { theme, setTheme, shortcutsEnabled, tooltipsEnabled, showTabs, arrowTabSwitching, multiDigitTabs, autoNavigateToFeedback, showHotkeyHints, autoJumpWaiting, autoJumpInterrupt, autoJumpDelay, popoutMode, localBridgeUrl, sshConfigs, type Theme, type PopoutMode, type SshConfig } from '../lib/settings.js';
import { perfOverlayEnabled, perfServerEnabled } from '../lib/perf.js';
import { getAllShortcuts } from '../lib/shortcuts.js';
import { Guide, GUIDES, resetGuide } from '../components/Guide.js';
import { hintsEnabled, resetAllHints } from '../lib/hints.js';
import { autoFixEnabled, setAutoFixEnabled } from '../lib/autofix.js';
import { panelPresets, savePreset, restorePreset, deletePreset } from '../lib/sessions.js';
import { DeletedItemsPanel } from '../components/DeletedItemsPanel.js';
import { api } from '../lib/api.js';

function formatKey(s: ReturnType<typeof getAllShortcuts>[0]): string {
  const parts: string[] = [];
  if (s.modifiers?.ctrl) parts.push('Ctrl');
  if (s.modifiers?.shift) parts.push('Shift');
  if (s.modifiers?.alt) parts.push('Alt');
  if (s.modifiers?.meta) parts.push('Cmd');
  if (s.sequence) return s.sequence;
  parts.push(s.key === ' ' ? 'Space' : s.key);
  return parts.join('+');
}

function PanelPresetManager() {
  const [newName, setNewName] = useState('');
  const presets = panelPresets.value;

  return (
    <div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
        <input
          type="text"
          placeholder="Preset name..."
          value={newName}
          onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
          style="flex:1;padding:6px 10px;font-size:13px"
        />
        <button
          class="btn btn-sm btn-primary"
          disabled={!newName.trim()}
          onClick={() => {
            if (newName.trim()) {
              savePreset(newName.trim());
              setNewName('');
            }
          }}
        >
          Save Current
        </button>
      </div>
      {presets.length === 0 && (
        <div style="font-size:12px;color:var(--pw-text-muted)">No saved presets yet.</div>
      )}
      {presets.map((p) => (
        <div key={p.name} class="preset-row">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600">{p.name}</div>
            <div style="font-size:11px;color:var(--pw-text-faint)">
              {p.openTabs.length} tabs, {p.panels.length} panels &middot; {new Date(p.savedAt).toLocaleDateString()}
            </div>
          </div>
          <div style="display:flex;gap:4px">
            <button class="btn btn-sm" onClick={() => restorePreset(p.name)}>Restore</button>
            <button class="btn btn-sm btn-danger" onClick={() => deletePreset(p.name)}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}


function SshConfigManager() {
  const [hostname, setHostname] = useState('');
  const [user, setUser] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const configs = sshConfigs.value;

  const addConfig = () => {
    if (!hostname.trim() || !user.trim() || !host.trim()) return;
    const entry: SshConfig = { sshUser: user.trim(), sshHost: host.trim() };
    if (port.trim()) entry.sshPort = parseInt(port.trim(), 10);
    sshConfigs.value = { ...configs, [hostname.trim()]: entry };
    setHostname('');
    setUser('');
    setHost('');
    setPort('');
  };

  const removeConfig = (key: string) => {
    const next = { ...configs };
    delete next[key];
    sshConfigs.value = next;
  };

  return (
    <div style="margin-top:12px">
      <div class="settings-toggle-label" style="margin-bottom:8px">SSH Configs (per remote hostname)</div>
      <div class="settings-toggle-desc" style="margin-bottom:8px">
        Map each remote admin hostname to its SSH connection details.
      </div>
      {Object.entries(configs).map(([key, cfg]) => (
        <div key={key} class="preset-row" style="align-items:center">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600">{key}</div>
            <div style="font-size:11px;color:var(--pw-text-faint)">
              {cfg.sshUser}@{cfg.sshHost}{cfg.sshPort ? `:${cfg.sshPort}` : ''}
            </div>
          </div>
          <button class="btn btn-sm btn-danger" onClick={() => removeConfig(key)}>Remove</button>
        </div>
      ))}
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px">
        <input
          type="text"
          placeholder="Hostname (e.g. azstaging.myworkbench.ai)"
          value={hostname}
          onInput={(e) => setHostname((e.target as HTMLInputElement).value)}
          style="flex:2;min-width:180px;padding:4px 8px;font-size:12px;border:1px solid var(--pw-border);border-radius:4px;background:var(--pw-bg-secondary);color:var(--pw-text)"
        />
        <input
          type="text"
          placeholder="SSH user"
          value={user}
          onInput={(e) => setUser((e.target as HTMLInputElement).value)}
          style="flex:1;min-width:80px;padding:4px 8px;font-size:12px;border:1px solid var(--pw-border);border-radius:4px;background:var(--pw-bg-secondary);color:var(--pw-text)"
        />
        <input
          type="text"
          placeholder="SSH host/IP"
          value={host}
          onInput={(e) => setHost((e.target as HTMLInputElement).value)}
          style="flex:1;min-width:100px;padding:4px 8px;font-size:12px;border:1px solid var(--pw-border);border-radius:4px;background:var(--pw-bg-secondary);color:var(--pw-text)"
        />
        <input
          type="text"
          placeholder="Port"
          value={port}
          onInput={(e) => setPort((e.target as HTMLInputElement).value)}
          style="width:60px;padding:4px 8px;font-size:12px;border:1px solid var(--pw-border);border-radius:4px;background:var(--pw-bg-secondary);color:var(--pw-text)"
        />
        <button
          class="btn btn-sm btn-primary"
          disabled={!hostname.trim() || !user.trim() || !host.trim()}
          onClick={addConfig}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function ChangePasswordSection() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    setStatus(null);
    if (!currentPassword || !newPassword) {
      setStatus({ type: 'error', message: 'Please fill in all fields' });
      return;
    }
    if (newPassword.length < 4) {
      setStatus({ type: 'error', message: 'New password must be at least 4 characters' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setStatus({ type: 'error', message: 'New passwords do not match' });
      return;
    }
    setSaving(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setStatus({ type: 'success', message: 'Password changed successfully' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (e: any) {
      setStatus({ type: 'error', message: e.message || 'Failed to change password' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="settings-section">
      <h3>Change Password</h3>
      <div style="display:flex;flex-direction:column;gap:10px;max-width:320px">
        <div>
          <label style="font-size:12px;color:var(--pw-text-muted);display:block;margin-bottom:4px">Current Password</label>
          <input
            type="password"
            value={currentPassword}
            onInput={(e) => setCurrentPassword((e.target as HTMLInputElement).value)}
            style="width:100%;padding:6px 10px;border:1px solid var(--pw-border);border-radius:6px;background:var(--pw-bg);color:var(--pw-text);font-size:13px"
          />
        </div>
        <div>
          <label style="font-size:12px;color:var(--pw-text-muted);display:block;margin-bottom:4px">New Password</label>
          <input
            type="password"
            value={newPassword}
            onInput={(e) => setNewPassword((e.target as HTMLInputElement).value)}
            style="width:100%;padding:6px 10px;border:1px solid var(--pw-border);border-radius:6px;background:var(--pw-bg);color:var(--pw-text);font-size:13px"
          />
        </div>
        <div>
          <label style="font-size:12px;color:var(--pw-text-muted);display:block;margin-bottom:4px">Confirm New Password</label>
          <input
            type="password"
            value={confirmPassword}
            onInput={(e) => setConfirmPassword((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
            style="width:100%;padding:6px 10px;border:1px solid var(--pw-border);border-radius:6px;background:var(--pw-bg);color:var(--pw-text);font-size:13px"
          />
        </div>
        {status && (
          <div style={`font-size:12px;color:${status.type === 'success' ? 'var(--pw-success, #22c55e)' : 'var(--pw-danger, #ef4444)'}`}>
            {status.message}
          </div>
        )}
        <button
          class="btn btn-sm"
          disabled={saving}
          onClick={handleSubmit}
          style="align-self:flex-start;padding:6px 16px"
        >
          {saving ? 'Saving...' : 'Update Password'}
        </button>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const [activeGuide, setActiveGuide] = useState<typeof GUIDES[0] | null>(null);
  const shortcuts = getAllShortcuts();
  const categories = ['Navigation', 'Panels', 'General'] as const;

  const themes: { value: Theme; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' },
  ];

  return (
    <div>
      <div class="page-header">
        <h2>Preferences</h2>
      </div>

      <div class="detail-card" style="margin-bottom:20px;max-width:1000px">
        <div class="settings-section">
          <h3>Appearance</h3>
          <div class="theme-toggle-group">
            {themes.map((t) => (
              <button
                key={t.value}
                class={`theme-toggle-btn ${theme.value === t.value ? 'active' : ''}`}
                onClick={() => setTheme(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div class="settings-section">
          <h3>Keyboard Shortcuts</h3>
          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-label">Enable keyboard shortcuts</div>
              <div class="settings-toggle-desc">Navigate and control the UI with hotkeys</div>
            </div>
            <label class="toggle-switch">
              <input
                type="checkbox"
                checked={shortcutsEnabled.value}
                onChange={(e) => (shortcutsEnabled.value = (e.target as HTMLInputElement).checked)}
              />
              <span class="toggle-slider" />
            </label>
          </div>

          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-label">Arrow key tab switching</div>
              <div class="settings-toggle-desc">Ctrl+Shift+Arrow to cycle pages and session tabs</div>
            </div>
            <label class="toggle-switch">
              <input
                type="checkbox"
                checked={arrowTabSwitching.value}
                onChange={(e) => (arrowTabSwitching.value = (e.target as HTMLInputElement).checked)}
              />
              <span class="toggle-slider" />
            </label>
          </div>

          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-label">Show hotkey hints</div>
              <div class="settings-toggle-desc">Show action menu (Kill, Resolve, Close) on active tab when holding Ctrl+Shift</div>
            </div>
            <label class="toggle-switch">
              <input
                type="checkbox"
                checked={showHotkeyHints.value}
                onChange={(e) => (showHotkeyHints.value = (e.target as HTMLInputElement).checked)}
              />
              <span class="toggle-slider" />
            </label>
          </div>

          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-label">Multi-digit tab numbers</div>
              <div class="settings-toggle-desc">Ctrl+Shift+1 jumps to tab 1, then 2 within 500ms refines to tab 12</div>
            </div>
            <label class="toggle-switch">
              <input
                type="checkbox"
                checked={multiDigitTabs.value}
                onChange={(e) => (multiDigitTabs.value = (e.target as HTMLInputElement).checked)}
              />
              <span class="toggle-slider" />
            </label>
          </div>

          {shortcuts.length > 0 && (
            <div style="margin-top:16px">
              {categories.map((cat) => {
                const items = shortcuts.filter((s) => s.category === cat);
                if (items.length === 0) return null;
                return (
                  <div key={cat} class="shortcut-section">
                    <h4>{cat}</h4>
                    {items.map((s) => {
                      const keyStr = formatKey(s);
                      const parts = keyStr.split(' ');
                      return (
                        <div key={keyStr + s.label} class="shortcut-row">
                          <span class="shortcut-label">{s.label}</span>
                          <span class="shortcut-keys">
                            {parts.map((p, i) => (
                              <>
                                {i > 0 && <span class="then">then</span>}
                                <kbd>{p}</kbd>
                              </>
                            ))}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div class="settings-section">
          <h3>Terminal</h3>
          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-label">Show session tabs</div>
              <div class="settings-toggle-desc">Display tab bar with session titles in the terminal panel</div>
            </div>
            <label class="toggle-switch">
              <input
                type="checkbox"
                checked={showTabs.value}
                onChange={(e) => (showTabs.value = (e.target as HTMLInputElement).checked)}
              />
              <span class="toggle-slider" />
            </label>
          </div>

          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-label">Auto-jump to next waiting session</div>
              <div class="settings-toggle-desc">After providing input to a waiting session, automatically jump to the next one waiting</div>
            </div>
            <label class="toggle-switch">
              <input
                type="checkbox"
                checked={autoJumpWaiting.value}
                onChange={(e) => (autoJumpWaiting.value = (e.target as HTMLInputElement).checked)}
              />
              <span class="toggle-slider" />
            </label>
          </div>

          <div class="settings-toggle-row" style={{ paddingLeft: 24 }}>
            <div>
              <div class="settings-toggle-label">Interrupt typing</div>
              <div class="settings-toggle-desc">Jump immediately even if you're in the middle of typing</div>
            </div>
            <label class="toggle-switch">
              <input
                type="checkbox"
                checked={autoJumpInterrupt.value}
                onChange={(e) => (autoJumpInterrupt.value = (e.target as HTMLInputElement).checked)}
              />
              <span class="toggle-slider" />
            </label>
          </div>

          <div class="settings-toggle-row" style={{ paddingLeft: 24 }}>
            <div>
              <div class="settings-toggle-label">3 second delay</div>
              <div class="settings-toggle-desc">Wait 3 seconds before jumping (cancel with Ctrl+Shift+X)</div>
            </div>
            <label class="toggle-switch">
              <input
                type="checkbox"
                checked={autoJumpDelay.value}
                onChange={(e) => (autoJumpDelay.value = (e.target as HTMLInputElement).checked)}
              />
              <span class="toggle-slider" />
            </label>
          </div>

          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-label">Auto-navigate to feedback</div>
              <div class="settings-toggle-desc">When switching sessions, navigate to the associated feedback item</div>
            </div>
            <label class="toggle-switch">
              <input
                type="checkbox"
                checked={autoNavigateToFeedback.value}
                onChange={(e) => (autoNavigateToFeedback.value = (e.target as HTMLInputElement).checked)}
              />
              <span class="toggle-slider" />
            </label>
          </div>

          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-label">Default popout action</div>
              <div class="settings-toggle-desc">Where sessions open when you click the popout button</div>
            </div>
            <select
              class="view-mode-select"
              value={popoutMode.value}
              onChange={(e) => { popoutMode.value = (e.target as HTMLSelectElement).value as PopoutMode; }}
            >
              <option value="panel">Panel</option>
              <option value="window">Window</option>
              <option value="tab">Tab</option>
            </select>
          </div>
        </div>

        <div class="settings-section">
          <h3>Local Terminal Bridge</h3>
          <div class="settings-toggle-desc" style="margin-bottom:10px">
            Open sessions in Terminal.app via SSH+tmux. Available from the "Open In" menu on each session tab.
          </div>
          {(location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? (
            <div style="padding:8px 12px;background:var(--pw-bg-secondary);border-radius:8px;border:1px solid var(--pw-border);font-size:12px;color:var(--pw-text-muted)">
              Running locally — sessions will attach directly via tmux (no SSH needed).
            </div>
          ) : (
            <>
              <div class="settings-toggle-row" style="margin-bottom:8px">
                <div>
                  <div class="settings-toggle-label">Local prompt-widget URL</div>
                  <div class="settings-toggle-desc">Your local server that opens Terminal.app</div>
                </div>
                <input
                  type="text"
                  value={localBridgeUrl.value}
                  onInput={(e) => (localBridgeUrl.value = (e.target as HTMLInputElement).value)}
                  style="width:250px;padding:4px 8px;border:1px solid var(--pw-border);border-radius:4px;background:var(--pw-bg-secondary);color:var(--pw-text);font-size:13px"
                />
              </div>
              <SshConfigManager />
            </>
          )}
        </div>

        <div class="settings-section">
          <h3>Panel Presets</h3>
          <div class="settings-toggle-desc" style="margin-bottom:10px">
            Save and restore panel arrangements (tab layout, docked panels, sizes).
          </div>
          <PanelPresetManager />
        </div>

        <div class="settings-section">
          <h3>Tooltips & Hints</h3>
          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-label">Show tooltips on hover</div>
              <div class="settings-toggle-desc">Display hints and keyboard shortcut reminders</div>
            </div>
            <label class="toggle-switch">
              <input
                type="checkbox"
                checked={tooltipsEnabled.value}
                onChange={(e) => (tooltipsEnabled.value = (e.target as HTMLInputElement).checked)}
              />
              <span class="toggle-slider" />
            </label>
          </div>

          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-label">Show contextual hints</div>
              <div class="settings-toggle-desc">Display hint toasts when navigating to new pages</div>
            </div>
            <label class="toggle-switch">
              <input
                type="checkbox"
                checked={hintsEnabled.value}
                onChange={(e) => (hintsEnabled.value = (e.target as HTMLInputElement).checked)}
              />
              <span class="toggle-slider" />
            </label>
          </div>

          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-label">Reset dismissed hints</div>
              <div class="settings-toggle-desc">Show all contextual hints again</div>
            </div>
            <button
              class="btn btn-sm"
              onClick={() => {
                resetAllHints();
                hintsEnabled.value = true;
              }}
            >
              Reset
            </button>
          </div>

          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-label">Auto-fix failed sessions</div>
              <div class="settings-toggle-desc">Automatically launch a diagnostic session when a remote session fails immediately</div>
            </div>
            <label class="toggle-switch">
              <input
                type="checkbox"
                checked={autoFixEnabled.value}
                onChange={(e) => setAutoFixEnabled((e.target as HTMLInputElement).checked)}
              />
              <span class="toggle-slider" />
            </label>
          </div>
        </div>

        <div class="settings-section">
          <h3>Guides</h3>
          {GUIDES.map((guide) => (
            <div key={guide.id} class="settings-toggle-row">
              <div>
                <div class="settings-toggle-label">{guide.name}</div>
                <div class="settings-toggle-desc">{guide.steps.length} steps</div>
              </div>
              <button
                class="btn btn-sm"
                onClick={() => {
                  resetGuide(guide.id);
                  setActiveGuide(guide);
                }}
              >
                Start Tour
              </button>
            </div>
          ))}
        </div>

        <div class="settings-section">
          <h3>Developer</h3>
          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-label">Performance overlay</div>
              <div class="settings-toggle-desc">Show a timing badge for API calls on each page load</div>
            </div>
            <label class="toggle-switch">
              <input
                type="checkbox"
                checked={perfOverlayEnabled.value}
                onChange={(e) => (perfOverlayEnabled.value = (e.target as HTMLInputElement).checked)}
              />
              <span class="toggle-slider" />
            </label>
          </div>
          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-label">Persist performance data</div>
              <div class="settings-toggle-desc">Send timing data to the server on route changes</div>
            </div>
            <label class="toggle-switch">
              <input
                type="checkbox"
                checked={perfServerEnabled.value}
                onChange={(e) => (perfServerEnabled.value = (e.target as HTMLInputElement).checked)}
              />
              <span class="toggle-slider" />
            </label>
          </div>
        </div>

        <ChangePasswordSection />

        <div class="settings-section">
          <h3>About</h3>
          <div style="font-size:13px;color:var(--pw-text-muted)">
            Prompt Widget Admin v1.0
          </div>
        </div>
      </div>

      {activeGuide && (
        <Guide guide={activeGuide} onClose={() => setActiveGuide(null)} />
      )}
    </div>
  );
}
