// Ring buffers + lightweight collectors for the admin page's "browser
// context" capture button. Mirrors the widget's collectors (Console / Page
// info / Network / Perf) so operators can attach the same kind of context
// when chatting with CoS that they'd attach when filing widget feedback.

const MAX_CONSOLE = 200;
const MAX_NETWORK = 50;

import { signal, effect } from '@preact/signals';

export type ConsoleEntry = {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  time: number;
  text: string;
};

export type NetworkError = {
  url: string;
  method: string;
  status: number;
  statusText: string;
  time: number;
};

export type PerformanceTiming = {
  loadTime?: number;
  domContentLoaded?: number;
  firstContentfulPaint?: number;
};

export type EnvironmentInfo = {
  userAgent: string;
  language: string;
  platform: string;
  screenResolution: string;
  viewport: string;
  url: string;
  referrer: string;
  time: number;
};

export type CosCollector = 'console' | 'environment' | 'network' | 'performance';

export type CosBrowserContext = {
  console?: ConsoleEntry[];
  network?: NetworkError[];
  performance?: PerformanceTiming;
  environment?: EnvironmentInfo;
};

const consoleBuffer: ConsoleEntry[] = [];
const networkBuffer: NetworkError[] = [];
let consoleInstalled = false;
let networkInstalled = false;

function stringify(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  try { return JSON.stringify(arg); } catch { return String(arg); }
}

function pushConsole(level: ConsoleEntry['level'], args: unknown[]) {
  const text = args.map(stringify).join(' ');
  consoleBuffer.push({ level, time: Date.now(), text });
  if (consoleBuffer.length > MAX_CONSOLE) consoleBuffer.splice(0, consoleBuffer.length - MAX_CONSOLE);
}

export function installConsoleBuffer() {
  if (consoleInstalled || typeof window === 'undefined') return;
  consoleInstalled = true;

  const levels: ConsoleEntry['level'][] = ['log', 'info', 'warn', 'error', 'debug'];
  for (const level of levels) {
    const orig = console[level] as (...a: unknown[]) => void;
    console[level] = (...args: unknown[]) => {
      pushConsole(level, args);
      orig.apply(console, args);
    };
  }

  window.addEventListener('error', (e: ErrorEvent) => {
    pushConsole('error', [e.message, e.filename ? `(${e.filename}:${e.lineno}:${e.colno})` : '']);
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    pushConsole('error', ['Unhandled rejection:', e.reason]);
  });
}

export function installNetworkCollector() {
  if (networkInstalled || typeof window === 'undefined') return;
  networkInstalled = true;
  const origFetch = window.fetch;
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    let url = '';
    let method = 'GET';
    try {
      const req = new Request(args[0] as RequestInfo, args[1]);
      url = req.url;
      method = req.method;
    } catch { /* ignore — fall through with defaults */ }
    try {
      const res = await origFetch(...args);
      if (!res.ok) {
        networkBuffer.push({ url, method, status: res.status, statusText: res.statusText, time: Date.now() });
        if (networkBuffer.length > MAX_NETWORK) networkBuffer.splice(0, networkBuffer.length - MAX_NETWORK);
      }
      return res;
    } catch (err) {
      networkBuffer.push({
        url, method,
        status: 0,
        statusText: err instanceof Error ? err.message : 'Network error',
        time: Date.now(),
      });
      if (networkBuffer.length > MAX_NETWORK) networkBuffer.splice(0, networkBuffer.length - MAX_NETWORK);
      throw err;
    }
  };
}

export function getPerformanceTiming(): PerformanceTiming {
  if (typeof performance === 'undefined') return {};
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const paint = performance.getEntriesByType('paint');
  const result: PerformanceTiming = {};
  if (nav) {
    result.loadTime = Math.round(nav.loadEventEnd - nav.startTime);
    result.domContentLoaded = Math.round(nav.domContentLoadedEventEnd - nav.startTime);
  }
  const fcp = paint.find((e) => e.name === 'first-contentful-paint');
  if (fcp) result.firstContentfulPaint = Math.round(fcp.startTime);
  return result;
}

export function getEnvironment(): EnvironmentInfo {
  return {
    userAgent: navigator.userAgent,
    language: navigator.language,
    platform: navigator.platform,
    screenResolution: `${screen.width}x${screen.height}`,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    url: location.href,
    referrer: document.referrer,
    time: Date.now(),
  };
}

export function snapshotConsole(): ConsoleEntry[] {
  return consoleBuffer.slice();
}

/** Capture the selected collectors. Console + Network read from the
 *  pre-installed ring buffers; Performance + Environment are sampled at call
 *  time. Returns only the keys that were actually selected, so the caller
 *  can render a chip per selection. */
