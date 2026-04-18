import { useState, useEffect, useCallback } from 'preact/hooks';
import { theme, setTheme, shortcutsEnabled, tooltipsEnabled, showTabs, arrowTabSwitching, multiDigitTabs, autoNavigateToFeedback, showHotkeyHints, autoJumpWaiting, autoJumpInterrupt, autoJumpDelay, popoutMode, type Theme, type PopoutMode } from '../lib/settings.js';
import { perfOverlayEnabled, perfServerEnabled } from '../lib/perf.js';
import { getAllShortcuts } from '../lib/shortcuts.js';
import { Guide, GUIDES, resetGuide } from '../components/Guide.js';
import { hintsEnabled, resetAllHints } from '../lib/hints.js';
import { autoFixEnabled, setAutoFixEnabled } from '../lib/autofix.js';
import { api } from '../lib/api.js';
import { openSession, panelPresets, savePreset, restorePreset, deletePreset } from '../lib/sessions.js';
import { DeletedItemsPanel, trackDeletion } from '../components/DeletedItemsPanel.js';

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

interface TmuxConfig {
  id: string;
  name: string;
  content: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

function TmuxConfigManager() {
  const [configs, setConfigs] = useState<TmuxConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editContents, setEditContents] = useState<Record<string, string>>({});
  const [editNames, setEditNames] = useState<Record<string, string>>({});
  const [savedId, setSavedId] = useState<string | null>(null);
  const [editingInTerminal, setEditingInTerminal] = useState<Record<string, string>>({}); // configId → sessionId
  const [savingFromFile, setSavingFromFile] = useState<string | null>(null);

