// base-path.ts — path-prefix awareness for proxied mounts.
//
// Served directly, the admin SPA lives at /admin/ (or the / and /<user>
// shells) and every server URL is root-relative ('/api/v1/…', '/ws/…').
// Embedded through a host page's reverse proxy the whole widget server is
// mounted under a path prefix — the platform dashboard mounts it at
// /propanes and the widget's overlay panels load /propanes/admin/ — so a
// root-relative URL escapes the mount and the HOST app answers it: assets
// come back as the host SPA's index.html (the white-iframe "text/html is not
// a module script" error) and API calls hit routes that don't exist.
//
// BASE_PATH is everything before the /admin marker in the document path
// ('' served directly, '/propanes' behind the dashboard). The install below
// patches fetch/WebSocket/EventSource once so every root-relative (or
// same-host absolute) server URL gets the prefix — call sites keep writing
// plain '/api/v1/…'. URLs that DON'T go through those constructors (img/audio
// src attributes, hrefs, window.open) must be wrapped in serverPath().
//
// The matching server half: app.ts serves the /admin/ shell with RELATIVE
// asset URLs so the bundle itself loads under any prefix.

const pathname = typeof window !== 'undefined' ? window.location.pathname : '';
const marker = pathname.match(/^(.*)\/admin(?:\/|$)/);
export const BASE_PATH: string = marker ? marker[1] : '';

/** Prefix a root-relative server path for use OUTSIDE fetch/WS/EventSource
 *  (img/audio src, href, window.open) — those go out unpatched. */
export function serverPath(path: string): string {
  if (!BASE_PATH || !path.startsWith('/') || path.startsWith(`${BASE_PATH}/`)) {
    return path;
  }
  return `${BASE_PATH}${path}`;
}

function rewriteUrl(input: string): string {
  try {
    const u = new URL(input, window.location.href);
    // Only same-host URLs target our server; ws(s): URLs compare by host
    // because their .origin is scheme-qualified.
    if (u.host !== window.location.host) return input;
    if (u.pathname.startsWith(`${BASE_PATH}/`)) return input; // already prefixed
    u.pathname = `${BASE_PATH}${u.pathname}`;
    return u.toString();
  } catch {
    return input;
  }
}

function install(): void {
  if (typeof window === 'undefined' || !BASE_PATH) return;

  const origFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' || input instanceof URL) {
      return origFetch(rewriteUrl(String(input)), init);
    }
    // Request object: clone onto the rewritten URL so method/headers/body ride along.
    return origFetch(new Request(rewriteUrl(input.url), input), init);
  }) as typeof window.fetch;

  const OrigWebSocket = window.WebSocket;
  window.WebSocket = class extends OrigWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(rewriteUrl(String(url)), protocols);
    }
  } as typeof WebSocket;

  const OrigEventSource = window.EventSource;
  window.EventSource = class extends OrigEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(rewriteUrl(String(url)), init);
    }
  } as typeof EventSource;
}

// Side-effect install on first import: main.tsx imports this module before
// anything that could issue a request, so the patch is in place for every
// module-scope fetch in the rest of the graph.
install();
