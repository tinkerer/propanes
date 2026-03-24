export const DEFAULT_PROMPT_TEMPLATE = `do feedback item {{feedback.id}}

Title: {{feedback.title}}
{{feedback.description}}
URL: {{feedback.sourceUrl}}

App: {{app.name}}
Project dir: {{app.projectDir}}
App description: {{app.description}}

{{feedback.consoleLogs}}
{{feedback.networkErrors}}
{{feedback.data}}
{{instructions}}

consider screenshot`;

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

export const TEMPLATE_PRESETS = [
  { label: 'Default', value: null },
  { label: 'Meta-Wiggum (Orchestrator)', value: META_WIGGUM_TEMPLATE },
] as const;

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
  headless: { icon: '\u{2699}\uFE0F', label: 'Headless', color: '#22c55e' },
  webhook: { icon: '\u{1F517}', label: 'Webhook', color: '#f59e0b' },
};

export const PROFILE_DESCRIPTIONS: Record<string, { label: string; desc: string; icon: string }> = {
  interactive: { label: 'Supervised', desc: 'You approve each tool use in real-time', icon: '\u{1F441}' },
  auto: { label: 'Autonomous', desc: 'Pre-approved tools run automatically', icon: '\u{1F916}' },
  yolo: { label: 'Full Auto', desc: 'No permission checks (sandboxed only)', icon: '\u26A1' },
};