  const loadConfigs = useCallback(async () => {
    try {
      const data = await api.getTmuxConfigs();
      setConfigs(data);
      const contents: Record<string, string> = {};
      const names: Record<string, string> = {};
      for (const c of data) {
        contents[c.id] = c.content;
        names[c.id] = c.name;
      }
      setEditContents(contents);
      setEditNames(names);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadConfigs(); }, [loadConfigs]);

  const markDirty = (id: string) => setDirtyIds((s) => new Set(s).add(id));
  const clearDirty = (id: string) => {
    setDirtyIds((s) => { const n = new Set(s); n.delete(id); return n; });
  };

  const saveConfig = async (id: string) => {
    setSavingId(id);
    try {
      await api.updateTmuxConfig(id, { name: editNames[id], content: editContents[id] });
      clearDirty(id);
      setSavedId(id);
      setTimeout(() => setSavedId(null), 2000);
      await loadConfigs();
    } finally {
      setSavingId(null);
    }
  };

  const setDefault = async (id: string) => {
    await api.updateTmuxConfig(id, { isDefault: true });
    await loadConfigs();
  };

  const duplicate = async (config: TmuxConfig) => {
    await api.createTmuxConfig({ name: `${config.name} (copy)`, content: config.content });
    await loadConfigs();
  };

  const deleteConfig = async (id: string, name: string) => {
    await api.deleteTmuxConfig(id);
    trackDeletion('tmux-configs', id, name);
    if (expandedId === id) setExpandedId(null);
    await loadConfigs();
  };

  const createNew = async () => {
    const { id } = await api.createTmuxConfig({ name: 'New Config', content: '' });
    await loadConfigs();
    setExpandedId(id);
  };

  const editInTerminal = async (id: string) => {
    try {
      const { sessionId } = await api.editTmuxConfigInTerminal(id);
      setEditingInTerminal((prev) => ({ ...prev, [id]: sessionId }));
      openSession(sessionId);
    } catch (err: any) {
      console.error('Failed to open editor:', err.message);
    }
  };

  const saveFromFile = async (id: string) => {
    setSavingFromFile(id);
    try {
      const { content } = await api.saveTmuxConfigFromFile(id);
      setEditContents((prev) => ({ ...prev, [id]: content }));
      clearDirty(id);
      setSavedId(id);
      setTimeout(() => setSavedId(null), 2000);
      setEditingInTerminal((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      await loadConfigs();
    } catch (err: any) {
      console.error('Save failed:', err.message);
    } finally {
      setSavingFromFile(null);
    }
  };

  if (loading) return <div style="color:var(--pw-text-muted);font-size:13px">Loading...</div>;

  return (
    <div>
      {configs.map((cfg) => {
        const expanded = expandedId === cfg.id;
        const isDirty = dirtyIds.has(cfg.id);
        const isSaving = savingId === cfg.id;
        const terminalSessionId = editingInTerminal[cfg.id];
        const isSavingFromFile = savingFromFile === cfg.id;
        return (
          <div key={cfg.id} class="tmux-config-card">
            <div class="tmux-config-header" onClick={() => setExpandedId(expanded ? null : cfg.id)}>
              <span style="font-size:11px;color:var(--pw-text-faint)">{expanded ? '\u25BC' : '\u25B6'}</span>
              {expanded ? (
                <input
                  type="text"
                  value={editNames[cfg.id] || ''}
                  onInput={(e) => {
                    setEditNames({ ...editNames, [cfg.id]: (e.target as HTMLInputElement).value });
                    markDirty(cfg.id);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  style="font-size:13px;font-weight:600;border:1px solid var(--pw-border);border-radius:4px;padding:2px 6px;background:var(--pw-bg);color:var(--pw-text);flex:1"
                />
              ) : (
                <span style="font-weight:600;font-size:13px;flex:1">{cfg.name}</span>
              )}
              {cfg.isDefault && <span class="tmux-default-badge">Default</span>}
              {!expanded && (
                <span style="font-size:11px;color:var(--pw-text-faint)">{cfg.content.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).length} directives</span>
              )}
              <div style="display:flex;gap:4px" onClick={(e) => e.stopPropagation()}>
                <button class="btn btn-sm" onClick={() => editInTerminal(cfg.id)} style="font-size:11px;padding:2px 6px" title="Edit with $EDITOR (nano/vim/emacs)">Edit in Terminal</button>
                {!cfg.isDefault && (
                  <button class="btn btn-sm" onClick={() => setDefault(cfg.id)} style="font-size:11px;padding:2px 6px">Set Default</button>
                )}
                <button class="btn btn-sm" onClick={() => duplicate(cfg)} style="font-size:11px;padding:2px 6px">Duplicate</button>
                {!cfg.isDefault && (
                  <button class="btn btn-sm btn-danger" onClick={() => deleteConfig(cfg.id, cfg.name)} style="font-size:11px;padding:2px 6px">Delete</button>
                )}
              </div>
            </div>
            {terminalSessionId && (
              <div class="tmux-terminal-banner">
                Editing in terminal
                <button
                  class="btn btn-sm btn-primary"
                  onClick={() => saveFromFile(cfg.id)}
                  disabled={isSavingFromFile}
                  style="font-size:11px;padding:2px 8px"
                >
                  {isSavingFromFile ? 'Saving...' : 'Save from disk'}
                </button>
                <button
                  class="btn btn-sm"
                  onClick={() => openSession(terminalSessionId)}
                  style="font-size:11px;padding:2px 8px"
                >
                  Show terminal
                </button>
              </div>
            )}
            {expanded && (
              <div style="padding:8px 12px;border-top:1px solid var(--pw-border)">
                <textarea
                  value={editContents[cfg.id] || ''}
                  onInput={(e) => {
                    setEditContents({ ...editContents, [cfg.id]: (e.target as HTMLTextAreaElement).value });
                    markDirty(cfg.id);
                  }}
                  class="tmux-config-editor"
                  spellcheck={false}
                />
                <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
                  <button class="btn btn-sm" onClick={() => saveConfig(cfg.id)} disabled={!isDirty || isSaving}>
                    {isSaving ? 'Saving...' : 'Save'}
                  </button>
                  {savedId === cfg.id && <span style="font-size:12px;color:var(--pw-text-muted)">Saved.</span>}
                </div>
              </div>
            )}
          </div>
        );
      })}
      <button class="btn btn-sm" onClick={createNew} style="margin-top:8px">+ New Config</button>
      <DeletedItemsPanel type="tmux-configs" />
    </div>
  );
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
              <option value="terminal">Terminal.app</option>
            </select>
          </div>
        </div>

        <div class="settings-section">
          <h3>Tmux Configurations</h3>
          <div class="settings-toggle-desc" style="margin-bottom:10px">
            Named tmux configs for browser terminal sessions. Assign per-app in Applications.
          </div>
          <TmuxConfigManager />
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
