import { signal } from '@preact/signals';
import { api } from '../lib/api.js';
import { SetupAssistButton } from '../components/SetupAssistButton.js';
import { trackDeletion } from '../components/DeletedItemsPanel.js';
import {
  applications, loading, error, loadAll, closeAllForms,
  spriteStatusColor, getRepoName, AppLink, SharedRepoBadge,
} from '../pages/InfrastructurePage.js';

// Sprite form state
export const showSpriteForm = signal(false);
const spriteEditingId = signal<string | null>(null);
const sFormName = signal('');
const sFormSpriteName = signal('');
const sFormToken = signal('');
const sFormMaxSessions = signal('3');
const sFormDefaultCwd = signal('');
const sFormAppId = signal('');
const sFormProvisionNow = signal(true);
const sFormLoading = signal(false);
const sFormError = signal('');

function resetSpriteForm() {
  sFormName.value = '';
  sFormSpriteName.value = '';
  sFormToken.value = '';
  sFormMaxSessions.value = '3';
  sFormDefaultCwd.value = '';
  sFormAppId.value = '';
  sFormProvisionNow.value = true;
  sFormError.value = '';
  spriteEditingId.value = null;
}

export function openAddSprite() {
  resetSpriteForm();
  closeAllForms();
  showSpriteForm.value = true;
}

function openEditSprite(s: any) {
  spriteEditingId.value = s.id;
  sFormName.value = s.name;
  sFormSpriteName.value = s.spriteName;
  sFormToken.value = s.token || '';
  sFormMaxSessions.value = String(s.maxSessions);
  sFormDefaultCwd.value = s.defaultCwd || '';
  sFormAppId.value = s.appId || '';
  sFormProvisionNow.value = false;
  sFormError.value = '';
  showSpriteForm.value = true;
}

async function handleSpriteSubmit() {
  if (!sFormName.value.trim()) { sFormError.value = 'Name is required'; return; }
  sFormLoading.value = true;
  sFormError.value = '';
  try {
    const data: Record<string, unknown> = {
      name: sFormName.value.trim(),
      spriteName: sFormSpriteName.value.trim() || undefined,
      token: sFormToken.value.trim() || null,
      maxSessions: parseInt(sFormMaxSessions.value) || 3,
      defaultCwd: sFormDefaultCwd.value.trim() || null,
      appId: sFormAppId.value || null,
    };
    if (spriteEditingId.value) {
      await api.updateSpriteConfig(spriteEditingId.value, data);
    } else {
      data.provisionNow = sFormProvisionNow.value;
      await api.createSpriteConfig(data);
    }
    showSpriteForm.value = false;
    resetSpriteForm();
    await loadAll();
  } catch (err: any) {
    sFormError.value = err.message;
  } finally {
    sFormLoading.value = false;
  }
}

async function handleSpriteDelete(id: string, name: string) {
  try { await api.deleteSpriteConfig(id); trackDeletion('sprites', id, name); await loadAll(); } catch (err: any) { error.value = err.message; }
}

async function handleSpriteProvision(id: string) {
  try { await api.provisionSprite(id); await loadAll(); } catch (err: any) { error.value = err.message; }
}

async function handleSpriteDestroy(id: string) {
  try { await api.destroySprite(id); await loadAll(); } catch (err: any) { error.value = err.message; }
}

async function handleSpriteCheckStatus(id: string) {
  try { await api.checkSpriteStatus(id); await loadAll(); } catch (err: any) { error.value = err.message; }
}

async function handleSpriteLaunchSession(id: string) {
  try {
    const result = await api.launchSpriteSession(id, { permissionProfile: 'interactive' });
    if (result.sessionId) window.location.hash = '#/sessions';
  } catch (err: any) { error.value = err.message; }
}

