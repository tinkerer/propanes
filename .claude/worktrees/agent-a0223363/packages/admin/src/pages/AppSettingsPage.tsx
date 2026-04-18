import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../lib/api.js';
import { applications, loadApplications, navigate } from '../lib/state.js';
import { copyText, copyWithTooltip } from '../lib/clipboard.js';
import { AiAssistButton } from '../components/AiAssistButton.js';
import { AgentCard } from '../components/AgentCard.js';
import { AgentFormModal } from '../components/AgentFormModal.js';
import { TOOL_PRESETS } from '../lib/agent-constants.js';
import { trackDeletion } from '../components/DeletedItemsPanel.js';

interface SuggestionDraft {
  label: string;
  prompt: string;
}

interface PreferenceDraft {
  id: string;
  label: string;
  promptSnippet: string;
  default: boolean;
}

interface ControlActionDraft {
  id: string;
  label: string;
  command: string;
  icon: string;
}

export function AppSettingsPage({ appId }: { appId: string }) {
  const app = applications.value.find((a: any) => a.id === appId);
  const [agents, setAgents] = useState<any[]>([]);
  const [tmuxConfigs, setTmuxConfigs] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Application settings state
  const [name, setName] = useState('');
  const [projectDir, setProjectDir] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [hooks, setHooks] = useState('');
  const [description, setDescription] = useState('');
  const [tmuxConfigId, setTmuxConfigId] = useState('');
  const [permissionProfile, setPermissionProfile] = useState('interactive');
  const [allowedTools, setAllowedTools] = useState('');
  const [agentPath, setAgentPath] = useState('');
  const [showToolPresets, setShowToolPresets] = useState(false);

  // Request panel state
  const [suggestions, setSuggestions] = useState<SuggestionDraft[]>([]);
  const [preferences, setPreferences] = useState<PreferenceDraft[]>([]);
  const [promptPrefix, setPromptPrefix] = useState('');
  const [defaultAgentId, setDefaultAgentId] = useState('');

  // Control actions state
  const [actions, setActions] = useState<ControlActionDraft[]>([]);

  // Agent modal state
  const [agentModalVisible, setAgentModalVisible] = useState(false);
  const [agentModalEdit, setAgentModalEdit] = useState<any>(undefined);

  const loadAgents = useCallback(async () => {
    try {
      const [agentData, configData] = await Promise.all([
        api.getAgents(),
        api.getTmuxConfigs(),
      ]);
      setAgents(agentData);
      setTmuxConfigs(configData);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    if (!app) return;
    // Application fields
    setName(app.name || '');
    setProjectDir(app.projectDir || '');
    setServerUrl(app.serverUrl || '');
    setHooks((app.hooks || []).join(', '));
    setDescription(app.description || '');
    setTmuxConfigId(app.tmuxConfigId || '');
    setPermissionProfile(app.defaultPermissionProfile || 'interactive');
    setAllowedTools(app.defaultAllowedTools || '');
    setAgentPath(app.agentPath || '');

    // Request panel fields
    const config = app.requestPanel || {};
    setSuggestions((config.suggestions || []).map((s: any) => ({ label: s.label, prompt: s.prompt })));
    setPreferences((config.preferences || []).map((p: any) => ({
      id: p.id,
      label: p.label,
      promptSnippet: p.promptSnippet,
      default: !!p.default,
    })));
    setPromptPrefix(config.promptPrefix || '');
    setDefaultAgentId(config.defaultAgentId || '');
    setActions((app.controlActions || []).map((a: any) => ({
      id: a.id,
      label: a.label,
      command: a.command,
      icon: a.icon || '',
    })));
  }, [app?.id]);

  if (!app) {
    return <div style="padding:20px;color:var(--pw-text-muted)">App not found</div>;
  }

  function addToolPreset(value: string) {
    const current = allowedTools.trim();
    const existing = current.split(',').map(s => s.trim()).filter(Boolean);
    const adding = value.split(',').map(s => s.trim()).filter(Boolean);
    const merged = [...existing];
    for (const tool of adding) {
      if (!merged.includes(tool)) merged.push(tool);
    }
    setAllowedTools(merged.join(', '));
    setShowToolPresets(false);
  }

  function addSuggestion() {
    setSuggestions([...suggestions, { label: '', prompt: '' }]);
  }

  function removeSuggestion(idx: number) {
    setSuggestions(suggestions.filter((_, i) => i !== idx));
  }

  function updateSuggestion(idx: number, field: keyof SuggestionDraft, value: string) {
    setSuggestions(suggestions.map((s, i) => i === idx ? { ...s, [field]: value } : s));
  }

  function addPreference() {
    const id = 'pref-' + Math.random().toString(36).slice(2, 8);
    setPreferences([...preferences, { id, label: '', promptSnippet: '', default: false }]);
  }

  function removePreference(idx: number) {
    setPreferences(preferences.filter((_, i) => i !== idx));
  }

  function updatePreference(idx: number, field: string, value: any) {
    setPreferences(preferences.map((p, i) => i === idx ? { ...p, [field]: value } : p));
  }

  function addAction() {
    const id = 'action-' + Math.random().toString(36).slice(2, 8);
    setActions([...actions, { id, label: '', command: '', icon: '' }]);
  }

  function removeAction(idx: number) {
    setActions(actions.filter((_, i) => i !== idx));
  }

  function updateAction(idx: number, field: keyof ControlActionDraft, value: string) {
    setActions(actions.map((a, i) => i === idx ? { ...a, [field]: value } : a));
  }

  async function regenerateKey() {
    const result = await api.regenerateApplicationKey(appId);
    await loadApplications();
    copyText(result.apiKey);
  }

  async function deleteApp() {
    await api.deleteApplication(appId);
    await loadApplications();
    const apps = applications.value;
    if (apps.length > 0) {
      navigate(`/app/${apps[0].id}/feedback`);
    } else {
      navigate('/settings/getting-started');
    }
  }

  async function save() {
    setSaving(true);
    try {
      const parsedHooks = hooks.split(',').map((h) => h.trim()).filter(Boolean);
      const cleanedSuggestions = suggestions.filter((s) => s.label && s.prompt);
      const cleanedPreferences = preferences.filter((p) => p.label && p.promptSnippet);
      const cleanedActions = actions
        .filter((a) => a.label && a.command)
        .map((a) => ({ id: a.id, label: a.label, command: a.command, ...(a.icon ? { icon: a.icon } : {}) }));

      await api.updateApplication(appId, {
        name,
        projectDir,
        serverUrl: serverUrl || undefined,
        hooks: parsedHooks,
        description,
        tmuxConfigId: tmuxConfigId || null,
        defaultPermissionProfile: permissionProfile,
        defaultAllowedTools: allowedTools || null,
        agentPath: agentPath || null,
        requestPanel: {
          suggestions: cleanedSuggestions,
          preferences: cleanedPreferences,
          ...(defaultAgentId ? { defaultAgentId } : {}),
          ...(promptPrefix ? { promptPrefix } : {}),
        },
        controlActions: cleanedActions,
      });
      await loadApplications();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      console.error('Save failed:', err.message);
    }
    setSaving(false);
  }

  return (
    <div>
      <div class="page-header">
        <h2>{app.name} Settings</h2>
      </div>

      <div class="detail-card" style="max-width:800px">
        {/* Application Settings */}
        <div class="settings-section">
          <h3>Application</h3>
          <div class="form-group" style="margin-bottom:10px">
            <label style="font-size:12px;font-weight:600;margin-bottom:4px;display:block">Name</label>
            <input
              type="text"
              value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
              style="width:100%;padding:6px 10px;font-size:13px"
            />
          </div>
          <div class="form-group" style="margin-bottom:10px">
            <label style="font-size:12px;font-weight:600;margin-bottom:4px;display:block">Project Directory</label>
            <input
              type="text"
              value={projectDir}
              onInput={(e) => setProjectDir((e.target as HTMLInputElement).value)}
              placeholder="/home/user/projects/my-app"
              style="width:100%;padding:6px 10px;font-size:13px"
            />
            <span style="font-size:11px;color:var(--pw-text-faint)">Used as --cwd for Claude Code</span>
          </div>
          <div class="form-group" style="margin-bottom:10px">
            <label style="font-size:12px;font-weight:600;margin-bottom:4px;display:block">Server URL</label>
            <input
              type="url"
              value={serverUrl}
              onInput={(e) => setServerUrl((e.target as HTMLInputElement).value)}
              placeholder="https://myapp.example.com"
              style="width:100%;padding:6px 10px;font-size:13px"
            />
          </div>
          <div class="form-group" style="margin-bottom:10px">
            <label style="font-size:12px;font-weight:600;margin-bottom:4px;display:block">Hooks (comma-separated)</label>
            <input
              type="text"
              value={hooks}
              onInput={(e) => setHooks((e.target as HTMLInputElement).value)}
              placeholder="navigate, click, getState"
              style="width:100%;padding:6px 10px;font-size:13px"
            />
            <span style="font-size:11px;color:var(--pw-text-faint)">Names of window.agent.* methods the app exposes</span>
          </div>
          <div class="form-group" style="margin-bottom:10px">
            <label style="font-size:12px;font-weight:600;margin-bottom:4px;display:block">Description</label>
            <textarea
              value={description}
              onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
              placeholder="What this application does, key features, etc."
              style="width:100%;min-height:60px;padding:6px 10px;font-size:13px"
            />
          </div>
        </div>

        {/* Session Settings */}
        <div class="settings-section">
          <h3>Session Settings</h3>
          <div class="form-group" style="margin-bottom:10px">
            <label style="font-size:12px;font-weight:600;margin-bottom:4px;display:block">Tmux Configuration</label>
            <select
              value={tmuxConfigId}
              onChange={(e) => setTmuxConfigId((e.target as HTMLSelectElement).value)}
              style="width:100%;padding:6px 10px;font-size:13px"
            >
              <option value="">Global Default</option>
              {tmuxConfigs.map((cfg: any) => (
                <option key={cfg.id} value={cfg.id}>
                  {cfg.name}{cfg.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div class="form-group" style="margin-bottom:10px">
            <label style="font-size:12px;font-weight:600;margin-bottom:4px;display:block">Default Permission Profile</label>
            <select
              value={permissionProfile}
              onChange={(e) => setPermissionProfile((e.target as HTMLSelectElement).value)}
              style="width:100%;padding:6px 10px;font-size:13px"
            >
              <option value="interactive">Interactive</option>
              <option value="auto">Auto</option>
              <option value="yolo">Yolo (skip permissions)</option>
            </select>
          </div>
          <div class="form-group" style="margin-bottom:10px">
            <label style="font-size:12px;font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:8px">
              Default Allowed Tools
              <span style="position:relative">
                <button
                  type="button"
                  class="btn btn-sm"
                  style="font-size:10px;padding:1px 6px"
                  onClick={() => setShowToolPresets(!showToolPresets)}
                >
                  + Add common {showToolPresets ? '\u25B4' : '\u25BE'}
                </button>
                {showToolPresets && (
                  <div style="position:absolute;top:100%;left:0;z-index:100;background:var(--pw-bg-surface);border:1px solid var(--pw-border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.15);min-width:220px;margin-top:4px;padding:4px 0">
                    {TOOL_PRESETS.map((p) => (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => addToolPreset(p.value)}
                        style="display:block;width:100%;text-align:left;padding:6px 12px;background:none;border:none;color:var(--pw-text);font-size:12px;cursor:pointer"
                        onMouseOver={(e) => ((e.target as HTMLElement).style.background = 'var(--pw-bg-hover)')}
                        onMouseOut={(e) => ((e.target as HTMLElement).style.background = 'none')}
                      >
                        <div style="font-weight:500">{p.label}</div>
                        <div style="font-size:11px;color:var(--pw-text-faint);font-family:'SF Mono',Monaco,Menlo,monospace">{p.value}</div>
                      </button>
                    ))}
                  </div>
                )}
              </span>
            </label>
            <textarea
              value={allowedTools}
              onInput={(e) => setAllowedTools((e.target as HTMLTextAreaElement).value)}
              onFocus={() => setShowToolPresets(false)}
              placeholder="Edit, Bash(npm test), Read, ..."
              style="width:100%;min-height:40px;font-family:'SF Mono',Monaco,Menlo,monospace;font-size:12px;padding:6px 10px"
            />
            <span style="font-size:11px;color:var(--pw-text-faint)">Comma-separated list of tools for --allowedTools</span>
          </div>
          <div class="form-group" style="margin-bottom:10px">
            <label style="font-size:12px;font-weight:600;margin-bottom:4px;display:block">Agent Path</label>
            <input
              type="text"
              value={agentPath}
              onInput={(e) => setAgentPath((e.target as HTMLInputElement).value)}
              placeholder="/usr/local/bin/claude (default: claude)"
              style="width:100%;padding:6px 10px;font-size:13px"
            />
            <span style="font-size:11px;color:var(--pw-text-faint)">Custom path to Claude CLI binary</span>
          </div>
        </div>

        {/* API Key */}
        <div class="settings-section">
          <h3>API Key</h3>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <code style="font-size:11px;background:var(--pw-code-block-bg);padding:2px 8px;border-radius:4px;color:var(--pw-code-block-text);word-break:break-all">
              {app.apiKey}
            </code>
            <button
              class="btn btn-sm"
              onClick={(e) => copyWithTooltip(app.apiKey, e as any)}
              style="font-size:11px;padding:2px 8px"
            >
              Copy
            </button>
            <button
              class="btn btn-sm"
              onClick={regenerateKey}
              style="font-size:11px;padding:2px 8px"
            >
              Regenerate
            </button>
          </div>
        </div>

        {/* Request Panel: Prompt Prefix */}
        <div class="settings-section">
          <h3>Prompt Prefix <AiAssistButton appId={appId} context="Text prepended to every request" settingPath="requestPanel.promptPrefix" /></h3>
          <div class="settings-toggle-desc" style="margin-bottom:8px">
            Text prepended to every request sent from the request panel.
          </div>
          <textarea
            class="request-panel-textarea"
            style="width:100%;min-height:60px"
            placeholder="e.g. You are working on the XYZ project. Always use TypeScript."
            value={promptPrefix}
            onInput={(e) => setPromptPrefix((e.target as HTMLTextAreaElement).value)}
            spellcheck={false}
          />
        </div>

        {/* Agents for this app */}
        <div class="settings-section">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <h3 style="margin:0">Agents</h3>
            <button class="btn btn-sm" onClick={() => { setAgentModalEdit(undefined); setAgentModalVisible(true); }}>+ Add Agent</button>
          </div>
          <div class="settings-toggle-desc" style="margin-bottom:10px">
            Agents scoped to this application. <span style="color:var(--pw-text-faint)">Global agents are managed in Settings &gt; Agents.</span>
          </div>
          <div class="agent-list">
            {agents.filter((a: any) => a.appId === appId).map((agent: any) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                applications={[app]}
                onEdit={(a) => { setAgentModalEdit(a); setAgentModalVisible(true); }}
                onDelete={async (id, name) => {
                  await api.deleteAgent(id);
                  trackDeletion('agents', id, name);
                  await loadAgents();
                }}
                showAppBadge={false}
              />
            ))}
            {agents.filter((a: any) => a.appId === appId).length === 0 && (
              <div style="font-size:12px;color:var(--pw-text-muted);padding:8px 0">
                No agents for this app yet.
              </div>
            )}
          </div>
          <AgentFormModal
            key={agentModalEdit?.id || (agentModalVisible ? 'new' : 'closed')}
            visible={agentModalVisible}
            onClose={() => setAgentModalVisible(false)}
            onSaved={loadAgents}
            editAgent={agentModalEdit}
            applications={[app]}
            fixedAppId={appId}
          />
        </div>

        {/* Request Panel: Default Agent */}
        <div class="settings-section">
          <h3>Default Agent <AiAssistButton appId={appId} context="Agent endpoint used for requests" settingPath="requestPanel.defaultAgentId" /></h3>
          <div class="settings-toggle-desc" style="margin-bottom:8px">
            Agent endpoint used when submitting requests.
          </div>
          <select
            class="view-mode-select"
            style="width:100%;max-width:300px"
            value={defaultAgentId}
            onChange={(e) => setDefaultAgentId((e.target as HTMLSelectElement).value)}
          >
            <option value="">Auto (first available)</option>
            {agents.map((a: any) => (
              <option key={a.id} value={a.id}>{a.name} ({a.mode})</option>
            ))}
          </select>
        </div>

        {/* Request Panel: Suggestions */}
        <div class="settings-section">
          <h3>Request Suggestions <AiAssistButton appId={appId} context="Preset prompts shown as quick-fill options" settingPath="requestPanel.suggestions" /></h3>
          <div class="settings-toggle-desc" style="margin-bottom:8px">
            Preset prompts shown as quick-fill options in the request panel.
          </div>
          {suggestions.map((s, idx) => (
            <div key={idx} style="display:flex;gap:6px;margin-bottom:8px;align-items:flex-start">
              <input
                style="flex:1;padding:4px 8px;font-size:12px;border:1px solid var(--pw-border);border-radius:3px;background:var(--pw-bg);color:var(--pw-text)"
                placeholder="Label (e.g. Build Docker)"
                value={s.label}
                onInput={(e) => updateSuggestion(idx, 'label', (e.target as HTMLInputElement).value)}
              />
              <input
                style="flex:2;padding:4px 8px;font-size:12px;border:1px solid var(--pw-border);border-radius:3px;background:var(--pw-bg);color:var(--pw-text)"
                placeholder="Prompt text"
                value={s.prompt}
                onInput={(e) => updateSuggestion(idx, 'prompt', (e.target as HTMLInputElement).value)}
              />
              <button
                onClick={() => removeSuggestion(idx)}
                style="padding:4px 8px;font-size:11px;border:1px solid var(--pw-border);border-radius:3px;background:var(--pw-bg);color:var(--pw-danger,#ef4444);cursor:pointer"
              >{'\u2715'}</button>
            </div>
          ))}
          <button class="btn btn-sm" onClick={addSuggestion}>+ Add Suggestion</button>
        </div>

        {/* Request Panel: Preferences */}
        <div class="settings-section">
          <h3>Request Preferences <AiAssistButton appId={appId} context="Checkbox preferences appended to prompts" settingPath="requestPanel.preferences" /></h3>
          <div class="settings-toggle-desc" style="margin-bottom:8px">
            Checkboxes shown in the request panel. When checked, their snippet is appended to the prompt.
          </div>
          {preferences.map((p, idx) => (
            <div key={p.id} style="display:flex;gap:6px;margin-bottom:8px;align-items:center">
              <label style="font-size:11px;display:flex;align-items:center;gap:2px;white-space:nowrap" title="Default checked">
                <input
                  type="checkbox"
                  checked={p.default}
                  onChange={(e) => updatePreference(idx, 'default', (e.target as HTMLInputElement).checked)}
                />
                Def
              </label>
              <input
                style="flex:1;padding:4px 8px;font-size:12px;border:1px solid var(--pw-border);border-radius:3px;background:var(--pw-bg);color:var(--pw-text)"
                placeholder="Label (e.g. Auto-commit)"
                value={p.label}
                onInput={(e) => updatePreference(idx, 'label', (e.target as HTMLInputElement).value)}
              />
              <input
                style="flex:2;padding:4px 8px;font-size:12px;border:1px solid var(--pw-border);border-radius:3px;background:var(--pw-bg);color:var(--pw-text)"
                placeholder="Prompt snippet appended when checked"
                value={p.promptSnippet}
                onInput={(e) => updatePreference(idx, 'promptSnippet', (e.target as HTMLInputElement).value)}
              />
              <button
                onClick={() => removePreference(idx)}
                style="padding:4px 8px;font-size:11px;border:1px solid var(--pw-border);border-radius:3px;background:var(--pw-bg);color:var(--pw-danger,#ef4444);cursor:pointer"
              >{'\u2715'}</button>
            </div>
          ))}
          <button class="btn btn-sm" onClick={addPreference}>+ Add Preference</button>
        </div>

        {/* Control Actions */}
        <div class="settings-section">
          <h3>Control Actions <AiAssistButton appId={appId} context="Shell commands shown as buttons in control bar" settingPath="controlActions" /></h3>
          <div class="settings-toggle-desc" style="margin-bottom:8px">
            Shell commands that appear as buttons in the control bar.
          </div>
          {actions.map((action, idx) => (
            <div key={action.id} style="display:flex;gap:6px;margin-bottom:8px;align-items:center">
              <input
                style="width:40px;padding:4px 6px;font-size:12px;border:1px solid var(--pw-border);border-radius:3px;background:var(--pw-bg);color:var(--pw-text);text-align:center"
                placeholder={'\uD83D\uDD28'}
                value={action.icon}
                onInput={(e) => updateAction(idx, 'icon', (e.target as HTMLInputElement).value)}
                maxLength={4}
              />
              <input
                style="flex:1;padding:4px 8px;font-size:12px;border:1px solid var(--pw-border);border-radius:3px;background:var(--pw-bg);color:var(--pw-text)"
                placeholder="Label"
                value={action.label}
                onInput={(e) => updateAction(idx, 'label', (e.target as HTMLInputElement).value)}
              />
              <input
                style="flex:2;padding:4px 8px;font-size:12px;border:1px solid var(--pw-border);border-radius:3px;background:var(--pw-bg);color:var(--pw-text);font-family:monospace"
                placeholder="Command (e.g. npm run build)"
                value={action.command}
                onInput={(e) => updateAction(idx, 'command', (e.target as HTMLInputElement).value)}
              />
              <button
                onClick={() => removeAction(idx)}
                style="padding:4px 8px;font-size:11px;border:1px solid var(--pw-border);border-radius:3px;background:var(--pw-bg);color:var(--pw-danger,#ef4444);cursor:pointer"
              >{'\u2715'}</button>
            </div>
          ))}
          <button class="btn btn-sm" onClick={addAction}>+ Add Action</button>
        </div>

        {/* Save */}
        <div style="display:flex;align-items:center;gap:8px;padding-top:12px;border-top:1px solid var(--pw-border)">
          <button class="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
          {saved && <span style="font-size:13px;color:var(--pw-text-muted)">Saved!</span>}
          <div style="flex:1" />
          <button class="btn btn-sm btn-danger" onClick={deleteApp}>Delete Application</button>
        </div>
      </div>
    </div>
  );
}
