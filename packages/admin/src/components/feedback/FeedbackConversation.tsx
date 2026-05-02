// Feedback ↔ CoS thread bridge UI. Every widget/admin-created feedback item
// is mirrored as a thread in the per-app `#inbox` channel; this component
// renders that thread inline as the primary surface on FeedbackDetailPage —
// the ticket and its CoS thread are the same artifact viewed two ways.
//
// Notes go into cos_messages so they appear in the CoS bubble too: same data
// store, two views. Legacy feedback items predating the bridge get a "Create
// thread" button that mints one on demand via ?mint=1.

import { useSignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { marked } from 'marked';
import { api } from '../../lib/api.js';
import { formatDate } from '../../lib/date-utils.js';

type ThreadMessage = {
  id: string;
  threadId: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  toolCallsJson: string | null;
  attachmentsJson: string | null;
  mentionsJson: string | null;
  slashCommand: string | null;
  createdAt: number;
};

type ThreadBundle = {
  thread: {
    id: string;
    agentId: string;
    appId: string | null;
    channelId: string | null;
    feedbackId: string | null;
    name: string;
    agentSessionId: string | null;
    createdAt: number;
    updatedAt: number;
  } | null;
  messages: ThreadMessage[];
};

function parseAttachments(raw: string | null): { images?: { dataUrl: string }[] } {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

// Strip <cos-reply>…</cos-reply> wrappers that the agent uses to demarcate
// its conversational reply from tool-output noise. Operators don't care
// about the markers in this view.
function stripCosReply(text: string): string {
  return text.replace(/<\/?cos-reply>/g, '').trim();
}

function MessageRow({ msg }: { msg: ThreadMessage }) {
  const attachments = parseAttachments(msg.attachmentsJson);
  const images = attachments.images ?? [];
  const cleaned = stripCosReply(msg.text || '');
  const html = cleaned ? (marked.parse(cleaned, { gfm: true, breaks: true, async: false }) as string) : '';
  const author = msg.role === 'user' ? 'Operator' : msg.role === 'assistant' ? 'Agent' : 'System';
  return (
    <div class={`fb-conv-row fb-conv-row-${msg.role}`} style="display:flex;gap:10px;padding:10px 12px;border-top:1px solid var(--pw-border-subtle, rgba(255,255,255,0.06))">
      <div style="flex:0 0 64px;font-size:11px;color:var(--pw-text-faint);font-weight:600;text-transform:uppercase;letter-spacing:0.04em;padding-top:2px">
        {author}
      </div>
      <div style="flex:1;min-width:0">
        {html && (
          <div class="markdown-body" style="font-size:13px;line-height:1.5" dangerouslySetInnerHTML={{ __html: html }} />
        )}
        {images.length > 0 && (
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
            {images.map((img, i) => (
              <a key={i} href={img.dataUrl} target="_blank" rel="noopener" style="display:block">
                <img src={img.dataUrl} alt="" style="max-width:240px;max-height:160px;border:1px solid var(--pw-border-subtle, rgba(255,255,255,0.08));border-radius:4px;display:block" />
              </a>
            ))}
          </div>
        )}
        <div style="font-size:11px;color:var(--pw-text-faint);margin-top:4px">{formatDate(new Date(msg.createdAt).toISOString())}</div>
      </div>
    </div>
  );
}

// Derive the "this thread is" badge: draft (no agent session run yet),
// running (active session), or completed (terminal state). Mirrors the
// derivation in FeedbackListPage so the list and detail views agree.
function threadStateBadge(bundle: ThreadBundle): { label: string; tone: 'draft' | 'running' | 'completed' } | null {
  if (!bundle.thread) return null;
  const sid = bundle.thread.agentSessionId;
  if (!sid) return { label: 'Draft', tone: 'draft' };
  // We don't have the session row here, so infer from messages — if any
  // assistant reply exists this thread has run at least once.
  const hasAssistantReply = bundle.messages.some((m) => m.role === 'assistant');
  if (!hasAssistantReply) return { label: 'Draft', tone: 'draft' };
  // Without polling the session status here we can't differentiate
  // running/completed reliably; fall back to "completed" (the FeedbackListPage
  // surfaces the running pulse via the agentSessions table directly).
  return { label: 'Replied', tone: 'completed' };
}

export function FeedbackConversation({ feedbackId, appId }: { feedbackId: string; appId: string | null }) {
  const bundle = useSignal<ThreadBundle | null>(null);
  const loadError = useSignal<string | null>(null);
  const noteText = useSignal('');
  const sending = useSignal(false);
  const minting = useSignal(false);
  const cosHref = appId ? `#/app/${appId}` : '#/';
  const lastFeedbackIdRef = useRef<string | null>(null);

  async function load() {
    try {
      const data = await api.getThreadByFeedbackId(feedbackId);
      bundle.value = data;
      loadError.value = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      loadError.value = msg.includes('404') || msg.includes('no thread') ? null : msg;
      bundle.value = null;
    }
  }

  async function mintThread() {
    minting.value = true;
    try {
      // The /by-feedback/:id route accepts ?mint=1 to lazily create a thread
      // for a feedback item that predates the cos-inbox bridge.
      const res = await fetch(
        `/api/v1/admin/chief-of-staff/threads/by-feedback/${encodeURIComponent(feedbackId)}?mint=1`,
        {
          headers: { Authorization: `Bearer ${localStorage.getItem('pw-admin-token') || ''}` },
        },
      );
      if (!res.ok) throw new Error(`Mint failed: ${res.status}`);
      const data = await res.json();
      bundle.value = data;
      loadError.value = null;
    } catch (err) {
      loadError.value = err instanceof Error ? err.message : String(err);
    } finally {
      minting.value = false;
    }
  }

  useEffect(() => {
    if (lastFeedbackIdRef.current === feedbackId) return;
    lastFeedbackIdRef.current = feedbackId;
    bundle.value = null;
    void load();
    // Poll every 5s so newly-streamed agent replies surface without the
    // operator needing to hit refresh.
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [feedbackId]);

  async function sendNote() {
    const text = noteText.value.trim();
    const data = bundle.value;
    if (!text || !data?.thread) return;
    sending.value = true;
    try {
      await api.postThreadNote(data.thread.id, text);
      noteText.value = '';
      await load();
    } catch (err) {
      loadError.value = err instanceof Error ? err.message : String(err);
    } finally {
      sending.value = false;
    }
  }

  if (loadError.value) {
    return (
      <div class="detail-card" style="margin-bottom:16px">
        <h3>Conversation</h3>
        <div class="error-msg" style="font-size:12px">{loadError.value}</div>
      </div>
    );
  }

  // No thread yet — either still loading or this feedback predates the bridge.
  if (!bundle.value || !bundle.value.thread) {
    return (
      <div class="detail-card" style="margin-bottom:16px">
        <h3>Conversation</h3>
        <div style="display:flex;align-items:center;gap:12px;font-size:13px;color:var(--pw-text-muted)">
          <span>No thread linked to this ticket yet.</span>
          <button
            class="btn btn-sm btn-primary"
            disabled={minting.value}
            onClick={() => void mintThread()}
          >
            {minting.value ? 'Creating…' : 'Create thread'}
          </button>
        </div>
      </div>
    );
  }

  const data = bundle.value;
  const badge = threadStateBadge(data);
  return (
    <div class="detail-card" style="margin-bottom:16px;padding:0;overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px;border-bottom:1px solid var(--pw-border-subtle, rgba(255,255,255,0.06))">
        <div style="display:flex;align-items:center;gap:10px">
          <h3 style="margin:0">Conversation</h3>
          {badge && (
            <span
              class={`badge badge-${badge.tone === 'draft' ? 'new' : badge.tone === 'running' ? 'dispatched' : 'resolved'}`}
              style="font-size:10px;text-transform:uppercase;letter-spacing:0.04em"
            >
              {badge.label}
            </span>
          )}
        </div>
        <a
          href={cosHref}
          style="font-size:11px;color:var(--pw-text-muted);text-decoration:none"
          title="Open Chief of Staff for this app"
        >
          Open in Chief of Staff &rarr;
        </a>
      </div>
      <div style="max-height:480px;overflow-y:auto">
        {data.messages.length === 0 ? (
          <div style="padding:16px;font-size:12px;color:var(--pw-text-faint)">No messages yet.</div>
        ) : (
          data.messages.map((m) => <MessageRow key={m.id} msg={m} />)
        )}
      </div>
      <div style="display:flex;gap:6px;padding:10px 12px;border-top:1px solid var(--pw-border-subtle, rgba(255,255,255,0.06));background:var(--pw-bg-surface, transparent)">
        <textarea
          value={noteText.value}
          onInput={(e) => (noteText.value = (e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void sendNote();
            }
          }}
          placeholder="Add a note (Cmd/Ctrl+Enter to send)…"
          disabled={sending.value}
          rows={2}
          style="flex:1;padding:6px 8px;font-size:13px;font-family:inherit;background:var(--pw-input-bg);color:var(--pw-primary-text);border:1px solid var(--pw-border, rgba(255,255,255,0.12));border-radius:4px;resize:vertical"
        />
        <button
          class="btn btn-sm btn-primary"
          disabled={sending.value || !noteText.value.trim()}
          onClick={() => void sendNote()}
        >
          {sending.value ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
