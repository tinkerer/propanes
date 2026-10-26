import { sqlite } from './db/index.js';

export class ResumeConflictError extends Error {
  constructor() {
    super('This conversation is already running in another session. Open the running session instead.');
    this.name = 'ResumeConflictError';
  }
}

/** Check the resume lineage, including siblings resumed from an old ancestor.
 * Independent native forks have a new conversation ID and no shared CoS thread.
 * Also catch imports that share a thread or runtime conversation ID.
 * This check and the resume's pending-row insert run synchronously on the main
 * server before yielding, so another request observes that pending reservation.
 */
export function assertResumeAvailable(parent: {
  id: string;
  permissionProfile: string;
  cosThreadId: string | null;
  claudeSessionId: string | null;
  runtime: string;
}): void {
  if (parent.permissionProfile === 'plain') return;
  const active = sqlite.prepare(`
    WITH RECURSIVE resume_edges(id, parent_session_id) AS (
      SELECT child.id, parent.id FROM agent_sessions child
      JOIN agent_sessions parent ON child.parent_session_id = parent.id
      WHERE NOT (
        child.runtime = parent.runtime
        AND child.claude_session_id IS NOT NULL AND parent.claude_session_id IS NOT NULL
        AND child.claude_session_id != parent.claude_session_id
        AND child.cos_thread_id IS NULL
      )
    ), ancestors(id) AS (
      SELECT id FROM agent_sessions WHERE id = @id
      UNION
      SELECT edge.parent_session_id FROM resume_edges edge JOIN ancestors a ON edge.id = a.id
    ), family(id) AS (
      SELECT id FROM ancestors
      UNION
      SELECT edge.id FROM resume_edges edge JOIN family f ON edge.parent_session_id = f.id
    )
    SELECT s.id FROM agent_sessions s
    WHERE s.status IN ('running', 'pending') AND (
      s.id IN (SELECT id FROM family)
      OR (@thread IS NOT NULL AND s.cos_thread_id = @thread)
      OR (@conversation IS NOT NULL AND s.claude_session_id = @conversation AND s.runtime = @runtime)
    ) LIMIT 1
  `).get({
    id: parent.id, thread: parent.cosThreadId,
    conversation: parent.claudeSessionId, runtime: parent.runtime,
  });
  if (active) throw new ResumeConflictError();
}
