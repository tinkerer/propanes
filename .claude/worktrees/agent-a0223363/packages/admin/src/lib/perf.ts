import { signal, effect, type Signal } from '@preact/signals';

export interface PerfEntry {
  label: string;
  durationMs: number;
  route: string;
  timestamp: number;
}

function loadBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export const perfEntries = signal<PerfEntry[]>([]);
export const perfOverlayEnabled = signal<boolean>(loadBool('pw-perf-overlay', false));
export const perfServerEnabled = signal<boolean>(loadBool('pw-perf-server', false));
export const perfLogsEnabled = signal<boolean>(loadBool('pw-perf-logs', false));

effect(() => {
  localStorage.setItem('pw-perf-overlay', JSON.stringify(perfOverlayEnabled.value));
});

effect(() => {
  localStorage.setItem('pw-perf-server', JSON.stringify(perfServerEnabled.value));
});

effect(() => {
  localStorage.setItem('pw-perf-logs', JSON.stringify(perfLogsEnabled.value));
});

// Late-bound reference to currentRoute to break circular dep (state -> perf -> state)
let _routeSignal: Signal<string> | null = null;
export function bindRouteSignal(s: Signal<string>) {
  _routeSignal = s;

  let prevRoute = s.value;
  effect(() => {
    const route = s.value;
    if (route !== prevRoute) {
      flushToServer();
      clearPerfEntries();
      prevRoute = route;
    }
  });
}

function getRoute(): string {
  return _routeSignal?.value ?? '';
}

export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const durationMs = Math.round(performance.now() - start);
    const entry: PerfEntry = {
      label,
      durationMs,
      route: getRoute(),
      timestamp: Date.now(),
    };
    if (perfLogsEnabled.value) console.log(`[perf] ${label}: ${durationMs}ms`);
    perfEntries.value = [...perfEntries.value, entry];
  }
}

export function clearPerfEntries() {
  perfEntries.value = [];
}

// Console helper: type `pwPerf()` or `pwPerf(true)` / `pwPerf(false)` to toggle perf logs
(window as any).pwPerf = (enable?: boolean) => {
  perfLogsEnabled.value = enable ?? !perfLogsEnabled.value;
  console.log(`[perf] console logging ${perfLogsEnabled.value ? 'ON' : 'OFF'}`);
  return perfLogsEnabled.value;
};

export function flushToServer() {
  if (!perfServerEnabled.value) return;
  const entries = perfEntries.value;
  if (entries.length === 0) return;

  const route = entries[0].route;
  const durations: Record<string, number> = {};
  for (const e of entries) {
    durations[e.label] = e.durationMs;
  }

  const token = localStorage.getItem('pw-admin-token');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  fetch('/api/v1/admin/perf-metrics', {
    method: 'POST',
    headers,
    body: JSON.stringify({ route, timestamp: Date.now(), durations }),
  }).catch(() => {});
}
