import { eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { feedbackEvents } from './events.js';
import { dispatchFeedbackToAgent } from './dispatch.js';

export function registerAutoDispatch() {
  feedbackEvents.on('new', (event: { id: string; appId: string | null; autoDispatch?: boolean; launcherId?: string }) => {
    handleAutoDispatch(event).catch((err) =>
      console.error(`[auto-dispatch] Error for feedback ${event.id}:`, err)
    );
  });
}

async function handleAutoDispatch(event: { id: string; appId: string | null; autoDispatch?: boolean; launcherId?: string }) {
  if (!event.appId || !event.autoDispatch) return;

  const app = db.select().from(schema.applications).where(eq(schema.applications.id, event.appId)).get();
  if (!app || !app.autoDispatch) return;

  const agents = db.select().from(schema.agentEndpoints).all();
  const defaultAgent =
    agents.find((a) => a.isDefault && a.appId === event.appId) ||
    agents.find((a) => a.isDefault && !a.appId) ||
    agents[0];
  if (!defaultAgent) return;

  const result = await dispatchFeedbackToAgent({ feedbackId: event.id, agentEndpointId: defaultAgent.id, launcherId: event.launcherId });
  console.log(`[auto-dispatch] ${event.id} -> "${defaultAgent.name}": ${result.sessionId || 'webhook'}`);
}
