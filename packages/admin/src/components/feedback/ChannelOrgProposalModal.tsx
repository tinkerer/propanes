import { useEffect, useState } from 'preact/hooks';
import { api } from '../../lib/api.js';
import { channelOrgProposalOpen, loadChannels, selectedAppId, type ChannelKind } from '../../lib/state.js';

// Modal showing the most recent pending auto-organize proposal for the
// selected workspace. Operator can apply (creates the channels and binds
// threads) or reject (marks rejected, leaves data unchanged).

type Proposal = {
  id: string;
  appId: string;
  status: 'pending' | 'applied' | 'rejected';
  reasoning: string;
  proposal: {
    channels: Array<{
      slug: string;
      name: string;
      description: string;
      kind: ChannelKind;
      threadIds: string[];
    }>;
  };
  createdAt: number;
  appliedAt: number | null;
};

const KIND_DOT: Record<ChannelKind, string> = {
  prod: '#ef4444',
  staging: '#eab308',
  exploratory: '#22c55e',
};

export function ChannelOrgProposalModal() {
  const open = channelOrgProposalOpen.value;
  const appId = selectedAppId.value;
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !appId) return;
    setLoading(true);
    setError(null);
    api.listOrgProposals(appId)
      .then((res) => {
        const pending = res.proposals.find((p) => p.status === 'pending');
        setProposal((pending ?? null) as Proposal | null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [open, appId]);

  if (!open) return null;

  return (
    <div
      class="cos-channel-org-modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) channelOrgProposalOpen.value = false; }}
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(0,0,0,0.6)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div class="cos-channel-org-modal" style={{
        width: '100%', maxWidth: 720, maxHeight: '90vh',
        background: '#1e293b', borderRadius: 8, color: 'var(--pw-text)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--pw-border)', display: 'flex', alignItems: 'center' }}>
          <span style={{ fontSize: 16, fontWeight: 600 }}>✨ Auto-organize Channels</span>
          <span style={{ flex: 1 }} />
          <button
            onClick={() => (channelOrgProposalOpen.value = false)}
            style={{ background: 'transparent', border: 'none', color: 'var(--pw-text-muted)', cursor: 'pointer', fontSize: 18 }}
          >×</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
          {loading && <div style={{ color: 'var(--pw-text-muted)' }}>Loading…</div>}
          {error && <div style={{ color: '#ef4444' }}>{error}</div>}
          {!loading && !proposal && (
            <div style={{ color: 'var(--pw-text-muted)' }}>
              No pending proposal. Trigger auto-organize from the Unsorted view first.
            </div>
          )}
          {proposal && (
            <>
              {proposal.reasoning && (
                <div style={{
                  padding: 10, background: 'rgba(255,255,255,0.04)',
                  borderRadius: 4, marginBottom: 16, fontSize: 13, lineHeight: 1.5,
                }}>
                  <strong style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--pw-text-muted)' }}>Reasoning</strong>
                  <div style={{ marginTop: 4 }}>{proposal.reasoning}</div>
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {proposal.proposal.channels.map((ch) => (
                  <div
                    key={ch.slug}
                    style={{
                      padding: 12, border: '1px solid var(--pw-border)',
                      borderRadius: 6, background: 'rgba(0,0,0,0.2)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: KIND_DOT[ch.kind] || '#6b7280',
                      }} />
                      <span style={{ fontSize: 14, fontWeight: 600 }}>#{ch.slug}</span>
                      <span style={{ color: 'var(--pw-text-muted)', fontSize: 12 }}>{ch.name}</span>
                      <span style={{ flex: 1 }} />
                      <span style={{ fontSize: 11, color: 'var(--pw-text-muted)' }}>{ch.threadIds.length} threads</span>
                    </div>
                    {ch.description && (
                      <div style={{ marginTop: 6, fontSize: 12, color: 'var(--pw-text-muted)' }}>{ch.description}</div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {proposal && (
          <div style={{
            padding: 12, borderTop: '1px solid var(--pw-border)',
            display: 'flex', gap: 8, justifyContent: 'flex-end',
          }}>
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.rejectOrgProposal(proposal.id);
                  channelOrgProposalOpen.value = false;
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
              style={{
                padding: '6px 14px', background: 'transparent',
                border: '1px solid var(--pw-border)', color: 'var(--pw-text-muted)',
                borderRadius: 4, cursor: busy ? 'wait' : 'pointer', fontSize: 13,
              }}
            >Reject</button>
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.applyOrgProposal(proposal.id);
                  if (appId) await loadChannels(appId);
                  channelOrgProposalOpen.value = false;
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
              style={{
                padding: '6px 14px', background: '#3b82f6',
                border: 'none', color: '#fff',
                borderRadius: 4, cursor: busy ? 'wait' : 'pointer', fontSize: 13,
              }}
            >Apply</button>
          </div>
        )}
      </div>
    </div>
  );
}
