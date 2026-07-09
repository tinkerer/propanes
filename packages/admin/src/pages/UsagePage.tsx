import { useEffect, useState } from 'preact/hooks';
import { api } from '../lib/api.js';

type Row = { key: string; sessions: number; totalWallMs: number; activeSessions: number };
type Usage = Awaited<ReturnType<typeof api.getUsage>>;

function fmtDuration(ms: number): string {
  if (!ms) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function UsagePage() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [sinceDays, setSinceDays] = useState(30);
  const [error, setError] = useState('');

  async function load(days: number) {
    try {
      setUsage(await api.getUsage(days));
    } catch (err: any) {
      setError(err.message || 'Failed to load usage');
    }
  }

  useEffect(() => {
    load(sinceDays);
  }, [sinceDays]);

  function table(title: string, rows: Row[]) {
    return (
      <div class="settings-section">
        <h3>{title}</h3>
        {rows.length === 0 && <div style="font-size:12px;color:var(--pw-text-muted)">No sessions in window.</div>}
        {rows.length > 0 && (
          <table style="width:100%;font-size:12px;border-collapse:collapse">
            <thead>
              <tr style="text-align:left;color:var(--pw-text-muted)">
                <th style="padding:4px 8px">Key</th>
                <th style="padding:4px 8px">Sessions</th>
                <th style="padding:4px 8px">Active</th>
                <th style="padding:4px 8px">Total wall time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} style="border-top:1px solid var(--pw-border,#2a2a2a)">
                  <td style="padding:4px 8px;font-family:monospace">{r.key}</td>
                  <td style="padding:4px 8px">{r.sessions}</td>
                  <td style="padding:4px 8px">{r.activeSessions}</td>
                  <td style="padding:4px 8px">{fmtDuration(r.totalWallMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  return (
    <div style="max-width:960px">
      <div class="page-header">
        <div>
          <h2>Usage</h2>
          <p style="font-size:13px;color:var(--pw-text-muted);margin-top:4px">
            Per-session meter — the accounting substrate for isolation classes, users, and orgs.
          </p>
        </div>
        <select value={String(sinceDays)} onChange={(e) => setSinceDays(Number((e.currentTarget as HTMLSelectElement).value))}>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </select>
      </div>

      {error && <div class="error-msg" style="margin-bottom:12px">{error}</div>}

      {usage && (
        <>
          <div class="settings-section">
            <h3>Totals</h3>
            <div style="display:flex;gap:24px;font-size:13px">
              <div><strong style="font-size:20px">{usage.totals.sessions}</strong><div style="color:var(--pw-text-muted)">sessions</div></div>
              <div><strong style="font-size:20px">{usage.totals.activeSessions}</strong><div style="color:var(--pw-text-muted)">active now</div></div>
              <div><strong style="font-size:20px">{fmtDuration(usage.totals.totalWallMs)}</strong><div style="color:var(--pw-text-muted)">total wall time</div></div>
            </div>
          </div>
          {table('By isolation class', usage.byIsolation)}
          {table('By user', usage.byUser)}
          {table('By org', usage.byOrg)}
        </>
      )}
    </div>
  );
}
