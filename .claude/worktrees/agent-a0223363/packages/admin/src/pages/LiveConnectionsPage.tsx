import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { useState } from 'preact/hooks';
import { api } from '../lib/api.js';

interface ActivityEntry {
  ts: string;
  command: string;
  category: string;
  ok: boolean;
  durationMs: number;
}

interface LiveConnection {
  sessionId: string;
  connectedAt: string;
  lastActivity: string;
  userAgent: string | null;
  url: string | null;
  viewport: string | null;
  userId: string | null;
  appId: string | null;
  name: string | null;
  tags: string[];
  activityLog: ActivityEntry[];
}

const connections = signal<LiveConnection[]>([]);
const loading = signal(false);

async function loadConnections() {
  try {
    connections.value = await api.getLiveConnections();
  } catch {
    // ignore
  } finally {
    loading.value = false;
  }
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return '\u2014';
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatDuration(dateStr: string | null): string {
  if (!dateStr) return '\u2014';
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function isIdle(lastActivity: string): boolean {
  return Date.now() - new Date(lastActivity).getTime() > 30_000;
}

function parseBrowser(ua: string | null): string {
  if (!ua) return '\u2014';
  if (ua.includes('Chrome/') && !ua.includes('Edg/')) return 'Chrome';
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('Firefox/')) return 'Firefox';
  if (ua.includes('Safari/') && !ua.includes('Chrome')) return 'Safari';
  return 'Other';
}

function shortenUrl(url: string | null): string {
  if (!url) return '\u2014';
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    const hash = u.hash || '';
    return `${u.host}${path}${hash}`;
  } catch {
    return url;
  }
}

const CATEGORY_LABELS: Record<string, string> = {
  screenshot: 'Screenshots',
  script: 'Scripts',
  mouse: 'Mouse',
  keyboard: 'Keyboard',
  interaction: 'Interactions',
  navigation: 'Navigation',
  inspect: 'Inspections',
  widget: 'Widget',
  other: 'Other',
};

function summarizeActivity(log: ActivityEntry[]): { category: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of log) {
    counts.set(entry.category, (counts.get(entry.category) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([category, count]) => ({ category, label: CATEGORY_LABELS[category] || category, count }))
    .sort((a, b) => b.count - a.count);
}

function ActivityBadges({ log }: { log: ActivityEntry[] }) {
  const summary = summarizeActivity(log);
  if (summary.length === 0) return <span style={{ color: 'var(--pw-text-faint)' }}>{'\u2014'}</span>;

  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
      {summary.map((s) => (
        <span
          key={s.category}
          class="activity-badge"
          data-category={s.category}
          title={`${s.count} ${s.label.toLowerCase()}`}
        >
          {s.count} {s.label.toLowerCase()}
        </span>
      ))}
    </span>
  );
}

