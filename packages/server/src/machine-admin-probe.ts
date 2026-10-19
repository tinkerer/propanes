export interface AdminProbeResult {
  alive: boolean;
  // Something answered, but it was an auth gateway redirect, not ProPanes itself.
  gated?: boolean;
  status?: number;
  reason?: string;
}

export function adminHealthUrl(adminUrl: string): string {
  const base = adminUrl.endsWith('/') ? adminUrl : `${adminUrl}/`;
  return new URL('../api/v1/health', base).toString();
}

// Probes the unauthenticated health route without following redirects: a
// gateway (e.g. SSO front door) answers every path with a 302 to its login
// page, and following it lands on a 200 that says nothing about ProPanes.
export async function probeAdminUrl(
  adminUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<AdminProbeResult> {
  try {
    const res = await fetchImpl(adminHealthUrl(adminUrl), {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { alive: true, status: res.status };
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      let host = location ?? 'unknown location';
      try { if (location) host = new URL(location, adminUrl).host; } catch {}
      return { alive: false, gated: true, status: res.status, reason: `redirected to ${host}` };
    }
    return { alive: false, status: res.status };
  } catch (err: any) {
    return { alive: false, reason: err.message };
  }
}
