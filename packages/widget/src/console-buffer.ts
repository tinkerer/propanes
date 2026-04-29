// Ring buffer of recent console messages + uncaught errors on the host page.
// Patched at widget construction time so the composer's "Console capture"
// affordance can attach the last N entries to a feedback submission.
//
// Mirrors packages/admin/src/lib/console-buffer.ts. Lives inside the widget
// package because the widget ships standalone and can't import admin code.

const MAX_ENTRIES = 200;

export type ConsoleEntry = {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  time: number;
  text: string;
};

const buffer: ConsoleEntry[] = [];
let installed = false;

function stringify(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  try { return JSON.stringify(arg); } catch { return String(arg); }
}

function push(level: ConsoleEntry['level'], args: unknown[]) {
  const text = args.map(stringify).join(' ');
  buffer.push({ level, time: Date.now(), text });
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
}

export function installWidgetConsoleBuffer() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const levels: ConsoleEntry['level'][] = ['log', 'info', 'warn', 'error', 'debug'];
  for (const level of levels) {
    const orig = console[level] as (...a: unknown[]) => void;
    console[level] = (...args: unknown[]) => {
      push(level, args);
      try { orig.apply(console, args); } catch { /* ignore */ }
    };
  }

  window.addEventListener('error', (e: ErrorEvent) => {
    push('error', [e.message, e.filename ? `(${e.filename}:${e.lineno}:${e.colno})` : '']);
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    push('error', ['Unhandled rejection:', e.reason]);
  });
}

export function snapshotWidgetConsole(): ConsoleEntry[] {
  return buffer.slice();
}

export function formatWidgetConsoleEntries(entries: ConsoleEntry[]): string {
  return entries.map((e) => {
    const ts = new Date(e.time).toISOString().slice(11, 23);
    return `[${ts}] ${e.level.toUpperCase()} ${e.text}`;
  }).join('\n');
}
