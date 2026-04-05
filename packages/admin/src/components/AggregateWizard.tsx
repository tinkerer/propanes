import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import { api } from '../lib/api.js';

export const aggregateWizardOpen = signal<string | null>(null);

export function openAggregateWizard(appId: string) {
  aggregateWizardOpen.value = appId;
}

export function AggregateWizard({ onTagFilter }: { onTagFilter?: (tag: string) => void }) {
  const appId = aggregateWizardOpen.value;
  if (!appId) return null;

  return <AggregateWizardInner appId={appId} onClose={() => { aggregateWizardOpen.value = null; }} onTagFilter={onTagFilter} />;
}

function AggregateWizardInner({ appId, onClose, onTagFilter }: { appId: string; onClose: () => void; onTagFilter?: (tag: string) => void }) {
  const [skipAggregated, setSkipAggregated] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ clustersFound: number; itemsTagged: number; themes: string[] } | null>(null);
  const [error, setError] = useState('');

  async function run() {
    setRunning(true);
    setError('');
    try {
      const res = await api.clusterAndTag({ appId, excludeAlreadyAggregated: skipAggregated });
      setResult(res);
    } catch (err: any) {
      setError(err.message || 'Clustering failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div class="dispatch-overlay" onClick={(e) => { if ((e.target as HTMLElement).classList.contains('dispatch-overlay')) onClose(); }}>
      <div class="dispatch-dialog" style="max-width:480px">
        <div class="dispatch-header">
          <h3>Aggregate Feedback</h3>
          <button class="dispatch-close" onClick={onClose}>&times;</button>
        </div>

        {!result ? (
          <div class="dispatch-body" style="padding:16px;display:flex;flex-direction:column;gap:12px">
            <p style="margin:0;color:var(--pw-text-muted);font-size:13px">
              Cluster feedback items by title similarity and tag them with theme labels.
            </p>
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
              <input
                type="checkbox"
                checked={skipAggregated}
                onChange={(e) => setSkipAggregated((e.target as HTMLInputElement).checked)}
              />
              Skip already-aggregated items
            </label>
            {error && <div style="color:var(--pw-error);font-size:13px">{error}</div>}
            <div style="display:flex;justify-content:flex-end;gap:8px">
              <button class="btn btn-sm" onClick={onClose}>Cancel</button>
              <button class="btn btn-sm btn-primary" onClick={run} disabled={running}>
                {running ? 'Running...' : 'Run'}
              </button>
            </div>
          </div>
        ) : (
          <div class="dispatch-body" style="padding:16px;display:flex;flex-direction:column;gap:12px">
            <div style="font-size:14px;font-weight:500">
              {result.clustersFound === 0
                ? 'No clusters found (items may be too unique).'
                : `Found ${result.clustersFound} cluster${result.clustersFound === 1 ? '' : 's'}, tagged ${result.itemsTagged} items.`}
            </div>
            {result.themes.length > 0 && (
              <div style="display:flex;flex-wrap:wrap;gap:4px">
                {result.themes.map((theme) => (
                  <button
                    key={theme}
                    class="tag"
                    style="cursor:pointer;border:none;background:var(--pw-tag-bg);color:var(--pw-tag-text);padding:2px 8px;border-radius:4px;font-size:12px"
                    onClick={() => { onClose(); onTagFilter?.(theme); }}
                    title="Filter by this tag"
                  >
                    {theme}
                  </button>
                ))}
              </div>
            )}
            <div style="display:flex;justify-content:flex-end">
              <button class="btn btn-sm btn-primary" onClick={onClose}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
