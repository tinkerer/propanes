import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { api } from '../lib/api.js';
import { DeletedItemsPanel, trackDeletion } from '../components/DeletedItemsPanel.js';
import { SetupAssistButton } from '../components/SetupAssistButton.js';

const spriteConfigs = signal<any[]>([]);
const applications = signal<any[]>([]);
const loading = signal(true);
const error = signal('');
const showForm = signal(false);
const editingId = signal<string | null>(null);
const formName = signal('');
const formSpriteName = signal('');
const formToken = signal('');
const formMaxSessions = signal('3');
const formDefaultCwd = signal('');
const formAppId = signal('');
const formProvisionNow = signal(true);
const formLoading = signal(false);
const formError = signal('');

async function loadAll() {
  loading.value = true;
  error.value = '';
  try {
    const [configs, appList] = await Promise.all([
      api.getSpriteConfigs(),
      api.getApplications().catch(() => []),
    ]);
    spriteConfigs.value = configs;
    applications.value = appList;
  } catch (err: any) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

function resetForm() {
  formName.value = '';
  formSpriteName.value = '';
  formToken.value = '';
  formMaxSessions.value = '3';
  formDefaultCwd.value = '';
  formAppId.value = '';
  formProvisionNow.value = true;
  formError.value = '';
  editingId.value = null;
}

function openAdd() {
  resetForm();
  showForm.value = true;
}

function openEdit(s: any) {
  editingId.value = s.id;
  formName.value = s.name;
  formSpriteName.value = s.spriteName;
  formToken.value = s.token || '';
  formMaxSessions.value = String(s.maxSessions);
  formDefaultCwd.value = s.defaultCwd || '';
  formAppId.value = s.appId || '';
  formProvisionNow.value = false;
  formError.value = '';
  showForm.value = true;
}

async function handleSubmit() {
  if (!formName.value.trim()) {
    formError.value = 'Name is required';
    return;
  }
  formLoading.value = true;
  formError.value = '';
  try {
    const data: Record<string, unknown> = {
      name: formName.value.trim(),
      spriteName: formSpriteName.value.trim() || undefined,
      token: formToken.value.trim() || null,
      maxSessions: parseInt(formMaxSessions.value) || 3,
      defaultCwd: formDefaultCwd.value.trim() || null,
      appId: formAppId.value || null,
    };
    if (editingId.value) {
      await api.updateSpriteConfig(editingId.value, data);
    } else {
      data.provisionNow = formProvisionNow.value;
      await api.createSpriteConfig(data);
    }
    showForm.value = false;
    resetForm();
    await loadAll();
  } catch (err: any) {
    formError.value = err.message;
  } finally {
    formLoading.value = false;
  }
}

async function handleDelete(id: string, name: string) {
  try {
    await api.deleteSpriteConfig(id);
    trackDeletion('sprites', id, name);
    await loadAll();
  } catch (err: any) {
    error.value = err.message;
  }
}

async function handleProvision(id: string) {
  try {
    await api.provisionSprite(id);
    await loadAll();
  } catch (err: any) {
    error.value = err.message;
  }
}

async function handleDestroy(id: string) {
  try {
    await api.destroySprite(id);
    await loadAll();
  } catch (err: any) {
    error.value = err.message;
  }
}

async function handleCheckStatus(id: string) {
  try {
    await api.checkSpriteStatus(id);
    await loadAll();
  } catch (err: any) {
    error.value = err.message;
  }
}

async function handleLaunchSession(id: string) {
  try {
    const result = await api.launchSpriteSession(id, { permissionProfile: 'interactive' });
    if (result.sessionId) {
      window.location.hash = '#/sessions';
    }
  } catch (err: any) {
    error.value = err.message;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'running': case 'warm': return 'var(--pw-success, #22c55e)';
    case 'cold': return 'var(--pw-primary, #3b82f6)';
    case 'error': return 'var(--pw-danger, #ef4444)';
    case 'destroyed': return 'var(--pw-text-faint)';
    default: return 'var(--pw-text-muted)';
  }
}

function getAppName(appId: string | null): string {
  if (!appId) return '';
  const app = applications.value.find(a => a.id === appId);
  return app?.name || appId.slice(0, 8);
}

export function SpritesPage() {
  useEffect(() => {
    loadAll();
    const interval = setInterval(loadAll, 10_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style="max-width:900px">
      <div class="page-header">
        <div>
          <h2>Sprites</h2>
          <p style="font-size:13px;color:var(--pw-text-muted);margin-top:4px">
            Fly.io Sprites — stateful cloud VMs with persistent storage and auto-sleep.
          </p>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <SetupAssistButton entityType="sprite" entityLabel="New Sprite" />
          <button class="btn btn-primary" onClick={openAdd}>Create Sprite</button>
        </div>
      </div>

      {error.value && <div class="error-msg">{error.value}</div>}

      {showForm.value && (
        <div class="agent-form" style="margin-bottom:20px">
          <h3 style="margin-top:0">{editingId.value ? 'Edit Sprite' : 'Create Sprite'}</h3>
          {formError.value && <div class="error-msg">{formError.value}</div>}
          <div class="form-group">
            <label>Display Name</label>
            <input
              class="form-input"
              value={formName.value}
              onInput={(e) => formName.value = (e.target as HTMLInputElement).value}
              placeholder="My Sprite"
            />
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="form-group">
              <label>Sprite Name <span style="font-size:11px;color:var(--pw-text-muted)">(API identifier)</span></label>
              <input
                class="form-input"
                value={formSpriteName.value}
                onInput={(e) => formSpriteName.value = (e.target as HTMLInputElement).value}
                placeholder="my-sprite"
              />
            </div>
            <div class="form-group">
              <label>Application</label>
              <select
                class="form-input"
                value={formAppId.value}
                onChange={(e) => formAppId.value = (e.target as HTMLSelectElement).value}
              >
                <option value="">-- None --</option>
                {applications.value.map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div class="form-group">
            <label>Token <span style="font-size:11px;color:var(--pw-text-muted)">(optional — falls back to SPRITES_TOKEN env)</span></label>
            <input
              class="form-input"
              type="password"
              value={formToken.value}
              onInput={(e) => formToken.value = (e.target as HTMLInputElement).value}
              placeholder="sprites_..."
            />
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="form-group">
              <label>Max Sessions</label>
              <input
                class="form-input"
                type="number"
                value={formMaxSessions.value}
                onInput={(e) => formMaxSessions.value = (e.target as HTMLInputElement).value}
                placeholder="3"
              />
            </div>
            <div class="form-group">
              <label>Default CWD</label>
              <input
                class="form-input"
                value={formDefaultCwd.value}
                onInput={(e) => formDefaultCwd.value = (e.target as HTMLInputElement).value}
                placeholder="/home/user/project"
              />
            </div>
          </div>
          {!editingId.value && (
            <div class="form-group" style="margin-top:8px">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                <input
                  type="checkbox"
                  checked={formProvisionNow.value}
                  onChange={(e) => formProvisionNow.value = (e.target as HTMLInputElement).checked}
                />
                Provision now
                <span style="font-size:11px;color:var(--pw-text-muted)">(create the sprite via Fly.io API immediately)</span>
              </label>
            </div>
          )}
          <div style="display:flex;gap:8px;margin-top:12px">
            <button class="btn btn-primary" onClick={handleSubmit} disabled={formLoading.value}>
              {formLoading.value ? 'Saving...' : editingId.value ? 'Update' : 'Create'}
            </button>
            <button class="btn" onClick={() => { showForm.value = false; resetForm(); }}>Cancel</button>
          </div>
        </div>
      )}

      <div class="agent-list">
        {spriteConfigs.value.map((s) => (
          <div class="agent-card" key={s.id}>
            <div class="agent-card-body">
              <div class="agent-card-top">
                <div class="agent-card-name">
                  {s.name}
                  <span
                    class="agent-badge"
                    style={`background:${statusColor(s.status)};color:#fff;margin-left:8px`}
                  >
                    {s.status.toUpperCase()}
                  </span>
                </div>
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                  {(s.status === 'unknown' || s.status === 'destroyed' || s.status === 'error') && (
                    <button class="btn btn-sm btn-primary" onClick={() => handleProvision(s.id)}>
                      Provision
                    </button>
                  )}
                  {s.status !== 'unknown' && s.status !== 'destroyed' && s.status !== 'error' && (
                    <>
                      <button class="btn btn-sm btn-primary" onClick={() => handleLaunchSession(s.id)}>
                        Launch Session
                      </button>
                      <button class="btn btn-sm" onClick={() => handleDestroy(s.id)}>
                        Destroy
                      </button>
                    </>
                  )}
                  <button class="btn btn-sm" onClick={() => handleCheckStatus(s.id)}>
                    Check Status
                  </button>
                  <SetupAssistButton entityType="sprite" entityId={s.id} entityLabel={s.name} />
                  <button class="btn btn-sm" onClick={() => openEdit(s)}>Edit</button>
                  <button class="btn btn-sm btn-danger" onClick={() => handleDelete(s.id, s.name)}>Delete</button>
                </div>
              </div>
              <div class="agent-card-meta">
                <span class="agent-meta-tag">{s.spriteName}</span>
                {s.appId && <span class="agent-meta-tag" style="border-color:var(--pw-primary)40;color:var(--pw-primary)">{getAppName(s.appId)}</span>}
                {s.activeSessions > 0 && (
                  <span class="agent-meta-tag" style="border-color:var(--pw-success, #22c55e)40;color:var(--pw-success, #22c55e)">
                    {s.activeSessions}/{s.maxSessions} sessions
                  </span>
                )}
                {s.token && (
                  <span class="agent-meta-tag" style="border-color:var(--pw-success, #22c55e)40;color:var(--pw-success, #22c55e)">
                    Token set
                  </span>
                )}
              </div>
              {s.spriteUrl && (
                <div style="margin-top:8px;font-size:12px;color:var(--pw-text-muted)">
                  <span style="font-weight:500;color:var(--pw-text)">URL: </span>
                  <a href={s.spriteUrl} target="_blank" rel="noopener" style="color:var(--pw-primary)">{s.spriteUrl}</a>
                </div>
              )}
              {s.errorMessage && (
                <div style="margin-top:6px;font-size:12px;color:var(--pw-danger, #ef4444);background:var(--pw-danger, #ef4444)10;padding:4px 8px;border-radius:4px">
                  {s.errorMessage}
                </div>
              )}
              <div style="margin-top:6px;font-size:11px;color:var(--pw-text-faint)">
                Created {new Date(s.createdAt).toLocaleString()}
                {s.lastCheckedAt && <span> &middot; Last checked {new Date(s.lastCheckedAt).toLocaleString()}</span>}
              </div>
            </div>
          </div>
        ))}
        {spriteConfigs.value.length === 0 && !loading.value && (
          <div class="agent-empty">
            <div class="agent-empty-icon">{'\u2601\uFE0F'}</div>
            <div class="agent-empty-title">No sprite configs</div>
            <div class="agent-empty-desc">
              Create a sprite config to deploy stateful cloud VMs on Fly.io for running Claude sessions.
            </div>
          </div>
        )}
      </div>
      <DeletedItemsPanel type="sprites" />
    </div>
  );
}
