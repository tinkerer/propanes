import { useEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { api } from '../lib/api.js';
import {
  activeChannel,
  channelOrgProposalOpen,
  loadChannels,
  selectedAppId,
  unsortedCountByApp,
  type ChannelKind,
} from '../lib/state.js';
import { cosActiveThread } from '../lib/cos-popout-tree.js';
import { chiefOfStaffOpen, chiefOfStaffActiveId } from '../lib/chief-of-staff.js';

// Channel detail page: shows the channel's name, kind badge, members, policy
// summary, and the thread list. Click a thread to open it in the CoS bubble.

type ThreadRow = {
  id: string;
  agentId: string;
  appId: string | null;
  channelId: string | null;
  name: string;
  resolvedAt: number | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  sessionStatus: string | null;
  sessionExitCode: number | null;
};

type Member = {
  id: string;
  channelId: string;
  kind: 'user' | 'agent';
  refId: string;
  role: string;
  joinedAt: number;
};

const KIND_COLORS: Record<ChannelKind, { dot: string; label: string }> = {
  prod:        { dot: '#ef4444', label: 'prod' },
  staging:     { dot: '#eab308', label: 'staging' },
  exploratory: { dot: '#22c55e', label: 'exploratory' },
};

const channelThreads = signal<Record<string, ThreadRow[]>>({});

export async function loadChannelThreads(appId: string): Promise<void> {
  // Server endpoint /chief-of-staff/threads?appId returns ALL threads for the
  // workspace; we group client-side by channelId.
  const res = await fetch(`/api/v1/admin/chief-of-staff/threads?appId=${encodeURIComponent(appId)}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('pw-admin-token') || ''}` },
  });
  if (!res.ok) return;
  const data = await res.json();
  const grouped: Record<string, ThreadRow[]> = {};
  for (const t of (data.threads || []) as ThreadRow[]) {
    const key = t.channelId || '_unsorted';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(t);
  }
  channelThreads.value = grouped;
}

export function ChannelPage() {
  const ch = activeChannel.value;
  const appId = selectedAppId.value;
  const unsorted = appId ? unsortedCountByApp.value[appId] : null;
  const [members, setMembers] = useState<Member[]>([]);
  const [organizing, setOrganizing] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(null);

  useEffect(() => {
    if (appId) loadChannelThreads(appId);
  }, [appId, ch?.id]);

  useEffect(() => {
    if (!ch) { setMembers([]); return; }
    let cancelled = false;
    api.getChannelMembers(ch.id).then((res) => {
      if (!cancelled) setMembers(res.members);
    }).catch(() => { if (!cancelled) setMembers([]); });
    return () => { cancelled = true; };
  }, [ch?.id]);

  if (!appId) {
    return <div style={{ padding: 16, color: 'var(--pw-text-muted)' }}>No workspace selected</div>;
  }

  // Unsorted view (no channel selected, or activeChannel is null and unsorted has threads).
  const showUnsorted = !ch;
  const threadsKey = showUnsorted ? '_unsorted' : ch.id;
  const threads = (channelThreads.value[threadsKey] || [])
    .filter((t) => !t.archivedAt && !t.resolvedAt && (showUnsorted ? !t.channelId : t.channelId === ch?.id))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div class="cos-channel-page" style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden' }}>
      <div class="cos-channel-page-main" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'auto' }}>
        <ChannelHeader
          ch={ch}
          unsorted={showUnsorted}
          unsortedCount={unsorted?.threadCount ?? 0}
          onAutoOrganize={async () => {
            setOrganizing(true);
            setOrgError(null);
            try {
              await api.autoOrganizeChannels(appId);
              channelOrgProposalOpen.value = true;
            } catch (e) {
              setOrgError(e instanceof Error ? e.message : String(e));
            } finally {
              setOrganizing(false);
            }
          }}
          organizing={organizing}
          orgError={orgError}
        />
        <ThreadList
          threads={threads}
          onOpen={(t) => {
            chiefOfStaffActiveId.value = t.agentId;
            cosActiveThread.value = { agentId: t.agentId, threadKey: t.id };
            chiefOfStaffOpen.value = true;
          }}
        />
      </div>
      {ch && (
        <ChannelMemberRail
          channel={ch}
          members={members}
          onChange={() => {
            api.getChannelMembers(ch.id).then((r) => setMembers(r.members)).catch(() => {});
            loadChannels(appId);
          }}
        />
      )}
    </div>
  );
}

