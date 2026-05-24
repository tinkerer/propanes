import { api } from './api.js';
import { applications } from './state.js';

type Agent = {
  id: string;
  name: string;
  mode?: string;
  url?: string | null;
  isDefault?: boolean;
  appId?: string | null;
  permissionProfile?: string | null;
};

type SpecUpdateResult = Awaited<ReturnType<typeof api.updateSpec>>;

export interface LaunchSpecUpdateOptions {
  additionalInstructions?: string;
  preferYolo?: boolean;
}

function usableAgent(agent: Agent): boolean {
  return agent.mode !== 'webhook' || !!agent.url;
}

function isYoloProfile(profile: string | null | undefined): boolean {
  return typeof profile === 'string' && profile.endsWith('-yolo');
}

function pickAgent(agents: Agent[], appId: string, preferYolo: boolean): Agent | undefined {
  const usable = agents.filter(usableAgent);
  if (preferYolo) {
    for (const profile of ['interactive-yolo', 'headless-yolo', 'headless-stream-yolo']) {
      const match = (a: Agent) => a.permissionProfile === profile;
      const hit = usable.find((a) => match(a) && a.isDefault && a.appId === appId)
        || usable.find((a) => match(a) && a.appId === appId)
        || usable.find((a) => match(a) && a.isDefault && !a.appId)
        || usable.find(match);
      if (hit) return hit;
    }
    const anyYolo = usable.find((a) => isYoloProfile(a.permissionProfile));
    if (anyYolo) return anyYolo;
  }
  return usable.find((agent) => agent.isDefault && agent.appId === appId)
    || usable.find((agent) => agent.appId === appId)
    || usable.find((agent) => agent.isDefault && !agent.appId)
    || usable[0];
}

function buildFallbackInstructions(app: any, wikiDir: string, additionalInstructions?: string): string {
  const base = [
    `Create or update the per-application spec wiki for ${app?.name || 'this app'} (${app?.id}).`,
    '',
    `Write the wiki under: ${wikiDir}`,
    '',
    'Required files:',
    '- index.md',
    '- spec-backbone.md',
    '- tickets.md',
    '- operator-inputs.md',
    '- agent-jsonl-inputs.md',
    '',
    'Use tickets, CoS thread inputs, and agent JSONL histories as source material. Turn those beads into a durable spec-driven-development wiki, not just a dump. Deduplicate repeated requests, preserve important IDs and paths, and summarize long histories.',
  ];
  const extra = (additionalInstructions || '').trim();
  if (extra) {
    base.push('', '## Additional direction from operator', '', extra);
  }
  return base.join('\n');
}

export async function launchSpecUpdate(
  appId: string,
  opts: LaunchSpecUpdateOptions = {},
): Promise<SpecUpdateResult> {
  const additionalInstructions = opts.additionalInstructions?.trim() || undefined;
  const preferYolo = opts.preferYolo !== false; // default to YOLO

  try {
    return await api.updateSpec({ appId, additionalInstructions, preferYolo });
  } catch (primaryError) {
    const app = applications.value.find((candidate) => candidate.id === appId) || { id: appId, name: 'Application', projectDir: '' };
    const wikiDir = `${app.projectDir || '<app project dir>'}/docs/spec-wiki/${appId}`;
    const agents = await api.getAgents(appId);
    const agent = pickAgent(agents as Agent[], appId, preferYolo);
    if (!agent) throw primaryError;

    const feedback = await api.createFeedback({
      appId,
      type: 'programmatic',
      title: `Update Spec Wiki - ${app.name || appId}`,
      description: `Generate the per-application spec wiki at ${wikiDir} from tickets, CoS inputs, and JSONL histories.`,
      tags: ['spec-wiki'],
    });

    const dispatched = await api.dispatch({
      feedbackId: feedback.id,
      agentEndpointId: agent.id,
      instructions: buildFallbackInstructions(app, wikiDir, additionalInstructions),
    });

    return {
      ok: true,
      mode: 'session',
      sessionId: dispatched.sessionId,
      feedbackId: feedback.id,
      agentEndpointId: agent.id,
      agentName: agent.name,
      wikiDir,
      indexPath: `${wikiDir}/index.md`,
      updatedAt: new Date().toISOString(),
    };
  }
}