function ActivityDetail({ log }: { log: ActivityEntry[] }) {
  const recent = log.slice(-50).reverse();
  if (recent.length === 0) {
    return <div style={{ padding: '8px 12px', color: 'var(--pw-text-faint)', fontSize: '12px' }}>No agent activity recorded</div>;
  }
  return (
    <div style={{ padding: '4px 12px 8px' }}>
      <table style={{ width: '100%', fontSize: '12px' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '2px 8px', color: 'var(--pw-text-muted)', fontWeight: 500 }}>Time</th>
            <th style={{ textAlign: 'left', padding: '2px 8px', color: 'var(--pw-text-muted)', fontWeight: 500 }}>Command</th>
            <th style={{ textAlign: 'left', padding: '2px 8px', color: 'var(--pw-text-muted)', fontWeight: 500 }}>Category</th>
            <th style={{ textAlign: 'right', padding: '2px 8px', color: 'var(--pw-text-muted)', fontWeight: 500 }}>Duration</th>
            <th style={{ textAlign: 'center', padding: '2px 8px', color: 'var(--pw-text-muted)', fontWeight: 500 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {recent.map((entry, i) => (
            <tr key={i} style={{ borderTop: i > 0 ? '1px solid var(--pw-border-light)' : undefined }}>
              <td style={{ padding: '3px 8px', whiteSpace: 'nowrap', color: 'var(--pw-text-muted)' }}>{formatRelativeTime(entry.ts)}</td>
              <td style={{ padding: '3px 8px', fontFamily: 'monospace', fontSize: '11px' }}>{entry.command}</td>
              <td style={{ padding: '3px 8px' }}>
                <span class="activity-badge" data-category={entry.category} style={{ fontSize: '10px' }}>
                  {CATEGORY_LABELS[entry.category] || entry.category}
                </span>
              </td>
              <td style={{ padding: '3px 8px', textAlign: 'right', whiteSpace: 'nowrap', color: 'var(--pw-text-muted)' }}>{entry.durationMs}ms</td>
              <td style={{ padding: '3px 8px', textAlign: 'center' }}>
                {entry.ok
                  ? <span style={{ color: 'var(--pw-success)' }}>ok</span>
                  : <span style={{ color: 'var(--pw-danger)' }}>err</span>
                }
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {log.length > 50 && (
        <div style={{ textAlign: 'center', padding: '4px', color: 'var(--pw-text-faint)', fontSize: '11px' }}>
          Showing 50 of {log.length} entries
        </div>
      )}
    </div>
  );
}

export function LiveConnectionsPage({ appId }: { appId?: string | null }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    loading.value = true;
    loadConnections();
    const interval = setInterval(loadConnections, 5_000);
    return () => clearInterval(interval);
  }, []);

  let filtered = connections.value;
  if (appId && appId !== '__unlinked__') {
    filtered = filtered.filter((c) => c.appId === appId);
  } else if (appId === '__unlinked__') {
    filtered = filtered.filter((c) => !c.appId);
  }

  const activeCount = filtered.filter((c) => !isIdle(c.lastActivity)).length;
  const idleCount = filtered.length - activeCount;

  return (
    <div>
      <div class="page-header">
        <h2>Live Connections ({filtered.length})</h2>
        <span style={{ color: 'var(--pw-text-muted)', fontSize: '13px' }}>
          {activeCount} active
          {idleCount > 0 && ` \u00b7 ${idleCount} idle`}
        </span>
      </div>

      {loading.value && filtered.length === 0 && (
        <p style={{ color: 'var(--pw-text-faint)', textAlign: 'center', padding: '24px' }}>Loading...</p>
      )}

      {!loading.value && filtered.length === 0 && (
        <p style={{ color: 'var(--pw-text-faint)', textAlign: 'center', padding: '24px' }}>
          No widget connections active. Open a page with the widget embedded to see it here.
        </p>
      )}

      {filtered.length > 0 && (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>URL</th>
                <th>Browser</th>
                <th>Viewport</th>
                <th>User</th>
                <th>Agent Activity</th>
                <th>Connected</th>
                <th>Last Active</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const idle = isIdle(c.lastActivity);
                const hasActivity = c.activityLog && c.activityLog.length > 0;
                const expanded = expandedId === c.sessionId;
                return (
                  <>
                    <tr
                      key={c.sessionId}
                      onClick={() => setExpandedId(expanded ? null : c.sessionId)}
                      style={{ cursor: hasActivity ? 'pointer' : undefined }}
                    >
                      <td>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span class={`session-status-dot ${idle ? 'pending' : 'running'}`} />
                          {idle ? 'idle' : 'active'}
                        </span>
                      </td>
                      <td title={c.url || undefined} style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {shortenUrl(c.url)}
                      </td>
                      <td>{parseBrowser(c.userAgent)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{c.viewport || '\u2014'}</td>
                      <td>{c.userId || c.name || '\u2014'}</td>
                      <td>
                        <ActivityBadges log={c.activityLog || []} />
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatDuration(c.connectedAt)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatRelativeTime(c.lastActivity)}</td>
                    </tr>
                    {expanded && hasActivity && (
                      <tr key={`${c.sessionId}-detail`}>
                        <td colSpan={8} style={{ padding: 0, background: 'var(--pw-bg-sunken)' }}>
                          <ActivityDetail log={c.activityLog} />
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