function ChannelHeader({
  ch, unsorted, unsortedCount, onAutoOrganize, organizing, orgError,
}: {
  ch: ReturnType<typeof activeChannel.value> | null;
  unsorted: boolean;
  unsortedCount: number;
  onAutoOrganize: () => void;
  organizing: boolean;
  orgError: string | null;
}) {
  if (unsorted) {
    return (
      <div class="cos-channel-header" style={{ padding: '12px 16px', borderBottom: '1px solid var(--pw-border)' }}>
        <div class="cos-channel-header-row" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 18, fontWeight: 600 }}>📥 Unsorted</span>
          <span style={{ color: 'var(--pw-text-muted)' }}>{unsortedCount} threads not assigned to a channel</span>
        </div>
        <p style={{ marginTop: 8, color: 'var(--pw-text-muted)', fontSize: 13 }}>
          Run auto-organize to bucket these into channels by topic.
        </p>
        <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={onAutoOrganize}
            disabled={organizing}
            style={{
              padding: '6px 12px',
              background: '#3b82f6',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              cursor: organizing ? 'wait' : 'pointer',
              fontSize: 13,
            }}
          >
            {organizing ? 'Asking Claude (1-3 min)…' : '✨ Auto-organize threads'}
          </button>
          {orgError && <span style={{ color: '#ef4444', fontSize: 12 }}>{orgError}</span>}
        </div>
      </div>
    );
  }
  if (!ch) return null;
  return <ChannelSettingsHeader ch={ch} />;
}

