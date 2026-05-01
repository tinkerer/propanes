import { perfEntries, perfOverlayEnabled, clearPerfEntries } from '../lib/perf.js';

function durationClass(ms: number): string {
  if (ms >= 500) return 'perf-overlay-duration slow';
  if (ms >= 200) return 'perf-overlay-duration medium';
  return 'perf-overlay-duration';
}

export function PerfOverlay() {
  if (!perfOverlayEnabled.value) return null;
  const entries = perfEntries.value;
  if (entries.length === 0) return null;

  const total = entries.reduce((sum, e) => sum + e.durationMs, 0);

  return (
    <div class="perf-overlay">
      <div class="perf-overlay-header">
        <span class={durationClass(total)}>{total}ms</span>
        <button class="perf-overlay-close" onClick={clearPerfEntries}>{'\u00D7'}</button>
      </div>
      {entries.map((e, i) => (
        <div key={i} class="perf-overlay-entry">
          <span class="perf-overlay-label">{e.label}</span>
          <span class={durationClass(e.durationMs)}>{e.durationMs}ms</span>
        </div>
      ))}
    </div>
  );
}
