export const DEFAULT_PROMPT_TEMPLATE = `Feedback: {{feedback.url}}

Title: {{feedback.title}}
{{feedback.description}}
URL: {{feedback.sourceUrl}}

App: {{app.name}}
Project dir: {{app.projectDir}}
App description: {{app.description}}

{{feedback.consoleLogs}}
{{feedback.networkErrors}}
{{feedback.data}}
{{instructions}}`;

export const META_WIGGUM_TEMPLATE = `You are a meta-wiggum orchestrator agent. Your job is to strategically create and manage wiggum runs (automated iteration loops) to improve an application.

## Context
- App: {{app.name}} (ID: {{app.id}})
- Project dir: {{app.projectDir}}
- App description: {{app.description}}

## Original feedback
Title: {{feedback.title}}
{{feedback.description}}
{{feedback.screenshot}}
{{instructions}}

## Your Workflow

### 1. Authenticate
Get a JWT token for API calls:
\`\`\`bash
TOKEN=$(curl -s -X POST 'http://localhost:3001/api/v1/auth/login' \\
  -H 'Content-Type: application/json' \\
  -d '{"username":"admin","password":"admin"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
\`\`\`

### 2. Assess the current state
- Read the codebase to understand the project structure
- Check git history: \`git log --oneline -20\`
- Review existing feedback clusters for this app:
  \`curl -s -H "Authorization: Bearer $TOKEN" 'http://localhost:3001/api/v1/admin/aggregate?appId={{app.id}}'\`
- Take screenshots if a widget session is available

### 3. Plan improvements
Based on your assessment, identify 1-3 highest-impact improvement areas. For each area, write a focused PROMPT_*.md spec file that a wiggum run can execute iteratively.

### 4. Dispatch wiggum runs
For each spec, create a wiggum run:
\`\`\`bash
curl -s -X POST 'http://localhost:3001/api/v1/admin/wiggum' \\
  -H 'Content-Type: application/json' \\
  -H "Authorization: Bearer $TOKEN" \\
  -d '{
    "harnessConfigId": "HARNESS_ID",
    "prompt": "Contents of your PROMPT_*.md spec",
    "deployCommand": "DEPLOY_COMMAND_IF_NEEDED",
    "widgetSessionId": "WIDGET_SESSION_ID_IF_AVAILABLE",
    "maxIterations": 5,
    "appId": "{{app.id}}",
    "parentSessionId": "SESSION_ID_OF_THIS_META_WIGGUM"
  }'
\`\`\`

### 5. Monitor runs
Poll each run until completion:
\`\`\`bash
curl -s -H "Authorization: Bearer $TOKEN" 'http://localhost:3001/api/v1/admin/wiggum/RUN_ID'
\`\`\`
Check: status, currentIteration, iterations array (each has sessionId, screenshotId, exitCode).

### 6. Evaluate results
After runs complete:
- Review git diffs from each run's sessions
- Compare before/after screenshots
- Decide whether another round of specs is needed

### 7. Stop stuck runs
If a run seems stuck or producing bad results:
\`\`\`bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" 'http://localhost:3001/api/v1/admin/wiggum/RUN_ID/stop'
\`\`\`

## Safeguards
- Maximum 5 total wiggum runs per meta-wiggum session
- Maximum 2 concurrent wiggum runs
- Wait for running runs to complete before starting new ones unless parallel work is clearly independent
- If more than 3 runs fail, stop and report the issue
`;

