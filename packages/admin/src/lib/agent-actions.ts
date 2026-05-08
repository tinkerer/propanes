import { signal } from '@preact/signals';
import { api } from './api.js';
import { resumeSession, openSession, loadAllSessions } from './sessions.js';

/** State for the branch picker modal */
export const branchPickerOpen = signal<{
  sessionId: string;
  runtime: 'claude' | 'codex';
  permissionProfile: string;
} | null>(null);

/** State for the distill-to-agent modal */
export const distillPickerOpen = signal<{
  sessionIds: string[];
  sessionTitle: string;
} | null>(null);

/**
 * Branch (fork) a session: resume it with a different prompt direction.
 * Uses the existing resume flow but passes an additionalPrompt that redirects
 * the conversation. The new session shares the parent's Claude session context
 * but goes in the user's specified direction.
 */
export async function branchSession(
  sessionId: string,
  prompt: string,
  opts?: { runtime?: 'claude' | 'codex'; permissionProfile?: string },
): Promise<string | null> {
  return resumeSession(sessionId, {
    additionalPrompt: prompt,
    runtime: opts?.runtime,
    permissionProfile: opts?.permissionProfile,
  });
}

/**
 * Distill one or more sessions into a new expert agent endpoint.
 * Creates a new agent with a prompt template that encodes the session context.
 */
export async function distillToAgent(opts: {
  name: string;
  description: string;
  sessionIds: string[];
  appId?: string;
  extraContext?: string;
}): Promise<string> {
  const sessionSummaries: string[] = [];

  for (const sid of opts.sessionIds) {
    try {
      const session = await api.getAgentSession(sid);
      const title = session.title || sid.slice(-8);
      sessionSummaries.push(`- Session "${title}" (${sid}): ${session.prompt?.slice(0, 300) || 'no prompt recorded'}${session.prompt && session.prompt.length > 300 ? '...' : ''}`);
    } catch {
      sessionSummaries.push(`- Session ${sid}: (could not load details)`);
    }
  }

  const promptTemplate = `You are a specialized expert agent: ${opts.name}.

## Expertise
${opts.description}

## Source Knowledge
This agent was distilled from the following sessions:
${sessionSummaries.join('\n')}

${opts.extraContext ? `## Additional Context\n${opts.extraContext}\n` : ''}## Instructions
Apply your specialized expertise to the task at hand. You have deep knowledge in your domain area from the sessions above. When working on tasks in this area, leverage the patterns, APIs, and approaches you've learned.

## Task
{{feedback.title}}
{{feedback.description}}
URL: {{feedback.sourceUrl}}

App: {{app.name}}
Project dir: {{app.projectDir}}
{{feedback.data}}
{{instructions}}`;

  const result: any = await api.createAgent({
    name: opts.name,
    description: opts.description,
    appId: opts.appId,
    mode: 'interactive',
    runtime: 'claude',
    permissionProfile: 'interactive-yolo',
    promptTemplate,
    sourceSessionIds: opts.sessionIds.join(','),
  });

  loadAllSessions();
  return result.id;
}
