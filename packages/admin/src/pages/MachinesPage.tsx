import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { api } from '../lib/api.js';
import { SetupAssistButton } from '../components/SetupAssistButton.js';
import { DeletedItemsPanel, trackDeletion } from '../components/DeletedItemsPanel.js';
import { cachedTargets, ensureTargetsLoaded } from '../components/DispatchTargetSelect.js';
import { spawnTerminal } from '../lib/sessions.js';
import { selectedAppId } from '../lib/state.js';

const machines = signal<any[]>([]);
const loading = signal(true);
const error = signal('');
const showForm = signal(false);
const editingId = signal<string | null>(null);
const formName = signal('');
const formHostname = signal('');
const formAddress = signal('');
const formType = signal<'local' | 'remote' | 'cloud'>('remote');
const formTags = signal('');
const formLoading = signal(false);
const formError = signal('');

async function loadMachines() {
  loading.value = true;
  error.value = '';
  try {
    machines.value = await api.getMachines();
  } catch (err: any) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

function resetForm() {
  formName.value = '';
  formHostname.value = '';
  formAddress.value = '';
  formType.value = 'remote';
  formTags.value = '';
  formError.value = '';
  editingId.value = null;
}

function openAdd() {
  resetForm();
  showForm.value = true;
}

function openEdit(m: any) {
  editingId.value = m.id;
  formName.value = m.name;
  formHostname.value = m.hostname || '';
  formAddress.value = m.address || '';
  formType.value = m.type || 'remote';
  formTags.value = (m.tags || []).join(', ');
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
      hostname: formHostname.value.trim() || null,
      address: formAddress.value.trim() || null,
      type: formType.value,
      tags: formTags.value.split(',').map(t => t.trim()).filter(Boolean),
    };
    if (editingId.value) {
      await api.updateMachine(editingId.value, data);
    } else {
      await api.createMachine(data);
    }
    showForm.value = false;
    resetForm();
    await loadMachines();
  } catch (err: any) {
    formError.value = err.message;
  } finally {
    formLoading.value = false;
  }
}

async function handleDelete(id: string, name: string) {
  try {
    await api.deleteMachine(id);
    trackDeletion('machines', id, name);
    await loadMachines();
  } catch (err: any) {
    error.value = err.message;
  }
}