export function snapshotBrowserContext(collectors: Iterable<CosCollector>): CosBrowserContext {
  const set = collectors instanceof Set ? collectors : new Set(collectors);
  const out: CosBrowserContext = {};
  if (set.has('console')) out.console = consoleBuffer.slice();
  if (set.has('network')) out.network = networkBuffer.slice();
  if (set.has('performance')) out.performance = getPerformanceTiming();
  if (set.has('environment')) out.environment = getEnvironment();
  return out;
}

/** Format a chip label like "console · 12 entries · network · 3" so the
 *  attach strip can show what was captured without four separate chips. */
export function summarizeBrowserContext(ctx: CosBrowserContext): string {
  const parts: string[] = [];
  if (ctx.console) parts.push(`console · ${ctx.console.length}`);
  if (ctx.network) parts.push(`network · ${ctx.network.length}`);
  if (ctx.performance) parts.push('perf');
  if (ctx.environment) parts.push('page info');
  return parts.join(' · ') || 'no context';
}

export function formatConsoleEntries(entries: ConsoleEntry[]): string {
  return entries.map((e) => {
    const ts = new Date(e.time).toISOString().slice(11, 23);
    return `[${ts}] ${e.level.toUpperCase()} ${e.text}`;
  }).join('\n');
}

function formatNetworkEntries(entries: NetworkError[]): string {
  return entries.map((e) => {
    const ts = new Date(e.time).toISOString().slice(11, 23);
    return `[${ts}] ${e.method} ${e.url} → ${e.status || 'ERR'} ${e.statusText}`;
  }).join('\n');
}

function formatPerformance(p: PerformanceTiming): string {
  const lines: string[] = [];
  if (p.loadTime !== undefined) lines.push(`load: ${p.loadTime}ms`);
  if (p.domContentLoaded !== undefined) lines.push(`DOMContentLoaded: ${p.domContentLoaded}ms`);
  if (p.firstContentfulPaint !== undefined) lines.push(`first-contentful-paint: ${p.firstContentfulPaint}ms`);
  return lines.join('\n');
}

function formatEnvironment(e: EnvironmentInfo): string {
  return [
    `URL: ${e.url}`,
    `Referrer: ${e.referrer || '(none)'}`,
    `Viewport: ${e.viewport}`,
    `Screen: ${e.screenResolution}`,
    `Platform: ${e.platform}`,
    `Lang: ${e.language}`,
    `UA: ${e.userAgent}`,
  ].join('\n');
}

/** Tail-trim per-section so a runaway console buffer can't blow the prompt
 *  budget. Roughly mirrors the existing 4000-char clamp from InterruptBar. */
export function formatBrowserContext(ctx: CosBrowserContext): string {
  const blocks: string[] = [];
  if (ctx.console && ctx.console.length > 0) {
    const body = formatConsoleEntries(ctx.console).slice(-4000);
    blocks.push(`Recent browser console output:\n\`\`\`\n${body}\n\`\`\``);
  }
  if (ctx.network && ctx.network.length > 0) {
    const body = formatNetworkEntries(ctx.network).slice(-2000);
    blocks.push(`Recent network errors:\n\`\`\`\n${body}\n\`\`\``);
  }
  if (ctx.performance && Object.keys(ctx.performance).length > 0) {
    blocks.push(`Performance timing:\n\`\`\`\n${formatPerformance(ctx.performance)}\n\`\`\``);
  }
  if (ctx.environment) {
    blocks.push(`Page info:\n\`\`\`\n${formatEnvironment(ctx.environment)}\n\`\`\``);
  }
  return blocks.join('\n\n');
}

// Persisted operator preference for which collectors the console split-button
// should grab on click. Mirrors the widget's `savedCollectors` Set.
const SELECTED_KEY = 'pw-cos-selected-collectors-v1';

function loadSelected(): Set<CosCollector> {
  try {
    if (typeof localStorage === 'undefined') return new Set(['console']);
    const raw = localStorage.getItem(SELECTED_KEY);
    if (!raw) return new Set(['console']);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(['console']);
    const valid: CosCollector[] = parsed.filter((v): v is CosCollector =>
      v === 'console' || v === 'network' || v === 'performance' || v === 'environment',
    );
    return valid.length > 0 ? new Set(valid) : new Set(['console']);
  } catch {
    return new Set(['console']);
  }
}

export const cosSelectedCollectors = signal<Set<CosCollector>>(loadSelected());

effect(() => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SELECTED_KEY, JSON.stringify(Array.from(cosSelectedCollectors.value)));
  } catch { /* quota — ignore */ }
});

export function setCollectorSelected(c: CosCollector, on: boolean): void {
  const next = new Set(cosSelectedCollectors.value);
  if (on) next.add(c); else next.delete(c);
  cosSelectedCollectors.value = next;
}
