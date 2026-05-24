import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import { navigate } from '../../lib/state.js';
import { openSession } from '../../lib/sessions.js';
import { launchSpecUpdate } from '../../lib/spec-update.js';

export const aggregateWizardOpen = signal<string | null>(null);

export function openAggregateWizard(appId: string) {
  aggregateWizardOpen.value = appId;
}

export function AggregateWizard() {
  const appId = aggregateWizardOpen.value;
  if (!appId) return null;

  return <AggregateWizardInner appId={appId} onClose={() => { aggregateWizardOpen.value = null; }} />;
}

function AggregateWizardInner({ appId, onClose }: { appId: string; onClose: () => void }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{
    sessionId?: string;
    wikiDir: string;
    indexPath: string;
    ticketCount?: number;
    cosMessageCount?: number;
    sessionCount?: number;
    jsonlFileCount?: number;
    jsonlInputCount?: number;
    themeCount?: number;
    updatedAt: string;
  } | null>(null);
  const [error, setError] = useState('');

  async function run() {
    setRunning(true);
    setError('');
    try {
      const res = await launchSpecUpdate(appId);
      setResult(res);
      if (res.sessionId) openSession(res.sessionId);
    } catch (err: any) {
      setError(err.message || 'Spec update failed');
    } finally {
      setRunning(false);
    }
  }

  function viewSpec() {
    onClose();
    navigate(`/app/${appId}/spec`);
  }

  return (
    <div class="dispatch-overlay" onClick={(e) => { if ((e.target as HTMLElement).classList.contains('dispatch-overlay')) onClose(); }}>
      <div class="dispatch-dialog" style="max-width:480px">
        <div class="dispatch-header">
          <h3>Update Spec</h3>
          <button class="dispatch-close" onClick={onClose}>&times;</button>
        </div>

        {!result ? (
          <div class="dispatch-body" style="padding:16px;display:flex;flex-direction:column;gap:12px">
            <p style="margin:0;color:var(--pw-text-muted);font-size:13px">
              Build the app spec wiki from tickets, CoS thread inputs, and agent JSONL user prompts.
            </p>
            {error && <div style="color:var(--pw-error);font-size:13px">{error}</div>}
            <div style="display:flex;justify-content:flex-end;gap:8px">
              <button class="btn btn-sm" onClick={onClose}>Cancel</button>
              <button class="btn btn-sm btn-primary" onClick={run} disabled={running}>
                {running ? 'Updating...' : 'Update Spec'}
              </button>
            </div>
          </div>
        ) : (
          <div class="dispatch-body" style="padding:16px;display:flex;flex-direction:column;gap:12px">
            <div style="font-size:14px;font-weight:500">
              {result.sessionId ? 'Spec update session launched.' : 'Spec wiki updated.'}
            </div>
            <div style="font-size:13px;color:var(--pw-text-muted);line-height:1.6">
              {result.sessionId && <div>Session: <code>{result.sessionId}</code></div>}
              {result.ticketCount !== undefined && <div>Tickets consumed: {result.ticketCount}</div>}
              {result.cosMessageCount !== undefined && <div>CoS inputs consumed: {result.cosMessageCount}</div>}
              {result.sessionCount !== undefined && <div>Agent sessions scanned: {result.sessionCount}</div>}
              {result.jsonlInputCount !== undefined && <div>JSONL inputs extracted: {result.jsonlInputCount}</div>}
              <div>Index: <code>{result.indexPath}</code></div>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px">
              <button class="btn btn-sm" onClick={onClose}>Done</button>
              <button class="btn btn-sm btn-primary" onClick={viewSpec}>View Spec</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
