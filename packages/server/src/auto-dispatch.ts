import { eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { feedbackEvents } from './events.js';
import { dispatchFeedbackToAgent } from './dispatch.js';

export function registerAutoDispatch() {
  feedbackEvents.on('new', (event: { id: string; appId: string | null; autoDispatch?: boolean; launcherId?: string; agentEndpointId?: string }) => {
    handleAutoDispatch(event).catch((err) =>
      console.error(`[auto-dispatch] Error for feedback ${event.id}:`, err)
    );
  });
}

async function handleAutoDispatch(event: { id: string; appId: string | null; autoDispatch?: boolean; launcherId?: string; agentEndpointId?: string }) {
  if (!event.appId || !event.autoDispatch) return;

  const app = db.select().from(schema.applications).where(eq(schema.applications.id, event.appId)).get();
  if (!app || !app.autoDispatch) return;

  let agentId = event.agentEndpointId;
  if (agentId) {
    // Verify the specified agent exists
    const specified = db.select().from(schema.agentEndpoints).where(eq(schema.agentEndpoints.id, agentId)).get();
    if (!specified) agentId = undefined;
  }

  if (!agentId) {
    const agents = db.select().from(schema.agentEndpoints).all();
    const defaultAgent =
      agents.find((a) => a.isDefault && a.appId === event.appId) ||
      agents.find((a) => a.isDefault && !a.appId) ||
      agents[0];
    if (!defaultAgent) return;
    agentId = defaultAgent.id;
  }

  const result = await dispatchFeedbackToAgent({ feedbackId: event.id, agentEndpointId: agentId, launcherId: event.launcherId });
  const agent = db.select().from(schema.agentEndpoints).where(eq(schema.agentEndpoints.id, agentId)).get();
  console.log(`[auto-dispatch] ${event.id} -> "${agent?.name || agentId}": ${result.sessionId || 'webhook'}`);
}
