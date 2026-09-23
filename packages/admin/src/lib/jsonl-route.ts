// Helpers for the transcript delta endpoint's POST -> GET fallback (see
// api.getJsonlDelta). Kept free of browser globals so they can be unit-tested.

// True when a response is the router's own "no such route" answer rather than
// a handler's 404. Handlers always answer with a JSON `{ error }` body (e.g.
// "Session not found"); the router answers 404/405 with plain text.
export async function isMissingRouteResponse(res: Response): Promise<boolean> {
  if (res.status !== 404 && res.status !== 405) return false;
  try {
    const body = await res.clone().json();
    return !(body && typeof body === 'object' && 'error' in body);
  } catch {
    return true;
  }
}

export function jsonlDeltaQuery(
  cursor: string,
  opts: { fileFilter?: string; tail?: number },
): string {
  const params = new URLSearchParams({ cursor });
  if (opts.fileFilter) params.set('file', opts.fileFilter);
  if (opts.tail && opts.tail > 0) params.set('tail', String(opts.tail));
  return params.toString();
}
