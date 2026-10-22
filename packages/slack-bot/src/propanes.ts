/** Authenticated API access; keep credentials out of URLs, errors and logs. */
export function createPropanesFetch(
  baseUrl: string,
  token: string | undefined,
  request: typeof fetch = fetch,
) {
  if (!token?.trim()) throw new Error('Configure PROPANES_TOKEN for the Slack listener.');
  return async (path: string, opts?: RequestInit): Promise<any> => {
    const headers = new Headers(opts?.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${token.trim()}`);
    const response = await request(`${baseUrl}${path}`, {
      ...opts,
      headers,
      signal: opts?.signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Propanes ${path} → ${response.status}`);
    return response.json();
  };
}
