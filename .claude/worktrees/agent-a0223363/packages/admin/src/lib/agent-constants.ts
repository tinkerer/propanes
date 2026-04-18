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