export const FAFO_ASSISTANT_TEMPLATE = `You are a FAFO (Fan-out / Aggregate / Filter / Optimize) setup assistant. You help users create, configure, and manage evolutionary search swarms and wiggum iteration loops.

## Server API
Base URL: http://localhost:3001/api/v1

### Authentication
\`\`\`bash
TOKEN=$(curl -s -X POST 'http://localhost:3001/api/v1/auth/login' \\
  -H 'Content-Type: application/json' \\
  -d '{"username":"admin","password":"admin"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
AUTH="-H \\"Authorization: Bearer $TOKEN\\""
\`\`\`

### Available resources
\`\`\`bash
# List harnesses (needed for wiggum runs)
curl -s $AUTH 'http://localhost:3001/api/v1/admin/harness-configs'

# List applications
curl -s $AUTH 'http://localhost:3001/api/v1/admin/applications'

# List existing swarms
curl -s $AUTH 'http://localhost:3001/api/v1/admin/wiggum/swarms'

# List existing wiggum runs
curl -s $AUTH 'http://localhost:3001/api/v1/admin/wiggum'

# List live widget sessions (for screenshots)
curl -s 'http://localhost:3001/api/v1/agent/sessions'
\`\`\`

### FAFO Swarm CRUD
\`\`\`bash
# Create a single-mode swarm
curl -s -X POST $AUTH 'http://localhost:3001/api/v1/admin/wiggum/swarms' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "name": "SWARM_NAME",
    "mode": "single",
    "artifactType": "screenshot|svg|script|diff",
    "fitnessCommand": "imgdiff|test-pass|CUSTOM_SHELL",
    "fitnessMetric": "pixel-diff|ssim|edge-diff|custom",
    "targetArtifact": "/path/to/target.png",
    "fanOut": 6,
    "harnessConfigId": "HARNESS_ID",
    "appId": "APP_ID"
  }'

# Create a multi-path swarm (isolated worktrees per sub-element)
curl -s -X POST $AUTH 'http://localhost:3001/api/v1/admin/wiggum/swarms' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "name": "SWARM_NAME",
    "mode": "multi-path",
    "artifactType": "screenshot",
    "fitnessMetric": "ssim",
    "targetArtifact": "/path/to/target.png",
    "fanOut": 4,
    "isolation": {"method": "worktree", "basePort": 5200, "baseBranch": "main"},
    "paths": [
      {"name": "sub-element-1", "prompt": "Fix X...", "files": ["src/Component.tsx"], "focusLines": "100-200", "cropRegion": [x,y,w,h]},
      {"name": "sub-element-2", "prompt": "Add Y...", "files": ["src/Component.tsx"], "focusLines": "300-400"}
    ]
  }'

# Get swarm detail (with generations and runs)
curl -s $AUTH 'http://localhost:3001/api/v1/admin/wiggum/swarms/SWARM_ID'

# Trigger next generation (filter survivors, spawn new runs)
curl -s -X POST $AUTH 'http://localhost:3001/api/v1/admin/wiggum/swarms/SWARM_ID/next-generation' \\
  -H 'Content-Type: application/json' \\
  -d '{"keepCount": 3, "lessonsLearned": "What survivors did differently..."}'

# View accumulated knowledge
curl -s $AUTH 'http://localhost:3001/api/v1/admin/wiggum/swarms/SWARM_ID/knowledge'

# Update swarm config
curl -s -X PATCH $AUTH 'http://localhost:3001/api/v1/admin/wiggum/swarms/SWARM_ID' \\
  -H 'Content-Type: application/json' -d '{"fanOut": 8}'

# Add/update/delete paths on a multi-path swarm
curl -s -X POST $AUTH 'http://localhost:3001/api/v1/admin/wiggum/swarms/SWARM_ID/paths' \\
  -H 'Content-Type: application/json' -d '{"name":"new-path","prompt":"..."}'
\`\`\`

### Wiggum Run CRUD
\`\`\`bash
# Create a wiggum run (iteration loop)
curl -s -X POST $AUTH 'http://localhost:3001/api/v1/admin/wiggum' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "harnessConfigId": "HARNESS_ID",
    "prompt": "Iteration prompt...",
    "maxIterations": 10,
    "deployCommand": "supervisorctl restart app",
    "widgetSessionId": "WIDGET_SESSION_FOR_SCREENSHOTS",
    "screenshotDelayMs": 3000,
    "appId": "APP_ID",
    "swarmId": "OPTIONAL_SWARM_ID",
    "generation": 0
  }'

# Pause/resume/stop a run
curl -s -X POST $AUTH 'http://localhost:3001/api/v1/admin/wiggum/RUN_ID/pause'
curl -s -X POST $AUTH 'http://localhost:3001/api/v1/admin/wiggum/RUN_ID/resume'
curl -s -X POST $AUTH 'http://localhost:3001/api/v1/admin/wiggum/RUN_ID/stop'

# Batch launch (from container PROMPT_*.md files)
curl -s -X POST $AUTH 'http://localhost:3001/api/v1/admin/wiggum/batch' \\
  -H 'Content-Type: application/json' \\
  -d '{"harnessConfigId":"ID","promptFiles":["PROMPT_GENERAL.md"],"maxIterations":5}'
\`\`\`

## Your role
1. **Setup**: Ask the user what they want to optimize. Gather: target artifact, fitness criteria, whether it's a single optimization or multi-path (independent sub-elements). Check available harnesses and apps.
2. **Create**: Build the swarm or wiggum run config, explain what will happen, and create it via the API.
3. **Monitor**: Check status of running swarms/runs, report progress, suggest when to trigger next generation.
4. **Optimize**: After a generation completes, analyze fitness scores, write lessons-learned summaries, and trigger the next generation.
5. **Troubleshoot**: If runs fail or scores plateau, diagnose the issue and suggest adjustments (different fitness metric, narrower focus, adjusted prompts).

## Guidelines
- Always start by listing available harnesses and apps so the user can pick
- For multi-path mode, help break the task into independent sub-elements
- Explain each API call before making it
- After creating a swarm, tell the user where to see it in the admin (FAFO / Wiggum page)
- When analyzing fitness scores, lower is better for diff-based metrics
`;

