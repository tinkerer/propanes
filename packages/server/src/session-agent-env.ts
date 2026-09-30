import { eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { mintUserToken } from './auth.js';

// Env handed to a locally spawned agent session so it can call the admin API
// (the dispatch prompt promises PROPANES_TOKEN / PROPANES_API_URL). Per-user
// pods bake both into the pod env; there the process env already has them and
// tmux-pty forwards it, so we leave them alone.
//
// Sessions without an owner (widget feedback on an unowned app, companions)
// are only visible to admins, so they get the env-admin identity — the same
// one the operator uses to log in to this server.
export async function sessionAgentEnv(sessionId: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  if (!process.env.PROPANES_API_URL) {
    env.PROPANES_API_URL = `http://localhost:${process.env.PORT || '3001'}`;
  }
  if (process.env.PROPANES_TOKEN) return env;

  const row = db
    .select({ ownerUserId: schema.agentSessions.ownerUserId })
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, sessionId))
    .get();
  const ownerId = row?.ownerUserId || 'env-admin';

  if (ownerId === 'env-admin') {
    env.PROPANES_TOKEN = await mintUserToken(
      { id: 'env-admin', username: process.env.ADMIN_USER || 'admin', role: 'admin', orgId: null },
      30,
    );
    return env;
  }

  const user = db.select().from(schema.users).where(eq(schema.users.id, ownerId)).get();
  if (user && user.status === 'active') {
    env.PROPANES_TOKEN = await mintUserToken(user, 30);
  }
  return env;
}
