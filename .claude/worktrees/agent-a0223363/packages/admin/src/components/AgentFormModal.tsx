import { useState } from 'preact/hooks';
import { api } from '../lib/api.js';
import { DEFAULT_PROMPT_TEMPLATE, TOOL_PRESETS, PROFILE_DESCRIPTIONS } from '../lib/agent-constants.js';

interface AgentFormModalProps {
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
  editAgent?: any;
  applications: any[];
  fixedAppId?: string;
}

export function AgentFormModal({ visible, onClose, onSaved, editAgent, applications, fixedAppId }: AgentFormModalProps) {
  const [formName, setFormName] = useState(editAgent?.name || '');
  const [formUrl, setFormUrl] = useState(editAgent?.url || '');
  const [formAuth, setFormAuth] = useState(editAgent?.authHeader || '');
  const [formDefault, setFormDefault] = useState(editAgent?.isDefault || false);
  const [formAppId, setFormAppId] = useState(fixedAppId || editAgent?.appId || '');
  const [formMode, setFormMode] = useState<'webhook' | 'headless' | 'interactive'>(editAgent?.mode || 'interactive');
  const [formPromptTemplate, setFormPromptTemplate] = useState(editAgent?.promptTemplate || DEFAULT_PROMPT_TEMPLATE);
  const [formPermissionProfile, setFormPermissionProfile] = useState<'interactive' | 'auto' | 'yolo'>(editAgent?.permissionProfile || 'interactive');
  const [formAllowedTools, setFormAllowedTools] = useState(editAgent?.allowedTools || '');
  const [formAutoPlan, setFormAutoPlan] = useState(editAgent?.autoPlan || false);
  const [formError, setFormError] = useState('');
  const [formLoading, setFormLoading] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(
    !!(editAgent && (editAgent.mode === 'webhook' || (editAgent.promptTemplate && editAgent.promptTemplate !== DEFAULT_PROMPT_TEMPLATE) || editAgent.allowedTools || editAgent.url))
  );
  const [showToolPresets, setShowToolPresets] = useState(false);

  if (!visible) return null;

  function addToolPreset(value: string) {
    const current = formAllowedTools.trim();
    const existing = current.split(',').map(s => s.trim()).filter(Boolean);
    const adding = value.split(',').map(s => s.trim()).filter(Boolean);
    const merged = [...existing];
    for (const tool of adding) {
      if (!merged.includes(tool)) merged.push(tool);
    }
    setFormAllowedTools(merged.join(', '));
    setShowToolPresets(false);
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    setFormError('');
    setFormLoading(true);

    const data: Record<string, unknown> = {
      name: formName,
      url: formUrl || undefined,
      authHeader: formAuth || undefined,
      isDefault: formDefault,
      appId: formAppId || undefined,
      mode: formMode,
      promptTemplate: (formPromptTemplate && formPromptTemplate !== DEFAULT_PROMPT_TEMPLATE) ? formPromptTemplate : undefined,
      permissionProfile: formPermissionProfile,
      allowedTools: formAllowedTools || undefined,
      autoPlan: formAutoPlan,
    };

    try {
      if (editAgent) {
        await api.updateAgent(editAgent.id, data);
      } else {
        await api.createAgent(data);
      }
      onSaved();
      onClose();
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setFormLoading(false);
    }
  }

  return (
    <div class="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form class="modal agent-modal" onSubmit={handleSubmit}>
        <h3>{editAgent ? 'Edit' : 'Add'} Agent</h3>
        {formError && <div class="error-msg">{formError}</div>}

        <div class="agent-form-grid">
          <div class="form-group">
            <label>Name</label>
            <input
              type="text"
              value={formName}
              onInput={(e) => setFormName((e.target as HTMLInputElement).value)}
              placeholder="e.g., My Laptop, Cloud Server, Dev Box"
              required
              style="width:100%"
            />
            <span class="form-hint">Where Claude Code runs</span>
          </div>
          <div class="form-group">
            <label>Application</label>
            <select
              value={formAppId}
              onChange={(e) => setFormAppId((e.target as HTMLSelectElement).value)}
              style="width:100%"
              disabled={!!fixedAppId}
            >
              <option value="">Global (all apps)</option>
              {applications.map((app) => (
                <option value={app.id} key={app.id}>{app.name}</option>
              ))}
            </select>
          </div>
        </div>

        {formMode !== 'webhook' && (
          <div class="form-group">
            <label>Permission Level</label>
            <div class="permission-grid">
              {(['interactive', 'auto', 'yolo'] as const).map((p) => {
                const info = PROFILE_DESCRIPTIONS[p];
                const selected = formPermissionProfile === p;
                return (
                  <label key={p} class={`permission-option ${selected ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="permissionProfile"
                      value={p}
                      checked={selected}
                      onChange={() => setFormPermissionProfile(p)}
                      style="display:none"
                    />
                    <span class="permission-icon">{info.icon}</span>
                    <span class="permission-label">{info.label}</span>
                    <span class="permission-desc">{info.desc}</span>
                  </label>
                );
              })}
            </div>
            {formPermissionProfile === 'yolo' && (
              <div class="permission-warning">
                Full Auto skips ALL permission checks. Only use in sandboxed/Docker environments.
              </div>
            )}
          </div>
        )}

        {formMode !== 'webhook' && formPermissionProfile !== 'yolo' && (
          <div class="form-group">
            <label style="display:flex;align-items:center;gap:8px">
              Allowed Tools
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
              value={formAllowedTools}
              onInput={(e) => setFormAllowedTools((e.target as HTMLTextAreaElement).value)}
              onFocus={() => setShowToolPresets(false)}
              placeholder="Edit, Read, Bash(git *), ..."
              style="width:100%;min-height:60px;font-family:'SF Mono',Monaco,Menlo,monospace;font-size:12px"
            />
            <span class="form-hint">
              {formPermissionProfile === 'interactive'
                ? 'Pre-approved tools that won\'t require manual approval'
                : 'Comma-separated list of tools for --allowedTools'}
            </span>
          </div>
        )}

        <div class="agent-form-row">
          <label class="agent-checkbox-label">
            <input
              type="checkbox"
              checked={formDefault}
              onChange={(e) => setFormDefault((e.target as HTMLInputElement).checked)}
            />
            <span>Default agent</span>
            <span class="form-hint" style="margin-left:0">— used automatically when dispatching</span>
          </label>
        </div>

        <details class="agent-advanced" open={showAdvanced || undefined}
          onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}>
          <summary>Advanced options</summary>
          <div class="agent-advanced-body">
            <div class="form-group">
              <label>Mode</label>
              <select
                value={formMode}
                onChange={(e) => setFormMode((e.target as HTMLSelectElement).value as any)}
                style="width:100%"
              >
                <option value="interactive">Claude Code (interactive)</option>
                <option value="headless">Claude Code (headless)</option>
                <option value="webhook">Webhook</option>
              </select>
            </div>
            {formMode === 'webhook' && (
              <>
                <div class="form-group">
                  <label>URL</label>
                  <input
                    type="url"
                    value={formUrl}
                    onInput={(e) => setFormUrl((e.target as HTMLInputElement).value)}
                    placeholder="https://agent.example.com/webhook"
                    style="width:100%"
                  />
                </div>
                <div class="form-group">
                  <label>Authorization Header</label>
                  <input
                    type="text"
                    value={formAuth}
                    onInput={(e) => setFormAuth((e.target as HTMLInputElement).value)}
                    placeholder="Bearer sk-..."
                    style="width:100%"
                  />
                </div>
              </>
            )}
            {formMode !== 'webhook' && (
              <>
                <div class="form-group">
                  <label>Prompt Template</label>
                  <textarea
                    value={formPromptTemplate}
                    onInput={(e) => setFormPromptTemplate((e.target as HTMLTextAreaElement).value)}
                    style="width:100%;min-height:160px;font-family:monospace;font-size:12px"
                  />
                  <span style="font-size:11px;color:var(--pw-text-faint)">
                    Variables: {'{{feedback.id}}'}, {'{{feedback.title}}'}, {'{{feedback.description}}'}, {'{{feedback.sourceUrl}}'}, {'{{feedback.tags}}'}, {'{{feedback.consoleLogs}}'}, {'{{feedback.networkErrors}}'}, {'{{feedback.data}}'}, {'{{feedback.screenshot}}'}, {'{{app.name}}'}, {'{{app.projectDir}}'}, {'{{app.description}}'}, {'{{instructions}}'}
                  </span>
                </div>
                <label class="agent-checkbox-label">
                  <input
                    type="checkbox"
                    checked={formAutoPlan}
                    onChange={(e) => setFormAutoPlan((e.target as HTMLInputElement).checked)}
                  />
                  <span>Auto-plan</span>
                  <span class="form-hint" style="margin-left:0">— agent creates a plan before implementing</span>
                </label>
              </>
            )}
          </div>
        </details>

        <div class="modal-actions">
          <button type="button" class="btn" onClick={onClose}>Cancel</button>
          <button type="submit" class="btn btn-primary" disabled={formLoading}>
            {formLoading ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