export type PlanFirstChoice = 'plan_first' | 'just_code';
export type TestStrategyChoice = 'user_tests' | 'playwright' | 'isolated_harness';
export type BranchStrategyChoice = 'current_branch' | 'new_branch_pr' | 'new_worktree_pr';
export type RunModeChoice = 'interactive' | 'yolo';

export interface SetupAssistantAnswers {
  planFirst: PlanFirstChoice;
  tests: TestStrategyChoice;
  branch: BranchStrategyChoice;
  runMode: RunModeChoice;
}

const PLAN_FIRST_PREAMBLE = `## Plan first, code second

Before touching any code:
1. Read the relevant files to understand current behavior.
2. Write a concise plan to \`PLAN.md\` at the project root with: problem framing, proposed change list (per file), test strategy, risks, and verification steps.
3. After writing PLAN.md, STOP and use the ExitPlanMode tool (or explicitly ask the user) to wait for approval before implementing.
4. Only after approval, implement the plan.`;

const TESTS_INSTRUCTIONS: Record<TestStrategyChoice, string> = {
  user_tests: 'The user will test the change manually after you finish. Do not add automated tests unless they are trivial; focus on a reproducible manual verification recipe and add it to your final summary.',
  playwright: 'Add Playwright end-to-end coverage for this change. If Playwright is not installed in the relevant package, install it (`@playwright/test`) and add a minimal config. Place tests under `packages/e2e/tests/` (or the package\'s existing e2e directory). Run the tests before declaring the task complete.',
  isolated_harness: 'Run and verify this change inside the dispatched harness/isolated environment. Use the harness Docker compose stack rather than mutating the developer\'s local environment.',
};

const BRANCH_INSTRUCTIONS: Record<BranchStrategyChoice, string> = {
  current_branch: 'Commit the change to the current branch. Do not create a new branch or PR unless the diff is large enough to obviously warrant one.',
  new_branch_pr: 'Create a new branch named `feature/<slug-from-feedback-title>`, commit the change there, push, and open a PR with `gh pr create`. Title the PR after the feedback; body should summarize the change and reference the feedback URL.',
  new_worktree_pr: 'Create a new git worktree under `.worktrees/<slug-from-feedback-title>` on a fresh branch (`feature/<slug>`), do all work in that worktree, then push and open a PR with `gh pr create`. This avoids disturbing the developer\'s current working tree.',
};

const TESTS_LABELS: Record<TestStrategyChoice, string> = {
  user_tests: 'User will test',
  playwright: 'Playwright e2e',
  isolated_harness: 'Isolated harness',
};

const BRANCH_LABELS: Record<BranchStrategyChoice, string> = {
  current_branch: 'Current branch',
  new_branch_pr: 'New branch + PR',
  new_worktree_pr: 'New worktree + PR',
};

export function buildSetupAssistantInstructions(
  answers: SetupAssistantAnswers,
  userInstructions?: string,
): string {
  const sections: string[] = [];
  sections.push('## Setup Assistant directives\n\nThe following choices were made up-front for this dispatch. Honor them.');
  sections.push(`- **Plan strategy:** ${answers.planFirst === 'plan_first' ? 'Write PLAN.md and wait for approval before coding' : 'Skip the plan, implement directly'}`);
  sections.push(`- **Test strategy:** ${TESTS_LABELS[answers.tests]}`);
  sections.push(`- **Branch strategy:** ${BRANCH_LABELS[answers.branch]}`);
  sections.push(`- **Run mode:** ${answers.runMode === 'yolo' ? 'YOLO (skips permission prompts)' : 'Interactive (you may pause for tool approval)'}`);

  if (answers.planFirst === 'plan_first') sections.push(PLAN_FIRST_PREAMBLE);
  sections.push(`### Testing\n${TESTS_INSTRUCTIONS[answers.tests]}`);
  sections.push(`### Branching\n${BRANCH_INSTRUCTIONS[answers.branch]}`);

  if (userInstructions && userInstructions.trim()) {
    sections.push(`## Additional Instructions\n${userInstructions.trim()}`);
  }
  return sections.join('\n\n');
}

export const STRUCTURED_MODE_TEMPLATE = `Use structured mode for this task.

## Response format
1. Problem framing
2. Proposed solution
3. Files or systems affected
4. Risks and open questions
5. Verification plan

Be concrete, explicit, and implementation-oriented.`;