export function SpriteForm() {
  return (
    <div class="agent-form" style="margin-bottom:20px">
      <h3 style="margin-top:0">{spriteEditingId.value ? 'Edit Sprite' : 'Create Sprite'}</h3>
      {sFormError.value && <div class="error-msg">{sFormError.value}</div>}
      <div class="form-group">
        <label>Display Name</label>
        <input class="form-input" value={sFormName.value} onInput={(e) => sFormName.value = (e.target as HTMLInputElement).value} placeholder="My Sprite" />
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-group">
          <label>Sprite Name <span style="font-size:11px;color:var(--pw-text-muted)">(API identifier)</span></label>
          <input class="form-input" value={sFormSpriteName.value} onInput={(e) => sFormSpriteName.value = (e.target as HTMLInputElement).value} placeholder="my-sprite" />
        </div>
        <div class="form-group">
          <label>Application</label>
          <select class="form-input" value={sFormAppId.value} onChange={(e) => sFormAppId.value = (e.target as HTMLSelectElement).value}>
            <option value="">-- None --</option>
            {applications.value.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>Token <span style="font-size:11px;color:var(--pw-text-muted)">(optional)</span></label>
        <input class="form-input" type="password" value={sFormToken.value} onInput={(e) => sFormToken.value = (e.target as HTMLInputElement).value} placeholder="sprites_..." />
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-group">
          <label>Max Sessions</label>
          <input class="form-input" type="number" value={sFormMaxSessions.value} onInput={(e) => sFormMaxSessions.value = (e.target as HTMLInputElement).value} placeholder="3" />
        </div>
        <div class="form-group">
          <label>Default CWD</label>
          <input class="form-input" value={sFormDefaultCwd.value} onInput={(e) => sFormDefaultCwd.value = (e.target as HTMLInputElement).value} placeholder="/home/user/project" />
        </div>
      </div>
      {!spriteEditingId.value && (
        <div class="form-group" style="margin-top:8px">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" checked={sFormProvisionNow.value} onChange={(e) => sFormProvisionNow.value = (e.target as HTMLInputElement).checked} />
            Provision now
            <span style="font-size:11px;color:var(--pw-text-muted)">(create via Fly.io API immediately)</span>
          </label>
        </div>
      )}
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-primary" onClick={handleSpriteSubmit} disabled={sFormLoading.value}>
          {sFormLoading.value ? 'Saving...' : spriteEditingId.value ? 'Update' : 'Create'}
        </button>
        <button class="btn" onClick={() => { showSpriteForm.value = false; resetSpriteForm(); }}>Cancel</button>
      </div>
    </div>
  );
}

export function SpriteCard({ s }: { s: any }) {
  return (
    <div class="agent-card" key={s.id}>
      <div class="agent-card-body">
        <div class="agent-card-top">
          <div class="agent-card-name">
            {s.name}
            <span class="agent-badge" style={`background:${spriteStatusColor(s.status)};color:#fff;margin-left:8px`}>
              {s.status.toUpperCase()}
            </span>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            {(s.status === 'unknown' || s.status === 'destroyed' || s.status === 'error') && (
              <button class="btn btn-sm btn-primary" onClick={() => handleSpriteProvision(s.id)}>Provision</button>
            )}
            {s.status !== 'unknown' && s.status !== 'destroyed' && s.status !== 'error' && (
              <>
                <button class="btn btn-sm btn-primary" onClick={() => handleSpriteLaunchSession(s.id)}>Launch Session</button>
                <button class="btn btn-sm" onClick={() => handleSpriteDestroy(s.id)}>Destroy</button>
              </>
            )}
            <button class="btn btn-sm" onClick={() => handleSpriteCheckStatus(s.id)}>Check Status</button>
            <SetupAssistButton entityType="sprite" entityId={s.id} entityLabel={s.name} />
            <button class="btn btn-sm" onClick={() => openEditSprite(s)}>Edit</button>
            <button class="btn btn-sm btn-danger" onClick={() => handleSpriteDelete(s.id, s.name)}>Delete</button>
          </div>
        </div>
        <div class="agent-card-meta">
          <span class="agent-meta-tag">{s.spriteName}</span>
          {s.appId && (() => {
            const app = applications.value.find(a => a.id === s.appId);
            return app ? (
              <span class="agent-meta-tag" style="border-color:var(--pw-primary)40;color:var(--pw-primary)">
                <AppLink app={app} />
              </span>
            ) : (
              <span class="agent-meta-tag" style="border-color:var(--pw-primary)40;color:var(--pw-primary)">{s.appId.slice(0, 8)}</span>
            );
          })()}
          {s.activeSessions > 0 && (
            <span class="agent-meta-tag" style="border-color:var(--pw-success, #22c55e)40;color:var(--pw-success, #22c55e)">
              {s.activeSessions}/{s.maxSessions} sessions
            </span>
          )}
          {s.token && <span class="agent-meta-tag" style="border-color:var(--pw-success, #22c55e)40;color:var(--pw-success, #22c55e)">Token set</span>}
        </div>
        {s.appId && (() => {
          const app = applications.value.find(a => a.id === s.appId);
          if (!app?.projectDir) return null;
          return (
            <div style="margin-top:6px;font-size:12px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <span style="color:var(--pw-text-faint);font-size:11px">{getRepoName(app.projectDir)}</span>
              <SharedRepoBadge repoKey={app.projectDir} currentInfraId={s.id} />
            </div>
          );
        })()}
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
  );
}
