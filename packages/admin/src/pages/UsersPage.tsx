import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../lib/api.js';

type UserRow = {
  id: string;
  username: string;
  role: 'admin' | 'member';
  status: 'active' | 'disabled';
  orgId: string | null;
  launcherId: string | null;
};

type MenuConfirm = 'delete' | 'reset' | 'deprovision';
type MenuState = { userId: string; top?: number; bottom?: number; right: number; confirm?: MenuConfirm; ownedApps?: string[] };

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
  const [notice, setNotice] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // One menu for the whole page; click-away and Escape (capture phase, so
  // pane-level key handlers can't swallow it) close it.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setMenu(null); }
    };
    const onScroll = () => setMenu(null);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [menu?.userId]);

  function openMenu(userId: string, e: MouseEvent) {
    if (menu?.userId === userId) { setMenu(null); return; }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const right = Math.max(8, window.innerWidth - r.right);
    // Open upward near the bottom edge; the confirm step is taller than the list.
    const flip = window.innerHeight - r.bottom < 200 && r.top > window.innerHeight - r.bottom;
    setMenu(flip ? { userId, bottom: window.innerHeight - r.top + 4, right } : { userId, top: r.bottom + 4, right });
  }

  async function askConfirm(confirm: MenuConfirm) {
    if (!menu) return;
    setMenu({ ...menu, confirm });
    if (confirm === 'reset') {
      try {
        const info = await api.getUserOnboarding(menu.userId);
        setMenu((m) => (m && m.userId === menu.userId ? { ...m, ownedApps: info.owned.map((a) => a.name) } : m));
      } catch {
        /* the confirm text falls back to a generic description */
      }
    }
  }

  async function deleteUser(id: string) {
    setMenu(null);
    setError('');
    try {
      await api.deleteUser(id);
      await load();
    } catch (err: any) {
      setError(err.message || 'Failed to delete user');
    }
  }

  async function resetOnboarding(id: string) {
    setMenu(null);
    setError('');
    setNotice('');
    try {
      const res = await api.resetUserOnboarding(id);
      const name = users.find((u) => u.id === id)?.username || id;
      setNotice(
        `Reset onboarding for ${name}: removed ${res.apps.length} app${res.apps.length === 1 ? '' : 's'} and ${res.agentsRemoved} agent${res.agentsRemoved === 1 ? '' : 's'}` +
        `${res.machineRemoved ? ', the launcher machine' : ''}${res.launcherCleared ? `, unpinned ${res.launcherCleared}` : ''}.`,
      );
      await load();
    } catch (err: any) {
      setError(err.message || 'Failed to reset onboarding');
    }
  }

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
    setMenu(null);
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
    setMenu(null);
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
      {notice && <div style="margin-bottom:12px;font-size:12px;color:var(--pw-text-muted)">{notice}</div>}

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
              <button
                class="btn btn-sm users-row-menu-btn"
                aria-label={`Actions for ${u.username}`}
                aria-haspopup="menu"
                aria-expanded={menu?.userId === u.id}
                onClick={(e) => openMenu(u.id, e as unknown as MouseEvent)}
              >⋯</button>
            </div>
          ))}
          {users.length === 0 && <div style="font-size:12px;color:var(--pw-text-muted)">No database users yet.</div>}
        </div>
      </div>
      {menu && renderMenu(menu)}
    </div>
  );

  function renderMenu(m: MenuState) {
    const u = users.find((x) => x.id === m.userId);
    if (!u) return null;
    const pod = podStatus[u.id];
    const busy = !!podBusy[u.id];
    const style = `${m.top !== undefined ? `top:${m.top}px` : `bottom:${m.bottom}px`};right:${m.right}px`;
    if (m.confirm) {
      const text = {
        delete: `Delete ${u.username}? Their apps, sessions and feedback stay, but they can no longer sign in.`,
        reset: m.ownedApps
          ? `Reset onboarding for ${u.username}? Deletes ${m.ownedApps.length ? m.ownedApps.join(', ') : 'no apps'} with their agents, the launcher machine row and the launcher pin. The Linux account and checkouts are untouched.`
          : `Reset onboarding for ${u.username}? Deletes their apps with their agents, the launcher machine row and the launcher pin.`,
        deprovision: `Tear down ${u.username}'s launcher pod? Their private credential disk is kept.`,
      }[m.confirm];
      const act = { delete: () => deleteUser(u.id), reset: () => resetOnboarding(u.id), deprovision: () => deprovisionPod(u.id) }[m.confirm];
      const label = { delete: 'Delete user', reset: 'Reset onboarding', deprovision: 'Tear down pod' }[m.confirm];
      return (
        <div ref={menuRef} class="pty-ctx-menu users-row-menu" role="menu" style={style}>
          <div class="users-row-menu-confirm">{text}</div>
          <button role="menuitem" class="danger" onClick={act}>{label}</button>
          <button role="menuitem" onClick={() => setMenu({ ...m, confirm: undefined })}>Cancel</button>
        </div>
      );
    }
    return (
      <div ref={menuRef} class="pty-ctx-menu users-row-menu" role="menu" style={style}>
        {u.role === 'member' && (
          pod?.exists
            ? <button role="menuitem" disabled={busy} onClick={() => askConfirm('deprovision')}>Tear down pod</button>
            : <button role="menuitem" disabled={busy || pod?.available === false} title={pod?.available === false ? 'Kubernetes provisioning is not available on this server' : undefined} onClick={() => provisionPod(u.id)}>Provision pod</button>
        )}
        {u.role === 'member' && <button role="menuitem" onClick={() => askConfirm('reset')}>Reset onboarding</button>}
        <button role="menuitem" class="danger" onClick={() => askConfirm('delete')}>Delete user</button>
      </div>
    );
  }
}
