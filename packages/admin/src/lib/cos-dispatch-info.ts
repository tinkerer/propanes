export type ChiefOfStaffToolCall = {
  id?: string;
  name: string;
  input: Record<string, unknown>;
  result?: unknown;
  error?: string;
};

export type DispatchInfo = {
  feedbackId: string;
  sessionId: string | null;
};

/**
 * Inspect a tool call and, if it was a feedback dispatch, return the feedbackId
 * (always, parsed from the Bash command) and sessionId (when the call's result
 * has been hydrated). Returns null if this call isn't a dispatch.
 *
 * Works for both `POST /api/v1/admin/feedback/<id>/dispatch` and
 * `POST /api/v1/admin/dispatch` with a `{"feedbackId":"..."}` body.
 */
export function extractDispatchInfo(call: ChiefOfStaffToolCall): DispatchInfo | null {
  if (call.error) return null;
  if (call.name !== 'Bash') return null;
  const cmd = typeof call.input?.command === 'string' ? (call.input.command as string) : '';
  if (!cmd) return null;
  if (!/-X\s+POST/i.test(cmd)) return null;

  // Path-style: /api/v1/admin/feedback/<id>/dispatch
  let feedbackId: string | null = null;
  const pathMatch = cmd.match(/\/api\/v1\/admin\/feedback\/([A-Z0-9]{20,})\/dispatch/i);
  if (pathMatch) {
    feedbackId = pathMatch[1];
  } else {
    // Body-style: /api/v1/admin/dispatch with -d '{"feedbackId":"<id>",...}'
    if (!/\/api\/v1\/admin\/dispatch\b/.test(cmd)) return null;
    const bodyMatch = cmd.match(/["']feedbackId["']\s*:\s*["']([A-Z0-9]{20,})["']/i);
    if (!bodyMatch) return null;
    feedbackId = bodyMatch[1];
  }

  // Pull sessionId from the result when available (live stream or rehydrated).
  let sessionId: string | null = null;
  const res = call.result;
  if (typeof res === 'string' && res.trim()) {
    const m = res.match(/["']sessionId["']\s*:\s*["']([A-Za-z0-9-]+)["']/);
    if (m) sessionId = m[1];
  } else if (res && typeof res === 'object' && typeof (res as any).sessionId === 'string') {
    sessionId = (res as any).sessionId;
  }

  return { feedbackId, sessionId };
}
