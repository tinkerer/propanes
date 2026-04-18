export function gettingStartedMarkdown(baseUrl: string): string {
  return `# ProPanes — Agent Getting Started

Quickest way to start is to paste this into a claude code session running in your project directory:

\`\`\`
see ${baseUrl}/GETTING_STARTED.md Follow these steps to register this project, create an agent endpoint, and embed the feedback widget.
\`\`\`

---

## 1. Register your application

\`\`\`bash
curl -X POST ${baseUrl}/api/v1/admin/applications \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "My App",
    "projectDir": "/absolute/path/to/project",
    "description": "Brief description of the app so dispatched agents have context",
    "hooks": [],
    "serverUrl": "http://localhost:5173"
  }'
\`\`\`

Response:

\`\`\`json
{ "id": "<APP_ID>", "apiKey": "pw_<KEY>" }
\`\`\`

Save both values. \`apiKey\` is how the widget identifies itself. \`id\` links
agent endpoints to this application.

---

## 2. Create an agent endpoint

Pick a dispatch mode:

| Mode | What happens |
|------|-------------|
| \`webhook\` | POST JSON payload to a URL (existing behavior) |
| \`headless\` | Run \`claude -p "<prompt>" --output-format text\` in projectDir |
| \`interactive\` | Create a tmux session and send \`claude -p\` into it |

### Headless example (recommended for automation)

\`\`\`bash
curl -X POST ${baseUrl}/api/v1/admin/agents \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Claude Code (headless)",
    "mode": "headless",
    "appId": "<APP_ID>",
    "isDefault": true,
    "promptTemplate": "You are working on {{app.name}}.\\n\\nApp description: {{app.description}}\\n\\nThe user reported feedback from their browser session at {{session.url}} (viewport {{session.viewport}}).\\n\\nTitle: {{feedback.title}}\\nDescription: {{feedback.description}}\\n\\nConsole logs:\\n{{feedback.consoleLogs}}\\n\\nNetwork errors:\\n{{feedback.networkErrors}}\\n\\nCustom data:\\n{{feedback.data}}\\n\\nTags: {{feedback.tags}}\\n\\nAdditional instructions:\\n{{instructions}}\\n\\nThe propanes server is at ${baseUrl}. The browser session may still be live — you can interact with it via the agent API (see below).\\n\\nAvailable hooks the app exposes: {{app.hooks}}"
  }'
\`\`\`

### Interactive example (opens tmux for you to watch)

\`\`\`bash
curl -X POST ${baseUrl}/api/v1/admin/agents \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Claude Code (interactive)",
    "mode": "interactive",
    "appId": "<APP_ID>",
    "promptTemplate": "Fix the following issue in {{app.name}} ({{app.projectDir}}):\\n\\n{{feedback.title}}\\n{{feedback.description}}\\n\\n{{instructions}}"
  }'
\`\`\`

### Webhook example (classic)

\`\`\`bash
curl -X POST ${baseUrl}/api/v1/admin/agents \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "My webhook",
    "mode": "webhook",
    "url": "https://my-agent.example.com/handle",
    "authHeader": "Bearer sk-...",
    "isDefault": true
  }'
\`\`\`

### Template variables

Use these in \`promptTemplate\` for headless/interactive modes:

| Variable | Value |
|----------|-------|
| \`{{feedback.title}}\` | Feedback title |
| \`{{feedback.description}}\` | Feedback description |
| \`{{feedback.consoleLogs}}\` | Console logs (formatted text) |
| \`{{feedback.networkErrors}}\` | Network errors (formatted text) |
| \`{{feedback.data}}\` | Custom data JSON |
| \`{{feedback.tags}}\` | Comma-separated tags |
| \`{{app.name}}\` | Application name |
| \`{{app.projectDir}}\` | Project directory (also used as cwd) |
| \`{{app.hooks}}\` | Registered hooks |
| \`{{app.description}}\` | Application description |
| \`{{instructions}}\` | Ad-hoc instructions from the dispatcher |
| \`{{session.url}}\` | Page URL from the live browser session |
| \`{{session.viewport}}\` | Viewport dimensions |

---

## 3. Embed the widget

Add this script tag to your HTML. The \`data-app-key\` attribute links the
browser session to your registered application.

\`\`\`html
<script
  src="${baseUrl}/widget/propanes.js"
  data-endpoint="${baseUrl}/api/v1/feedback"
  data-app-key="pw_<KEY>"
></script>
\`\`\`

That's it. The widget will:
- Show a feedback button in the bottom-right corner
- Capture console logs, network errors, performance, and environment info
- Open a WebSocket connection to this server (identified by the API key)
- Submit feedback tagged with your application ID

---

## 4. Dispatch feedback to an agent

Once a user submits feedback, dispatch it from the admin UI at
\`${baseUrl}/admin/#/\` or via the API:

\`\`\`bash
curl -X POST ${baseUrl}/api/v1/admin/dispatch \\
  -H "Content-Type: application/json" \\
  -d '{
    "feedbackId": "<FEEDBACK_ID>",
    "agentEndpointId": "<AGENT_ID>",
    "instructions": "Optional extra instructions"
  }'
\`\`\`

For **headless** mode this runs \`claude -p\` with the filled template in the
application's \`projectDir\`. For **interactive** mode it creates a tmux session
you can attach to.

---

## 5. Agent API — interact with the live browser

While the browser tab is still open, you can control it from your agent:

\`\`\`bash
# List active sessions
curl ${baseUrl}/api/v1/agent/sessions

# Take a screenshot (returns base64 data URL)
curl -X POST ${baseUrl}/api/v1/agent/sessions/<SESSION_ID>/screenshot

# Execute JS in the page
curl -X POST ${baseUrl}/api/v1/agent/sessions/<SESSION_ID>/execute \\
  -H "Content-Type: application/json" \\
  -d '{"expression": "return document.title"}'

# Get console logs
curl ${baseUrl}/api/v1/agent/sessions/<SESSION_ID>/console

# Get network errors
curl ${baseUrl}/api/v1/agent/sessions/<SESSION_ID>/network

# Get environment info
curl ${baseUrl}/api/v1/agent/sessions/<SESSION_ID>/environment

# Get DOM snapshot (with accessibility tree)
curl "${baseUrl}/api/v1/agent/sessions/<SESSION_ID>/dom?selector=body"

# Get performance timing
curl ${baseUrl}/api/v1/agent/sessions/<SESSION_ID>/performance

# Navigate
curl -X POST ${baseUrl}/api/v1/agent/sessions/<SESSION_ID>/navigate \\
  -H "Content-Type: application/json" \\
  -d '{"url": "http://localhost:5173/some-page"}'

# Click an element
curl -X POST ${baseUrl}/api/v1/agent/sessions/<SESSION_ID>/click \\
  -H "Content-Type: application/json" \\
  -d '{"selector": "#submit-btn"}'

# Type into an element
curl -X POST ${baseUrl}/api/v1/agent/sessions/<SESSION_ID>/type \\
  -H "Content-Type: application/json" \\
  -d '{"selector": "input[name=email]", "text": "test@example.com"}'
\`\`\`

---

## Quick-start script

Copy-paste this to register and wire up everything in one shot.
Replace the values in angle brackets.

\`\`\`bash
PW_SERVER="${baseUrl}"
PROJECT_DIR="<ABSOLUTE_PATH_TO_PROJECT>"
APP_NAME="<YOUR_APP_NAME>"
APP_DESC="<BRIEF_DESCRIPTION>"
DEV_URL="<e.g. http://localhost:5173>"

# Register application
RESULT=$(curl -s -X POST $PW_SERVER/api/v1/admin/applications \\
  -H "Content-Type: application/json" \\
  -d "{
    \\"name\\": \\"$APP_NAME\\",
    \\"projectDir\\": \\"$PROJECT_DIR\\",
    \\"description\\": \\"$APP_DESC\\",
    \\"serverUrl\\": \\"$DEV_URL\\",
    \\"hooks\\": []
  }")

APP_ID=$(echo $RESULT | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
API_KEY=$(echo $RESULT | grep -o '"apiKey":"[^"]*"' | cut -d'"' -f4)

echo "App ID:  $APP_ID"
echo "API Key: $API_KEY"

# Create headless agent endpoint
AGENT=$(curl -s -X POST $PW_SERVER/api/v1/admin/agents \\
  -H "Content-Type: application/json" \\
  -d "{
    \\"name\\": \\"$APP_NAME agent\\",
    \\"mode\\": \\"headless\\",
    \\"appId\\": \\"$APP_ID\\",
    \\"isDefault\\": true,
    \\"promptTemplate\\": \\"Fix this issue in {{app.name}}:\\\\n\\\\nTitle: {{feedback.title}}\\\\nDescription: {{feedback.description}}\\\\n\\\\nConsole: {{feedback.consoleLogs}}\\\\nNetwork errors: {{feedback.networkErrors}}\\\\n\\\\n{{instructions}}\\"
  }")

AGENT_ID=$(echo $AGENT | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
echo "Agent ID: $AGENT_ID"

echo ""
echo "Add this to your HTML:"
echo "<script src=\\"$PW_SERVER/widget/propanes.js\\" data-endpoint=\\"$PW_SERVER/api/v1/feedback\\" data-app-key=\\"$API_KEY\\"></script>"
\`\`\`

---

## Admin UI

Open \`${baseUrl}/admin/\` to manage applications, agent endpoints, and
review/dispatch feedback. Default login: \`admin\` / \`admin\`.

## Full API reference

| Method | Path | Description |
|--------|------|-------------|
| GET | \`/api/v1/health\` | Health check |
| POST | \`/api/v1/feedback\` | Submit feedback (multipart or JSON) |
| POST | \`/api/v1/feedback/programmatic\` | Submit feedback (JSON only) |
| POST | \`/api/v1/auth/login\` | Get admin JWT token |
| GET | \`/api/v1/admin/feedback\` | List feedback (paginated, filterable) |
| GET | \`/api/v1/admin/feedback/:id\` | Get feedback detail |
| PATCH | \`/api/v1/admin/feedback/:id\` | Update feedback |
| DELETE | \`/api/v1/admin/feedback/:id\` | Delete feedback |
| POST | \`/api/v1/admin/feedback/batch\` | Batch operations |
| GET | \`/api/v1/admin/agents\` | List agent endpoints |
| POST | \`/api/v1/admin/agents\` | Create agent endpoint |
| PATCH | \`/api/v1/admin/agents/:id\` | Update agent endpoint |
| DELETE | \`/api/v1/admin/agents/:id\` | Delete agent endpoint |
| POST | \`/api/v1/admin/dispatch\` | Dispatch feedback to agent |
| GET | \`/api/v1/admin/applications\` | List applications |
| GET | \`/api/v1/admin/applications/:id\` | Get application |
| POST | \`/api/v1/admin/applications\` | Create application |
| PATCH | \`/api/v1/admin/applications/:id\` | Update application |
| DELETE | \`/api/v1/admin/applications/:id\` | Delete application |
| POST | \`/api/v1/admin/applications/:id/regenerate-key\` | Regenerate API key |
| GET | \`/api/v1/agent/sessions\` | List live browser sessions |
| GET | \`/api/v1/agent/sessions/:id\` | Get session info |
| POST | \`/api/v1/agent/sessions/:id/screenshot\` | Capture screenshot |
| POST | \`/api/v1/agent/sessions/:id/execute\` | Execute JS in page |
| GET | \`/api/v1/agent/sessions/:id/console\` | Get console logs |
| GET | \`/api/v1/agent/sessions/:id/network\` | Get network errors |
| GET | \`/api/v1/agent/sessions/:id/environment\` | Get environment info |
| GET | \`/api/v1/agent/sessions/:id/dom\` | Get DOM + a11y tree |
| GET | \`/api/v1/agent/sessions/:id/performance\` | Get performance timing |
| POST | \`/api/v1/agent/sessions/:id/navigate\` | Navigate page |
| POST | \`/api/v1/agent/sessions/:id/click\` | Click element |
| POST | \`/api/v1/agent/sessions/:id/type\` | Type into element |
| GET | \`/GETTING_STARTED.md\` | This document |

---

## Reporting bugs with propanes

If you encounter issues with the propanes API itself (timeouts, unexpected
responses, missing data), you can report them back through the programmatic
feedback endpoint:

\`\`\`bash
curl -X POST ${baseUrl}/api/v1/feedback/programmatic \\
  -H "Content-Type: application/json" \\
  -d '{
    "type": "bug",
    "title": "Brief description of the issue",
    "description": "What happened, what you expected, and any relevant context",
    "tags": ["propanes-bug"],
    "data": {
      "endpoint": "/api/v1/...",
      "statusCode": 500,
      "errorMessage": "..."
    }
  }'
\`\`\`

This helps the propanes maintainers track and fix issues with the platform
itself. Use the \`propanes-bug\` tag so these reports are easy to filter in
the admin UI.
`;
}
