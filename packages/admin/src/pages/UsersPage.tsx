import { useEffect, useState } from 'preact/hooks';
import { api } from '../lib/api.js';

type UserRow = {
  id: string;
  username: string;
  role: 'admin' | 'member';
  status: 'active' | 'disabled';
  orgId: string | null;
  launcherId: string | null;
};

export function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [orgs, setOrgs] = useState<any[]>([]);
  const [targets, setTargets] = useState<any[]>([]);
  const [draft, setDraft] = useState({ username: '', password: '', role: 'member', orgId: '', launcherId: '' });
  const [newOrgName, setNewOrgName] = useState('');
  const [resetPasswords, setResetPasswords] = useState<Record<string, string>>({});
  const [podStatus, setPodStatus] = useState<Record<string, { exists: boolean; replicas: number; readyReplicas: number; available: boolean; message?: string }>>({});
  const [podBusy, setPodBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');

  async function load() {
    const [u, o, t] = await Promise.all([
      api.getUsers(),
      api.getOrgs(),
      api.getDispatchTargets().catch(() => ({ targets: [] })),
    ]);
    setUsers(u.users);
    setOrgs(o.orgs);
    setTargets(t.targets || []);
  }

  useEffect(() => {
    load().catch((err) => setError(err.message || 'Failed to load users'));
  }, []);

  // Fetch each member's pod status once the user list is in.
  useEffect(() => {
    users.filter((u) => u.role === 'member').forEach((u) => refreshPodStatus(u.id));
  }, [users.map((u) => u.id).join(',')]);

  async function createUser(e: Event) {
    e.preventDefault();
    setError('');
    try {
      await api.createUser({
        username: draft.username,
        password: draft.password,
        role: draft.role,
        orgId: draft.orgId || null,
        launcherId: draft.launcherId || null,
      });
      setDraft({ username: '', password: '', role: 'member', orgId: '', launcherId: '' });
      await load();
    } catch (err: any) {
      setError(err.message || 'Failed to create user');
    }
  }

  async function patchUser(id: string, patch: Record<string, unknown>) {
    setError('');
    try {
      await api.updateUser(id, patch);
      await load();
    } catch (err: any) {
      setError(err.message || 'Failed to update user');
    }
  }

  async function createOrg() {
    const name = newOrgName.trim();
    if (!name) return;
    setError('');
    try {
      await api.createOrg({ name });
      setNewOrgName('');
      await load();
    } catch (err: any) {
      setError(err.message || 'Failed to create org');
    }
  }

  async function resetPassword(id: string) {
    const password = resetPasswords[id] || '';
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    setError('');
    try {
      await api.resetUserPassword(id, password);
      setResetPasswords((prev) => ({ ...prev, [id]: '' }));
    } catch (err: any) {
      setError(err.message || 'Failed to reset password');
    }
  }

  async function refreshPodStatus(id: string) {
    try {
      const s = await api.getUserPodStatus(id);
      setPodStatus((prev) => ({ ...prev, [id]: s }));
    } catch {
      /* non-fatal */
    }
  }

  async function provisionPod(id: string) {
    setError('');
    setPodBusy((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await api.provisionUserPod(id);
      if (!res.ok) {
        const failed = (res.resources || []).filter((r: any) => r.action === 'error');
        setError(`Provision incomplete: ${failed.map((r: any) => `${r.kind} ${r.error}`).join('; ') || 'unknown error'}`);
      }
      await load();
      await refreshPodStatus(id);
    } catch (err: any) {
      setError(err.message || 'Failed to provision pod');
    } finally {
      setPodBusy((prev) => ({ ...prev, [id]: false }));
    }
  }

  async function deprovisionPod(id: string) {
    if (!confirm('Tear down this user’s launcher pod? Their private credential disk is kept unless you delete it separately.')) return;
    setError('');
    setPodBusy((prev) => ({ ...prev, [id]: true }));
    try {
      await api.deprovisionUserPod(id);
      await load();
      await refreshPodStatus(id);
    } catch (err: any) {
      setError(err.message || 'Failed to deprovision pod');
    } finally {
      setPodBusy((prev) => ({ ...prev, [id]: false }));
    }
  }

  const orgName = (id: string | null) => orgs.find((o) => o.id === id)?.name || 'No org';

  function podBadge(id: string) {
    const s = podStatus[id];
    if (!s) return null;
    if (!s.available) return <span style="font-size:11px;color:var(--pw-text-muted)">provisioning n/a</span>;
    if (!s.exists) return <span style="font-size:11px;color:var(--pw-text-muted)">no pod</span>;
    const ready = s.readyReplicas > 0;
    return (
      <span style={`font-size:11px;color:${ready ? 'var(--pw-ok,#3fb950)' : 'var(--pw-text-muted)'}`}>
        pod {ready ? 'ready' : 'pending'} ({s.readyReplicas}/{s.replicas})
      </span>
    );
  }

  return (
    <div style="max-width:960px">
      <div class="page-header">
        <div>
          <h2>Users</h2>
          <p style="font-size:13px;color:var(--pw-text-muted);margin-top:4px">
            Admin accounts, member tenancy, and assigned launchers.
          </p>
        </div>
      </div>

      {error && <div class="error-msg" style="margin-bottom:12px">{error}</div>}

      <form class="settings-section" onSubmit={createUser}>
        <h3>Create User</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;align-items:end">
          <label>
            <span style="display:block;font-size:12px;color:var(--pw-text-muted);margin-bottom:4px">Username</span>
            <input value={draft.username} onInput={(e) => setDraft({ ...draft, username: (e.currentTarget as HTMLInputElement).value })} />
          </label>
          <label>
            <span style="display:block;font-size:12px;color:var(--pw-text-muted);margin-bottom:4px">Password</span>
            <input type="password" value={draft.password} onInput={(e) => setDraft({ ...draft, password: (e.currentTarget as HTMLInputElement).value })} />
          </label>
          <label>
            <span style="display:block;font-size:12px;color:var(--pw-text-muted);margin-bottom:4px">Role</span>
            <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: (e.currentTarget as HTMLSelectElement).value })}>
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <label>
            <span style="display:block;font-size:12px;color:var(--pw-text-muted);margin-bottom:4px">Org</span>
            <select value={draft.orgId} onChange={(e) => setDraft({ ...draft, orgId: (e.currentTarget as HTMLSelectElement).value })}>
              <option value="">No org</option>
              {orgs.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
            </select>
          </label>
          <label>
            <span style="display:block;font-size:12px;color:var(--pw-text-muted);margin-bottom:4px">Launcher</span>
            <select value={draft.launcherId} onChange={(e) => setDraft({ ...draft, launcherId: (e.currentTarget as HTMLSelectElement).value })}>
              <option value="">Any launcher</option>
              {targets.map((t) => <option key={t.launcherId} value={t.launcherId}>{t.name}</option>)}
            </select>
          </label>
          <button class="btn btn-primary" disabled={!draft.username.trim() || draft.password.length < 6}>Create</button>
        </div>
      </form>

      <div class="settings-section">
        <h3>Organizations</h3>
        <div style="display:flex;gap:8px;max-width:360px">
          <input style="flex:1" placeholder="Org name" value={newOrgName} onInput={(e) => setNewOrgName((e.currentTarget as HTMLInputElement).value)} />
          <button class="btn btn-sm" onClick={createOrg} disabled={!newOrgName.trim()}>Add</button>
        </div>
      </div>

      <div class="settings-section">
        <h3>Existing Users</h3>
        <div style="display:flex;flex-direction:column;gap:8px">
          {users.map((u) => (
            <div key={u.id} class="preset-row" style="align-items:flex-start;gap:10px">
              <div style="flex:1;min-width:180px">
                <div style="font-size:13px;font-weight:700">{u.username}</div>
                <div style="font-size:11px;color:var(--pw-text-muted)">{u.id} · {orgName(u.orgId)}</div>
                {u.role === 'member' && <div style="margin-top:2px">{podBadge(u.id)}</div>}
              </div>
              <select value={u.role} onChange={(e) => patchUser(u.id, { role: (e.currentTarget as HTMLSelectElement).value })}>
                <option value="member">member</option>
                <option value="admin">admin</option>
              </select>
              <select value={u.status} onChange={(e) => patchUser(u.id, { status: (e.currentTarget as HTMLSelectElement).value })}>
                <option value="active">active</option>
                <option value="disabled">disabled</option>
              </select>
              <select value={u.orgId || ''} onChange={(e) => patchUser(u.id, { orgId: (e.currentTarget as HTMLSelectElement).value || null })}>
                <option value="">No org</option>
                {orgs.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
              </select>
              <select value={u.launcherId || ''} onChange={(e) => patchUser(u.id, { launcherId: (e.currentTarget as HTMLSelectElement).value || null })}>
                <option value="">Any launcher</option>
                {targets.map((t) => <option key={t.launcherId} value={t.launcherId}>{t.name}</option>)}
              </select>
              <input
                type="password"
                placeholder="New password"
                value={resetPasswords[u.id] || ''}
                onInput={(e) => setResetPasswords({ ...resetPasswords, [u.id]: (e.currentTarget as HTMLInputElement).value })}
                style="width:130px"
              />
              <button class="btn btn-sm" onClick={() => resetPassword(u.id)}>Reset</button>
              {u.role === 'member' && (
                podStatus[u.id]?.exists
                  ? <button class="btn btn-sm" disabled={podBusy[u.id]} onClick={() => deprovisionPod(u.id)}>{podBusy[u.id] ? '…' : 'Tear down pod'}</button>
                  : <button class="btn btn-sm" disabled={podBusy[u.id] || podStatus[u.id]?.available === false} onClick={() => provisionPod(u.id)}>{podBusy[u.id] ? '…' : 'Provision pod'}</button>
              )}
              <button class="btn btn-sm btn-danger" onClick={async () => { await api.deleteUser(u.id); await load(); }}>Delete</button>
            </div>
          ))}
          {users.length === 0 && <div style="font-size:12px;color:var(--pw-text-muted)">No database users yet.</div>}
        </div>
      </div>
    </div>
  );
}
