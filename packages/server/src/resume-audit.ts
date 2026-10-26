import { randomUUID } from 'node:crypto';

export interface ResumeAuditContext {
  actorId: string;
  actorRole: string;
  peerAddress: string | null;
  userAgent: string | null;
  origin: string | null;
  referer: string | null;
  forwardedFor: string | null;
  source: string | null;
  clientId: string | null;
  page: string | null;
}

function bounded(value: string | null): string | null {
  return value ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 512) : null;
}

function locationOnly(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    // Never persist URL credentials, queries, fragments or arbitrary paths.
    return bounded(url.origin);
  } catch {
    return null;
  }
}

export function resumeRequestContext(
  headers: Headers,
  actor: { id: string; role: string },
  peerAddress: string | null,
): ResumeAuditContext {
  const tag = (name: string) => {
    const value = headers.get(name);
    return value && /^[a-zA-Z0-9_.:/-]{1,100}$/.test(value) ? value : null;
  };
  return {
    actorId: actor.id,
    actorRole: actor.role,
    peerAddress: bounded(peerAddress),
    userAgent: bounded(headers.get('user-agent')),
    origin: locationOnly(headers.get('origin')),
    referer: locationOnly(headers.get('referer')),
    // Client-supplied forwarding/caller headers are diagnostic claims, not
    // authenticated identity. The socket peer and actor are separate fields.
    forwardedFor: bounded(headers.get('x-forwarded-for')),
    source: tag('x-propanes-resume-source'),
    clientId: tag('x-propanes-client-id'),
    page: tag('x-propanes-resume-page'),
  };
}

export async function auditResume<T extends { sessionId: string }>(
  parentSessionId: string,
  requestedRuntime: string | null | undefined,
  hasAdditionalPrompt: boolean,
  context: ResumeAuditContext | undefined,
  operation: () => Promise<T>,
  emit: (line: string) => void = (line) => console.log(line),
): Promise<T> {
  const requestId = randomUUID();
  // Stack frames identify internal callers (followup sweep, restore queue,
  // thread promotion, transfer) without logging their arguments or prompts.
  const caller = new Error().stack?.split('\n').slice(2, 6).map((line) => line.trim());
  const base = {
    requestId, parentSessionId, requestedRuntime: requestedRuntime ?? null,
    hasAdditionalPrompt, caller,
    transport: context ? 'http' : 'internal',
    request: context ?? null,
  };
  const write = (event: string, extra: Record<string, unknown> = {}) => {
    emit(`[resume-audit] ${JSON.stringify({ timestamp: new Date().toISOString(), event, ...base, ...extra })}`);
  };
  write('requested');
  try {
    const result = await operation();
    write('created', { sessionId: result.sessionId });
    return result;
  } catch (error) {
    // Error messages can contain upstream request bodies or credentials.
    write('failed', { errorType: error instanceof Error ? error.name : 'unknown' });
    throw error;
  }
}

/** These older browser composers could restart on Enter without an explicit
 * restart action. Reject their tagged requests until the page is refreshed. */
export function requiresResumeClientRefresh(source: string | null): boolean {
  return source === 'terminal.resume' || source === 'terminal.interrupt'
    || source === 'conversation.submit-prompt';
}
