import { MessageRenderer } from './MessageRenderer.js';
import type { ParsedMessage } from '../lib/output-parser.js';

const LONG_OUTPUT = Array.from({ length: 80 }, (_, i) => `line ${i + 1}: lorem ipsum dolor sit amet`).join('\n');

const FIXTURES: Record<string, ParsedMessage[]> = {
  bash: [
    {
      id: 'fx-bash-1',
      role: 'tool_use',
      timestamp: 0,
      toolName: 'Bash',
      toolInput: {
        command: 'npm test --workspaces',
        description: 'Run all workspace tests',
      },
      content: '',
    },
  ],
  edit: [
    {
      id: 'fx-edit-1',
      role: 'tool_use',
      timestamp: 0,
      toolName: 'Edit',
      toolInput: {
        file_path: 'packages/admin/src/lib/api.ts',
        old_string: "const BASE = '/api/v1';\n\nfunction getToken(): string | null {",
        new_string: "const BASE = '/api/v1';\nconst TIMEOUT_MS = 30_000;\n\nfunction getToken(): string | null {",
        replace_all: false,
      },
      content: '',
    },
  ],
  'ask-user-question': [
    {
      id: 'fx-aq-1',
      role: 'tool_use',
      timestamp: 0,
      toolName: 'AskUserQuestion',
      toolInput: {
        questions: [
          {
            question: 'Should I proceed with the migration?',
            header: 'Migration',
            multiSelect: false,
            options: [
              { label: 'Yes, run it now', description: 'Apply the schema change immediately' },
              { label: 'No, skip for now', description: 'Defer until a later release' },
            ],
          },
        ],
      },
      content: '',
    },
  ],
  'long-output': [
    {
      id: 'fx-long-use',
      role: 'tool_use',
      timestamp: 0,
      toolName: 'Bash',
      toolInput: { command: 'cat /tmp/very-long-log.txt' },
      content: '',
    },
    {
      id: 'fx-long-result',
      role: 'tool_result',
      timestamp: 0,
      content: LONG_OUTPUT,
    },
  ],
};

export function MessageFixturesIsolate({ params }: { params: URLSearchParams }) {
  const name = params.get('fixture') || 'bash';
  const messages = FIXTURES[name];
  if (!messages) {
    return (
      <div data-testid="fixture-missing" style="padding:24px;font-family:monospace">
        Unknown fixture: {name}. Available: {Object.keys(FIXTURES).join(', ')}
      </div>
    );
  }
  return (
    <div
      data-testid={`fixture-${name}`}
      class="structured-view"
      style="padding:16px;background:var(--pw-bg);min-height:100vh;box-sizing:border-box"
    >
      {messages.map((m, i) => (
        <MessageRenderer key={m.id} message={m} messages={messages} index={i} />
      ))}
    </div>
  );
}