export const POWWOW_TEMPLATE = `You are orchestrating a powwow across multiple coding agents (Claude, Codex, or others available in ProPanes).

## Goal
- Dispatch several agents in parallel
- Compare their competing solutions
- Run additional rounds if there is disagreement
- Converge on the strongest shared plan

## Style
${STRUCTURED_MODE_TEMPLATE}

## Requirements
- Make the disagreement explicit before declaring consensus
- Name the strongest idea from each agent
- End with a single recommended path and verification checklist`;

export const TEMPLATE_PRESETS = [
  { label: 'Default', value: null },
  { label: 'Meta-Wiggum (Orchestrator)', value: META_WIGGUM_TEMPLATE },
  { label: 'FAFO Setup Assistant', value: FAFO_ASSISTANT_TEMPLATE },
  { label: 'Structured Mode', value: STRUCTURED_MODE_TEMPLATE },
  { label: 'Powwow Moderator', value: POWWOW_TEMPLATE },
] as const;

/**
 * Launch a FAFO assistant session with optional pre-populated context.
 * Returns the session ID, or throws on error.
 */
export async function launchFAFOAssistant(opts: {
  appId?: string | null;
  context?: string;
}): Promise<string> {
  // Lazy imports to avoid circular deps
  const { api } = await import('./api.js');
  const { ensureAgentsLoaded, openSession, loadAllSessions } = await import('./sessions.js');

  const appId = opts.appId || '';
  const fb = await api.createFeedback({
    title: 'FAFO Setup Assistant',
    description: opts.context || 'Interactive assistant for FAFO swarms and wiggum runs.',
    type: 'manual',
    appId,
    tags: ['fafo', 'assistant'],
  });

  const allAgents = appId
    ? await api.getAgents(appId)
    : await ensureAgentsLoaded();
  // Skip webhook endpoints with no URL — they'd fail dispatch immediately.
  const agents = (allAgents as any[]).filter((a: any) => a.mode !== 'webhook' || !!a.url);
  const agent = agents.find((a: any) => a.isDefault && a.appId === appId)
    || agents.find((a: any) => a.isDefault && !a.appId)
    || agents[0];
  if (!agent) throw new Error('No agent endpoints configured');

  const prompt = FAFO_ASSISTANT_TEMPLATE + (opts.context ? `\n\n## Current Context\n\n${opts.context}` : '');
  const result = await api.dispatch({
    feedbackId: fb.id,
    agentEndpointId: agent.id,
    instructions: prompt,
  });
  if (!result.sessionId) throw new Error('Dispatch failed: no session ID returned');

  openSession(result.sessionId);
  loadAllSessions();
  return result.sessionId;
}

export const TOOL_PRESETS = [
  { label: 'Read from /tmp', value: 'Read(/tmp/*)' },
  { label: 'Write to /tmp', value: 'Write(/tmp/*)' },
  { label: 'All file operations', value: 'Edit, Read, Write' },
  { label: 'Run tests (npm)', value: 'Bash(npm test)' },
  { label: 'Run npm scripts', value: 'Bash(npm run *)' },
  { label: 'Git operations', value: 'Bash(git *)' },
  { label: 'Git commit', value: 'Bash(git commit:*)' },
  { label: 'Git add', value: 'Bash(git add:*)' },
] as const;

export const MODE_INFO: Record<string, { icon: string; label: string; color: string }> = {
  interactive: { icon: '\u{1F4BB}', label: 'Interactive', color: 'var(--pw-primary)' },
  headless: { icon: '\u{2699}\uFE0F', label: 'Headless', color: '#eab308' },
  webhook: { icon: '\u{1F517}', label: 'Webhook', color: '#f59e0b' },
};

export const RUNTIME_INFO: Record<string, { icon: string; label: string; color: string }> = {
  claude: { icon: '\u{1F9E0}', label: 'Claude', color: '#3b82f6' },
  codex: { icon: '\u{1F4A1}', label: 'Codex', color: '#06b6d4' },
};

export const PROFILE_DESCRIPTIONS: Record<string, { label: string; desc: string; icon: string }> = {
  'interactive-require': { label: 'Interactive', desc: 'TUI; you approve each tool use', icon: '\u{1F441}' },
  'interactive-yolo': { label: 'YOLO', desc: 'TUI; skips permission checks', icon: '\u26A1' },
  'headless-yolo': { label: 'Headless', desc: 'One-shot stream-json; skips permissions', icon: '\u{1F916}' },
  'headless-stream-yolo': { label: 'Stream', desc: 'Bidirectional stream-json; skips permissions', icon: '\u{1F50C}' },
  'headless-stream-require': { label: 'Stream (supervised)', desc: 'Bidirectional stream-json; approval prompts delivered via UI', icon: '\u{1F50B}' },
};
