// Ring buffer of the last N console messages + uncaught errors on the admin
// page. Patched at module-load time from main.tsx so the InterruptBar capture
// button can include recent console output as context when resuming a session.

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

export function installConsoleBuffer() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const levels: ConsoleEntry['level'][] = ['log', 'info', 'warn', 'error', 'debug'];
  for (const level of levels) {
    const orig = console[level] as (...a: unknown[]) => void;
    console[level] = (...args: unknown[]) => {
      push(level, args);
      orig.apply(console, args);
    };
  }

  window.addEventListener('error', (e: ErrorEvent) => {
    push('error', [e.message, e.filename ? `(${e.filename}:${e.lineno}:${e.colno})` : '']);
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    push('error', ['Unhandled rejection:', e.reason]);
  });
}

export function snapshotConsole(): ConsoleEntry[] {
  return buffer.slice();
}

export function formatConsoleEntries(entries: ConsoleEntry[]): string {
  return entries.map((e) => {
    const ts = new Date(e.time).toISOString().slice(11, 23);
    return `[${ts}] ${e.level.toUpperCase()} ${e.text}`;
  }).join('\n');
}
