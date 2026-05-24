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

const MAX_PERF_ENTRIES = 80;
const LONG_TASK_THRESHOLD_MS = 80;
const EVENT_LOOP_STALL_THRESHOLD_MS = 200;
const EVENT_LOOP_SAMPLE_MS = 250;

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

export function recordPerfEntry(label: string, durationMs: number, timestamp = Date.now()) {
  const entry: PerfEntry = {
    label,
    durationMs: Math.round(durationMs),
    route: getRoute(),
    timestamp,
  };
  if (perfLogsEnabled.value) console.log(`[perf] ${label}: ${entry.durationMs}ms`);
  perfEntries.value = [...perfEntries.value.slice(-(MAX_PERF_ENTRIES - 1)), entry];
}

export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    recordPerfEntry(label, performance.now() - start);
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

export function getPerfReport() {
  return {
    route: getRoute(),
    entries: perfEntries.value.slice(-30),
    longTasks: perfEntries.value.filter((e) => e.label.startsWith('browser:') || e.label.startsWith('terminal:')).slice(-30),
  };
}

(window as any).pwPerfReport = () => {
  const report = getPerfReport();
  console.table(report.entries.map((e) => ({
    label: e.label,
    durationMs: e.durationMs,
    route: e.route,
    time: new Date(e.timestamp).toLocaleTimeString(),
  })));
  return report;
};

export function installBrowserFreezeInstrumentation() {
  try {
    if ('PerformanceObserver' in window) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < LONG_TASK_THRESHOLD_MS) continue;
          recordPerfEntry('browser:long-task', entry.duration, performance.timeOrigin + entry.startTime);
        }
      });
      observer.observe({ type: 'longtask', buffered: true } as PerformanceObserverInit);
    }
  } catch {
    // Long Task API is not available in every browser/context.
  }

  let expected = performance.now() + EVENT_LOOP_SAMPLE_MS;
  window.setInterval(() => {
    const now = performance.now();
    const drift = now - expected;
    expected = now + EVENT_LOOP_SAMPLE_MS;
    if (document.hidden) return;
    if (drift >= EVENT_LOOP_STALL_THRESHOLD_MS) {
      recordPerfEntry('browser:event-loop-stall', drift);
    }
  }, EVENT_LOOP_SAMPLE_MS);
}

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
