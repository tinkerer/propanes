// Helpers for deriving a compact "location" label from a feedback item's sourceUrl.

/**
 * Extract a short host label from a URL, e.g.:
 *   https://example.com:3443/admin -> "example.com"
 *   http://localhost:5174/admin    -> "localhost"
 *   http://192.0.2.10/admin        -> "192.0.2.10"
 *
 * The port is dropped for the default cases above but kept when it's the only
 * thing distinguishing two locations on the same host (e.g. localhost:3001 vs
 * localhost:5174), so different dev servers stay legible.
 */
export function hostLabel(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (!host) return null;
    // Keep an explicit non-default port for localhost / loopback / bare IPs,
    // where the port is usually what tells two environments apart.
    const isLocalish =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    if (isLocalish && u.port) return `${host}:${u.port}`;
    return host;
  } catch {
    return null;
  }
}