function ChannelSettingsHeader({ ch }: { ch: NonNullable<ReturnType<typeof activeChannel.value>> }) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [name, setName] = useState(ch.name);
  const [kind, setKind] = useState<ChannelKind>(ch.kind);
  const [description, setDescription] = useState(ch.description);
  const colors = KIND_COLORS[ch.kind];
  const appId = selectedAppId.value;

  return (
    <div class="cos-channel-header" style={{ padding: '12px 16px', borderBottom: '1px solid var(--pw-border)' }}>
      <div class="cos-channel-header-row" style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 18, fontWeight: 600 }}>#{ch.slug}</span>
        <span title={`${ch.kind} channel`} style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px', borderRadius: 12,
          background: 'rgba(255,255,255,0.06)', fontSize: 11, color: 'var(--pw-text-muted)',
        }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: colors.dot, display: 'inline-block' }} />
          {colors.label}
        </span>
        {ch.policy.requireApproval && (
          <span style={{ fontSize: 11, color: '#fbbf24' }}>🔒 approval required</span>
        )}
        {ch.policy.powwow.enabled && (
          <span style={{ fontSize: 11, color: '#a78bfa' }}>⚡ powwow ({ch.policy.powwow.providers.join('+')})</span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ color: 'var(--pw-text-muted)', fontSize: 12 }}>
          {ch.threadCount} threads · {ch.openCount} open
        </span>
        <button
          onClick={() => setEditing((v) => !v)}
          title="Channel settings"
          style={{ background: 'transparent', border: 'none', color: 'var(--pw-text-muted)', cursor: 'pointer', fontSize: 14, padding: '0 6px' }}
        >⋯</button>
      </div>
      {ch.description && !editing && (
        <div style={{ marginTop: 6, color: 'var(--pw-text-muted)', fontSize: 13 }}>{ch.description}</div>
      )}
      {!editing && (
        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 11, color: 'var(--pw-text-muted)' }}>
          <span>profiles:</span>
          {ch.policy.allowedProfiles.length === 0
            ? <span>—</span>
            : ch.policy.allowedProfiles.map((p) => (
              <span key={p} style={{ padding: '1px 6px', borderRadius: 3, background: 'rgba(255,255,255,0.05)' }}>{p}</span>
            ))}
        </div>
      )}
      {editing && (
        <div class="cos-channel-edit-form" style={{ marginTop: 10, padding: 10, background: 'rgba(255,255,255,0.04)', borderRadius: 4, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Field label="Name">
            <input
              value={name}
              onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
              style={inputStyle}
            />
          </Field>
          <Field label="Description">
            <input
              value={description}
              onInput={(e) => setDescription((e.currentTarget as HTMLInputElement).value)}
              placeholder="(optional)"
              style={inputStyle}
            />
          </Field>
          <Field label="Kind">
            <select
              value={kind}
              onChange={(e) => setKind((e.currentTarget as HTMLSelectElement).value as ChannelKind)}
              style={inputStyle}
            >
              <option value="staging">staging — default product work</option>
              <option value="prod">prod — strict, approval required, restricted profiles</option>
              <option value="exploratory">exploratory — fafo / yolo pow-wow</option>
            </select>
          </Field>
          <div style={{ fontSize: 11, color: 'var(--pw-text-muted)' }}>
            Changing kind resets the channel's policy preset (allowed profiles, approval gate, etc.).
          </div>
          <div class="cos-channel-edit-actions" style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
            <button
              onClick={async () => {
                await api.patchChannel(ch.id, { name, description, kind });
                if (appId) await loadChannels(appId);
                setEditing(false);
              }}
              style={btnPrimaryStyle}
            >Save</button>
            <button
              onClick={async () => {
                await api.patchChannel(ch.id, { archived: true });
                if (appId) await loadChannels(appId);
                setEditing(false);
              }}
              style={btnGhostStyle}
            >Archive channel</button>
            {!confirmingDelete ? (
              <button
                onClick={() => setConfirmingDelete(true)}
                style={{ ...btnGhostStyle, color: '#ef4444' }}
              >Delete</button>
            ) : (
              <button
                onClick={async () => {
                  await api.deleteChannel(ch.id);
                  if (appId) await loadChannels(appId);
                  setEditing(false); setConfirmingDelete(false);
                }}
                style={{ ...btnGhostStyle, background: '#7f1d1d', color: '#fee2e2', borderColor: '#ef4444' }}
              >Click again to delete (threads → unsorted)</button>
            )}
            <span style={{ flex: 1 }} />
            <button
              onClick={() => { setEditing(false); setName(ch.name); setKind(ch.kind); setDescription(ch.description); }}
              style={btnGhostStyle}
            >Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

const inputStyle: import('preact').JSX.CSSProperties = {
  width: '100%', padding: '4px 8px', fontSize: 12,
  background: 'rgba(0,0,0,0.3)', border: '1px solid var(--pw-border)',
  borderRadius: 3, color: 'var(--pw-text)', boxSizing: 'border-box',
};

const btnPrimaryStyle: import('preact').JSX.CSSProperties = {
  padding: '4px 12px', fontSize: 12, background: '#3b82f6',
  color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer',
};

const btnGhostStyle: import('preact').JSX.CSSProperties = {
  padding: '4px 12px', fontSize: 12, background: 'transparent',
  color: 'var(--pw-text-muted)', border: '1px solid var(--pw-border)',
  borderRadius: 3, cursor: 'pointer',
};

function Field({ label, children }: { label: string; children: import('preact').ComponentChildren }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--pw-text-muted)', letterSpacing: 0.5 }}>{label}</span>
      {children}
    </label>
  );
}

function ThreadList({
  threads, onOpen,
}: {
  threads: ThreadRow[];
  onOpen: (t: ThreadRow) => void;
}) {
  if (threads.length === 0) {
    return <div style={{ padding: 24, color: 'var(--pw-text-muted)', fontSize: 13 }}>No open threads.</div>;
  }
  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      {threads.map((t) => (
        <button
          key={t.id}
          onClick={() => onOpen(t)}
          draggable
          onDragStart={(e) => {
            e.dataTransfer?.setData('application/x-cos-thread', t.id);
            e.dataTransfer?.setData('text/plain', t.id);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
          }}
          style={{
            display: 'block', width: '100%', textAlign: 'left',
            padding: '10px 16px', border: 'none', cursor: 'grab',
            background: 'transparent', borderBottom: '1px solid var(--pw-border)',
            color: 'var(--pw-text)', fontSize: 13,
          }}
          onMouseOver={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
          onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: t.sessionStatus === 'running' ? '#22c55e'
                : t.resolvedAt ? '#6b7280'
                : t.sessionStatus === 'failed' ? '#ef4444' : '#3b82f6',
            }} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
            <span style={{ fontSize: 11, color: 'var(--pw-text-muted)' }}>{t.agentId}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

function ChannelMemberRail({
  channel, members, onChange,
}: {
  channel: NonNullable<ReturnType<typeof activeChannel.value>>;
  members: Member[];
  onChange: () => void;
}) {
  const [adding, setAdding] = useState<'user' | 'agent' | null>(null);
  const [refIdInput, setRefIdInput] = useState('');

  const users = members.filter((m) => m.kind === 'user');
  const agents = members.filter((m) => m.kind === 'agent');

  return (
    <div class="cos-channel-page-rail" style={{
      width: 240, borderLeft: '1px solid var(--pw-border)',
      padding: 12, overflow: 'auto', fontSize: 13,
      background: 'rgba(0,0,0,0.15)',
    }}>
      <SectionHeader label={`Users (${users.length})`} onAdd={() => { setAdding('user'); setRefIdInput(''); }} />
      {users.map((m) => (
        <MemberRow key={m.id} member={m} channelId={channel.id} onChange={onChange} icon="👤" />
      ))}
      {users.length === 0 && <div style={{ color: 'var(--pw-text-muted)', fontSize: 12 }}>—</div>}

      <div style={{ height: 12 }} />
      <SectionHeader label={`Agents (${agents.length})`} onAdd={() => { setAdding('agent'); setRefIdInput(''); }} />
      {agents.map((m) => (
        <MemberRow key={m.id} member={m} channelId={channel.id} onChange={onChange} icon="🤖" />
      ))}
      {agents.length === 0 && <div style={{ color: 'var(--pw-text-muted)', fontSize: 12 }}>—</div>}

      {adding && (
        <div style={{ marginTop: 12, padding: 8, background: 'rgba(255,255,255,0.04)', borderRadius: 4 }}>
          <div style={{ fontSize: 11, color: 'var(--pw-text-muted)', marginBottom: 4 }}>
            Add {adding} ({adding === 'user' ? 'email' : 'agent endpoint id'})
          </div>
          <input
            value={refIdInput}
            onInput={(e) => setRefIdInput((e.currentTarget as HTMLInputElement).value)}
            placeholder={adding === 'user' ? 'name@example.com' : '01KQ…'}
            style={{
              width: '100%', padding: '4px 6px', fontSize: 12,
              background: 'rgba(0,0,0,0.3)', border: '1px solid var(--pw-border)',
              borderRadius: 3, color: 'var(--pw-text)', boxSizing: 'border-box',
            }}
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && refIdInput.trim()) {
                await api.addChannelMember(channel.id, { kind: adding, refId: refIdInput.trim() });
                setAdding(null);
                onChange();
              } else if (e.key === 'Escape') {
                setAdding(null);
              }
            }}
            autoFocus
          />
          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--pw-text-muted)' }}>Enter to add · Esc to cancel</div>
        </div>
      )}

      <div style={{ height: 16 }} />
      <div style={{ fontSize: 11, color: 'var(--pw-text-muted)' }}>
        Created {new Date(channel.createdAt).toLocaleDateString()}
      </div>
    </div>
  );
}

function SectionHeader({ label, onAdd }: { label: string; onAdd?: () => void }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
      color: 'var(--pw-text-muted)', marginBottom: 6, letterSpacing: 0.5,
    }}>
      <span>{label}</span>
      {onAdd && (
        <button
          onClick={onAdd}
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--pw-text-muted)', fontSize: 14, padding: 0, lineHeight: 1,
          }}
          title="Add member"
        >+</button>
      )}
    </div>
  );
}

function MemberRow({
  member, channelId, onChange, icon,
}: {
  member: Member;
  channelId: string;
  onChange: () => void;
  icon: string;
}) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '3px 0', fontSize: 12,
      }}
    >
      <span>{icon}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {member.refId}
      </span>
      <button
        onClick={async () => {
          await api.removeChannelMember(channelId, member.id);
          onChange();
        }}
        title="Remove"
        style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--pw-text-muted)', fontSize: 12, padding: '0 4px',
        }}
      >×</button>
    </div>
  );
}
