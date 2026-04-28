import { useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { api } from '../lib/api.js';
import { formatDate } from '../lib/date-utils.js';

interface Props {
  feedbackId: string;
}

type Trace = Awaited<ReturnType<typeof api.getFeedbackVoiceTrace>>;

const REASON_BADGE: Record<string, string> = {
  'too-short': 'badge-skip',
  'no-action-verb': 'badge-skip',
  'hedged': 'badge-skip',
  'heuristic-action-verb': 'badge-actionable',
  'ai-classifier': 'badge-actionable',
};

function reasonClass(reason: string | undefined, actionable: boolean): string {
  if (!reason) return actionable ? 'vt-badge-actionable' : 'vt-badge-skip';
  if (REASON_BADGE[reason]) return `vt-${REASON_BADGE[reason]}`;
  return actionable ? 'vt-badge-actionable' : 'vt-badge-skip';
}

function durationSecs(startedAt: string, endedAt: string): string {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  return `${(ms / 1000).toFixed(1)}s`;
}

export function VoiceTracePanel({ feedbackId }: Props) {
  const trace = useSignal<Trace | null>(null);
  const loading = useSignal(true);
  const error = useSignal<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loading.value = true;
    error.value = null;
    api.getFeedbackVoiceTrace(feedbackId)
      .then((res) => {
        if (cancelled) return;
        trace.value = res;
        loading.value = false;
      })
      .catch((err) => {
        if (cancelled) return;
        error.value = err?.message || 'Failed to load voice trace';
        loading.value = false;
      });
    return () => { cancelled = true; };
  }, [feedbackId]);

  if (loading.value) {
    return <div class="vt-empty">Loading pipeline trace…</div>;
  }
  if (error.value) {
    return <div class="vt-empty vt-error">{error.value}</div>;
  }
  const t = trace.value;
  if (!t || !t.voiceSession) {
    return null;
  }

  const sortedTranscripts = [...t.transcripts].sort((a, b) => a.windowIndex - b.windowIndex);
  const matchIdx = sortedTranscripts.findIndex((x) => x.isMatch);
  const totalChunks = sortedTranscripts.length;
  const actionableChunks = sortedTranscripts.filter((x) => x.classification?.actionable).length;

  return (
    <div class="vt-panel">
      <div class="vt-summary-row">
        <div class="vt-stat">
          <div class="vt-stat-label">Voice session</div>
          <div class="vt-stat-value vt-mono" title={t.voiceSession.id}>
            {t.voiceSession.id.slice(-8)}
          </div>
        </div>
        <div class="vt-stat">
          <div class="vt-stat-label">Started</div>
          <div class="vt-stat-value">{formatDate(t.voiceSession.startedAt)}</div>
        </div>
        <div class="vt-stat">
          <div class="vt-stat-label">Chunks</div>
          <div class="vt-stat-value">{totalChunks}</div>
        </div>
        <div class="vt-stat">
          <div class="vt-stat-label">Actionable</div>
          <div class="vt-stat-value">{actionableChunks}</div>
        </div>
        <div class="vt-stat">
          <div class="vt-stat-label">This suggestion</div>
          <div class="vt-stat-value">{matchIdx >= 0 ? `chunk #${sortedTranscripts[matchIdx].windowIndex}` : '—'}</div>
        </div>
      </div>

      {t.conversationSummary && (
        <div class="vt-summary-block">
          <div class="vt-block-label">Conversation summary fed to classifier</div>
          <div class="vt-summary-text">{t.conversationSummary}</div>
        </div>
      )}

      <div class="vt-pipeline">
        <div class="vt-pipeline-step">
          <div class="vt-pipeline-step-num">1</div>
          <div class="vt-pipeline-step-body">
            <div class="vt-pipeline-step-title">Transcribe</div>
            <div class="vt-pipeline-step-desc">{totalChunks} rolling window{totalChunks === 1 ? '' : 's'} captured from listen mode.</div>
          </div>
        </div>
        <div class="vt-pipeline-arrow">→</div>
        <div class="vt-pipeline-step">
          <div class="vt-pipeline-step-num">2</div>
          <div class="vt-pipeline-step-body">
            <div class="vt-pipeline-step-title">Classify</div>
            <div class="vt-pipeline-step-desc">Heuristic + Claude haiku decides actionability per chunk.</div>
          </div>
        </div>
        <div class="vt-pipeline-arrow">→</div>
        <div class="vt-pipeline-step vt-pipeline-step-active">
          <div class="vt-pipeline-step-num">3</div>
          <div class="vt-pipeline-step-body">
            <div class="vt-pipeline-step-title">Suggest</div>
            <div class="vt-pipeline-step-desc">
              {matchIdx >= 0
                ? `Chunk #${sortedTranscripts[matchIdx].windowIndex} produced this feedback item.`
                : 'No matched chunk recorded.'}
            </div>
          </div>
        </div>
      </div>

      <div class="vt-block-label">Chunk → classification trail</div>
      <ol class="vt-chunks">
        {sortedTranscripts.map((chunk) => {
          const cls = chunk.classification;
          const actionable = !!cls?.actionable;
          return (
            <li
              key={chunk.id}
              class={`vt-chunk ${chunk.isMatch ? 'vt-chunk-match' : ''} ${actionable ? 'vt-chunk-actionable' : 'vt-chunk-skipped'}`}
            >
              <div class="vt-chunk-header">
                <span class="vt-chunk-index">#{chunk.windowIndex}</span>
                <span class={`vt-badge ${reasonClass(cls?.reason, actionable)}`}>
                  {actionable ? 'actionable' : 'skipped'}
                </span>
                {cls?.reason && <span class="vt-chunk-reason" title="Classifier reason">{cls.reason}</span>}
                <span class="vt-chunk-duration">{durationSecs(chunk.startedAt, chunk.endedAt)}</span>
                {chunk.isMatch && <span class="vt-chunk-match-tag">→ this suggestion</span>}
                {!chunk.isMatch && chunk.feedbackId && (
                  <a class="vt-chunk-other-link" href={`#/tickets/${chunk.feedbackId}`} title="View other feedback this chunk produced">
                    other ticket ↗
                  </a>
                )}
              </div>
              <div class="vt-chunk-text">{chunk.text}</div>
              {actionable && cls && (
                <div class="vt-chunk-classification">
                  <div class="vt-chunk-classification-row">
                    <span class="vt-chunk-classification-label">Title</span>
                    <span class="vt-chunk-classification-value">{cls.title || '—'}</span>
                  </div>
                  {cls.description && cls.description !== chunk.text && (
                    <div class="vt-chunk-classification-row">
                      <span class="vt-chunk-classification-label">Description</span>
                      <span class="vt-chunk-classification-value">{cls.description}</span>
                    </div>
                  )}
                  {cls.appName && (
                    <div class="vt-chunk-classification-row">
                      <span class="vt-chunk-classification-label">Routed to</span>
                      <span class="vt-chunk-classification-value">{cls.appName}</span>
                    </div>
                  )}
                  {cls.tags && cls.tags.length > 0 && (
                    <div class="vt-chunk-classification-row">
                      <span class="vt-chunk-classification-label">Tags</span>
                      <span class="vt-chunk-classification-value">
                        {cls.tags.map((tag) => (
                          <span key={tag} class="vt-tag">{tag}</span>
                        ))}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