export function MachinesPage() {
  useEffect(() => {
    loadMachines();
    ensureTargetsLoaded();
    const interval = setInterval(loadMachines, 10_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style="max-width:800px">
      <div class="page-header">
        <div>
          <h2>Machines</h2>
          <p style="font-size:13px;color:var(--pw-text-muted);margin-top:4px">
            Registered machines where harnesses and agent sessions can run.
          </p>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <SetupAssistButton entityType="machine" entityLabel="Machines" />
          <button class="btn btn-primary" onClick={openAdd}>Add Machine</button>
        </div>
      </div>

      {error.value && <div class="error-msg">{error.value}</div>}

      {showForm.value && (
        <div class="agent-form" style="margin-bottom:20px">
          <h3 style="margin-top:0">{editingId.value ? 'Edit Machine' : 'Add Machine'}</h3>
          {formError.value && <div class="error-msg">{formError.value}</div>}
          <div class="form-group">
            <label>Name</label>
            <input
              class="form-input"
              value={formName.value}
              onInput={(e) => formName.value = (e.target as HTMLInputElement).value}
              placeholder="Mac Mini Lab"
            />
          </div>
          <div class="form-group">
            <label>Hostname</label>
            <input
              class="form-input"
              value={formHostname.value}
              onInput={(e) => formHostname.value = (e.target as HTMLInputElement).value}
              placeholder="lab-mini.local"
            />
          </div>
          <div class="form-group">
            <label>Address</label>
            <input
              class="form-input"
              value={formAddress.value}
              onInput={(e) => formAddress.value = (e.target as HTMLInputElement).value}
              placeholder="10.0.0.5 or lab.tailnet"
            />
          </div>
          <div class="form-group">
            <label>Type</label>
            <select
              class="form-input"
              value={formType.value}
              onChange={(e) => formType.value = (e.target as HTMLSelectElement).value as any}
            >
              <option value="local">Local</option>
              <option value="remote">Remote</option>
              <option value="cloud">Cloud</option>
            </select>
          </div>
          <div class="form-group">
            <label>Tags (comma-separated)</label>
            <input
              class="form-input"
              value={formTags.value}
              onInput={(e) => formTags.value = (e.target as HTMLInputElement).value}
              placeholder="gpu, arm64, staging"
            />
          </div>
          <div style="display:flex;gap:8px;margin-top:12px">
            <button class="btn btn-primary" onClick={handleSubmit} disabled={formLoading.value}>
              {formLoading.value ? 'Saving...' : editingId.value ? 'Update' : 'Create'}
            </button>
            <button class="btn" onClick={() => { showForm.value = false; resetForm(); }}>Cancel</button>
          </div>
        </div>
      )}

      <div class="agent-list">
        {machines.value.map((m) => (
          <div class="agent-card" key={m.id}>
            <div class="agent-card-body">
              <div class="agent-card-top">
                <div class="agent-card-name">
                  {m.name}
                  <span
                    class="agent-badge"
                    style={`background:${m.status === 'online' ? 'var(--pw-success, #22c55e)' : 'var(--pw-text-faint)'};color:#fff;margin-left:8px`}
                  >
                    {m.status === 'online' ? 'ONLINE' : 'OFFLINE'}
                  </span>
                  <span class="agent-badge" style="background:var(--pw-bg-hover);color:var(--pw-text-muted);margin-left:4px">
                    {m.type}
                  </span>
                </div>
                <div style="display:flex;gap:6px;align-items:center">
                  {(() => {
                    const target = cachedTargets.value.find(t => t.machineId === m.id && !t.isHarness);
                    return target ? (
                      <button class="btn btn-sm" onClick={() => spawnTerminal(selectedAppId.value, target.launcherId)} title={`Open terminal on ${m.name}`}>Terminal</button>
                    ) : null;
                  })()}
                  <SetupAssistButton entityType="machine" entityId={m.id} entityLabel={m.name} />
                  <button class="btn btn-sm" onClick={() => openEdit(m)}>Edit</button>
                  <button class="btn btn-sm btn-danger" onClick={() => handleDelete(m.id, m.name)}>Delete</button>
                </div>
              </div>
              <div class="agent-card-meta">
                {m.hostname && <span class="agent-meta-tag">{m.hostname}</span>}
                {m.address && <span class="agent-meta-tag">{m.address}</span>}
                {m.capabilities?.hasDocker && <span class="agent-meta-tag">Docker</span>}
                {m.capabilities?.hasTmux && <span class="agent-meta-tag">tmux</span>}
                {m.capabilities?.hasClaudeCli && <span class="agent-meta-tag">Claude CLI</span>}
              </div>
              {m.tags?.length > 0 && (
                <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">
                  {m.tags.map((tag: string) => (
                    <span key={tag} style="font-size:11px;padding:1px 6px;border-radius:3px;background:var(--pw-primary)20;color:var(--pw-primary)">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              {m.lastSeenAt && (
                <div style="margin-top:6px;font-size:11px;color:var(--pw-text-faint)">
                  Last seen: {new Date(m.lastSeenAt).toLocaleString()}
                </div>
              )}
            </div>
          </div>
        ))}
        {machines.value.length === 0 && !loading.value && (
          <div class="agent-empty">
            <div class="agent-empty-icon">{'\u{1F5A5}'}</div>
            <div class="agent-empty-title">No machines registered</div>
            <div class="agent-empty-desc">
              Add a machine to start deploying harnesses remotely.
            </div>
          </div>
        )}
      </div>
      <DeletedItemsPanel type="machines" />
    </div>
  );
}
