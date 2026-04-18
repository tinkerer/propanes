import type { ConsoleEntry, NetworkError, PerformanceTiming, EnvironmentInfo, FeedbackContext, Collector } from '@prompt-widget/shared';

const consoleLogs: ConsoleEntry[] = [];
const networkErrors: NetworkError[] = [];
const MAX_ENTRIES = 50;

let consoleInstalled = false;
let networkInstalled = false;

export function installConsoleCollector() {
  if (consoleInstalled) return;
  consoleInstalled = true;

  const levels = ['log', 'warn', 'error', 'info', 'debug'] as const;
  for (const level of levels) {
    const original = console[level];
    console[level] = (...args: unknown[]) => {
      consoleLogs.push({
        level,
        message: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
        timestamp: Date.now(),
      });
      if (consoleLogs.length > MAX_ENTRIES) consoleLogs.shift();
      original.apply(console, args);
    };
  }
}

export function installNetworkCollector() {
  if (networkInstalled) return;
  networkInstalled = true;

  const origFetch = window.fetch;
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const req = new Request(...args);
    try {
      const res = await origFetch(...args);
      if (!res.ok) {
        networkErrors.push({
          url: req.url,
          method: req.method,
          status: res.status,
          statusText: res.statusText,
          timestamp: Date.now(),
        });
        if (networkErrors.length > MAX_ENTRIES) networkErrors.shift();
      }
      return res;
    } catch (err) {
      networkErrors.push({
        url: req.url,
        method: req.method,
        status: 0,
        statusText: err instanceof Error ? err.message : 'Network error',
        timestamp: Date.now(),
      });
      if (networkErrors.length > MAX_ENTRIES) networkErrors.shift();
      throw err;
    }
  };
}

export function getPerformanceTiming(): PerformanceTiming {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const paint = performance.getEntriesByType('paint');

  const result: PerformanceTiming = {};
  if (nav) {
    result.loadTime = nav.loadEventEnd - nav.startTime;
    result.domContentLoaded = nav.domContentLoadedEventEnd - nav.startTime;
  }
  const fcp = paint.find((e) => e.name === 'first-contentful-paint');
  if (fcp) result.firstContentfulPaint = fcp.startTime;

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
    timestamp: Date.now(),
  };
}

export function collectContext(collectors: Collector[]): FeedbackContext {
  const ctx: FeedbackContext = {};
  if (collectors.includes('console')) ctx.consoleLogs = [...consoleLogs];
  if (collectors.includes('network')) ctx.networkErrors = [...networkErrors];
  if (collectors.includes('performance')) ctx.performanceTiming = getPerformanceTiming();
  if (collectors.includes('environment')) ctx.environment = getEnvironment();
  return ctx;
}

export function installCollectors(collectors: Collector[]) {
  if (collectors.includes('console')) installConsoleCollector();
  if (collectors.includes('network')) installNetworkCollector();
}
