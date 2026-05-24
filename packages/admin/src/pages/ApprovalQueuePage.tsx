import { useEffect, useState } from 'preact/hooks';
import { api } from '../lib/api.js';
import { pendingApprovalCountByApp, selectedAppId } from '../lib/state.js';

// Approval queue: dispatches diverted by channel.policy.requireApproval.
// Operators approve (replays the saved payload through dispatchFeedbackToAgent)
// or deny with an optional reason.

type Approval = {
  id: string;
  channelId: string;
  channelSlug: string | null;
  channelName: string | null;
  channelKind: 'prod' | 'staging' | 'exploratory' | null;
  appId: string | null;
  feedbackId: string;
  agentEndpointId: string;
  instructions: string | null;
  permissionProfile: string | null;
  requestedBy: string | null;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  denyReason: string | null;
  dispatchedSessionId: string | null;
  createdAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
};

const KIND_DOT: Record<string, string> = {
  prod: '#ef4444',
  staging: '#eab308',
  exploratory: '#1d9bf0',
};

function relTime(ts: number): string {
  const ms = Date.now() - ts;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function ApprovalQueuePage() {
  const appId = selectedAppId.value;
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [agents, setAgents] = useState<Record<string, { name: string; runtime: string }>>({});
  const [expandedInstructions, setExpandedInstructions] = useState<Set<string>>(new Set());
  const [denyDraftFor, setDenyDraftFor] = useState<string | null>(null);
  const [denyReasonText, setDenyReasonText] = useState<string>('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'pending' | 'all'>('pending');

  useEffect(() => {
    api.getAgents().then((rows: any[]) => {
      const byId: Record<string, { name: string; runtime: string }> = {};
      for (const a of rows) byId[a.id] = { name: a.name, runtime: a.runtime || 'claude' };
      setAgents(byId);
    }).catch(() => { /* non-fatal */ });
  }, []);

  async function refresh() {
    if (!appId) return;
    try {
      const res = await api.getApprovals(appId, statusFilter);
      setApprovals(res.approvals);
      const pendingCount = res.approvals.filter((approval) => approval.status === 'pending').length;
      pendingApprovalCountByApp.value = { ...pendingApprovalCountByApp.value, [appId]: pendingCount };
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load approvals');
    }
  }

  useEffect(() => {
    refresh();
    if (!appId) return;
    let alive = true;
    // Debounced poll while page is visible. document.hidden gates the work so
    // we don't burn cycles on backgrounded tabs.
    const id = setInterval(() => {
      if (!alive || document.hidden) return;
      refresh();
    }, 15_000);
    return () => { alive = false; clearInterval(id); };
  }, [appId, statusFilter]);

  async function onApprove(a: Approval) {
    setBusyId(a.id);
    setError(null);
    try {
      await api.approveApproval(a.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approve failed');
    } finally {
      setBusyId(null);
    }
  }

  async function onConfirmDeny(a: Approval) {
    setBusyId(a.id);
    setError(null);
    try {
      await api.denyApproval(a.id, denyReasonText.trim() || undefined);
      setDenyDraftFor(null);
      setDenyReasonText('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deny failed');
    } finally {
      setBusyId(null);
    }
  }

  if (!appId) {
    return <div style={{ padding: 16, color: 'var(--pw-text-muted)' }}>No workspace selected</div>;
  }

  return (
    <div style={{ padding: 16, width: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, color: 'var(--pw-text)' }}>
          {'\u{1F512}'} Approvals
          <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--pw-text-muted)', fontWeight: 'normal' }}>
            {approvals.length} {statusFilter}
          </span>
        </h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter((e.currentTarget as HTMLSelectElement).value as any)}
            style={{
              background: 'rgba(0,0,0,0.3)',
              color: 'var(--pw-text)',
              border: '1px solid var(--pw-border)',
              borderRadius: 4,
              padding: '4px 8px',
              fontSize: 12,
            }}
          >
            <option value="pending">Pending</option>
            <option value="all">All</option>
          </select>
          <button
            onClick={refresh}
            style={{
              background: 'rgba(0,0,0,0.3)',
              color: 'var(--pw-text)',
              border: '1px solid var(--pw-border)',
              borderRadius: 4,
              padding: '4px 10px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >Refresh</button>
        </div>
      </div>

      {error && (
        <div style={{
          padding: 8, marginBottom: 12,
          background: 'rgba(239,68,68,0.15)', color: '#fca5a5',
          border: '1px solid rgba(239,68,68,0.3)', borderRadius: 4, fontSize: 12,
        }}>{error}</div>
      )}

      {approvals.length === 0 ? (
        <div style={{ padding: 24, color: 'var(--pw-text-muted)', textAlign: 'center', fontSize: 13 }}>
          {statusFilter === 'pending' ? 'No pending approvals.' : 'No approvals yet.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {approvals.map((a) => {
            const agent = agents[a.agentEndpointId];
            const isExpanded = expandedInstructions.has(a.id);
            const instructions = a.instructions || '(no instructions)';
            const truncated = instructions.length > 200 && !isExpanded;
            const visibleInstructions = truncated ? instructions.slice(0, 200) + '…' : instructions;
            return (
              <div key={a.id} style={{
                padding: 12,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid var(--pw-border)',
                borderRadius: 6,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                    background: KIND_DOT[a.channelKind || ''] || '#6b7280',
                  }} />
                  <span style={{ fontWeight: 600, color: 'var(--pw-text)' }}>
                    #{a.channelSlug || '(deleted)'}
                  </span>
                  <span style={{ color: 'var(--pw-text-muted)' }}>·</span>
                  <span style={{ color: 'var(--pw-text)' }}>
                    {agent?.name || a.agentEndpointId}
                  </span>
                  {a.permissionProfile && (
                    <>
                      <span style={{ color: 'var(--pw-text-muted)' }}>·</span>
                      <span style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        borderRadius: 3,
                        background: 'rgba(0,0,0,0.3)',
                        color: 'var(--pw-text-muted)',
                        fontFamily: 'monospace',
                      }}>{a.permissionProfile}</span>
                    </>
                  )}
                  <span style={{ marginLeft: 'auto', color: 'var(--pw-text-muted)', fontSize: 11 }}>
                    {relTime(a.createdAt)}
                  </span>
                </div>

                <div style={{
                  fontSize: 12,
                  color: 'var(--pw-text)',
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.4,
                  fontFamily: instructions.includes('\n') ? 'monospace' : 'inherit',
                }}>
                  {visibleInstructions}
                  {truncated && (
                    <button
                      onClick={() => setExpandedInstructions(new Set([...expandedInstructions, a.id]))}
                      style={{
                        marginLeft: 4,
                        background: 'transparent',
                        color: '#93c5fd',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: 11,
                        padding: 0,
                      }}
                    >expand</button>
                  )}
                </div>

                <div style={{ fontSize: 11, color: 'var(--pw-text-muted)' }}>
                  feedback: <code>{a.feedbackId.slice(0, 12)}…</code>
                </div>

                {a.status === 'pending' ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => onApprove(a)}
                      disabled={busyId === a.id}
                      style={{
                        padding: '6px 14px', fontSize: 12,
                        background: 'rgba(34,197,94,0.18)', color: '#86efac',
                        border: '1px solid rgba(34,197,94,0.4)',
                        borderRadius: 4, cursor: busyId === a.id ? 'not-allowed' : 'pointer',
                        opacity: busyId === a.id ? 0.6 : 1,
                      }}
                    >Approve</button>
                    {denyDraftFor === a.id ? (
                      <>
                        <input
                          value={denyReasonText}
                          onInput={(e) => setDenyReasonText((e.currentTarget as HTMLInputElement).value)}
                          placeholder="reason (optional)"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') onConfirmDeny(a);
                            else if (e.key === 'Escape') { setDenyDraftFor(null); setDenyReasonText(''); }
                          }}
                          style={{
                            flex: 1, minWidth: 160,
                            padding: '5px 8px', fontSize: 12,
                            background: 'rgba(0,0,0,0.3)',
                            border: '1px solid var(--pw-border)',
                            borderRadius: 4, color: 'var(--pw-text)',
                          }}
                        />
                        <button
                          onClick={() => onConfirmDeny(a)}
                          disabled={busyId === a.id}
                          style={{
                            padding: '6px 14px', fontSize: 12,
                            background: 'rgba(239,68,68,0.2)', color: '#fca5a5',
                            border: '1px solid rgba(239,68,68,0.4)',
                            borderRadius: 4, cursor: busyId === a.id ? 'not-allowed' : 'pointer',
                            opacity: busyId === a.id ? 0.6 : 1,
                          }}
                        >Confirm deny</button>
                        <button
                          onClick={() => { setDenyDraftFor(null); setDenyReasonText(''); }}
                          style={{
                            padding: '6px 10px', fontSize: 12,
                            background: 'transparent', color: 'var(--pw-text-muted)',
                            border: '1px solid var(--pw-border)',
                            borderRadius: 4, cursor: 'pointer',
                          }}
                        >Cancel</button>
                      </>
                    ) : (
                      <button
                        onClick={() => { setDenyDraftFor(a.id); setDenyReasonText(''); }}
                        style={{
                          padding: '6px 14px', fontSize: 12,
                          background: 'rgba(0,0,0,0.3)', color: 'var(--pw-text)',
                          border: '1px solid var(--pw-border)',
                          borderRadius: 4, cursor: 'pointer',
                        }}
                      >Deny</button>
                    )}
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--pw-text-muted)' }}>
                    {a.status === 'approved' && (
                      <>approved {a.resolvedAt ? relTime(a.resolvedAt) : ''}{a.dispatchedSessionId ? ` · session ${a.dispatchedSessionId.slice(0, 10)}…` : ''}</>
                    )}
                    {a.status === 'denied' && (
                      <>denied {a.resolvedAt ? relTime(a.resolvedAt) : ''}{a.denyReason ? ` · ${a.denyReason}` : ''}</>
                    )}
                    {a.status === 'expired' && <>expired {a.resolvedAt ? relTime(a.resolvedAt) : ''}</>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
