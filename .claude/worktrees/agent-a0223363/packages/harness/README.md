# Headless Browser Harness

Docker-based harness for AI agents to interact with web UIs via Playwright MCP + prompt-widget. Provides a sandboxed headless Chromium with the widget auto-injected into every page.

## Architecture

```
┌─── Docker Compose (pw-net) ───────────────────────────────────┐
│                                                                │
│  pw-server (:3001)     pw-browser (:8931)   pw-app (:8080)   │
│  ├─ prompt-widget API  ├─ Playwright MCP    ├─ your app      │
│  ├─ admin UI           ├─ headless Chromium │  (any image)    │
│  ├─ widget JS          └─ widget auto-      └─ opt-in via    │
│  └─ SQLite DB              injected             --profile app │
│                                                                │
└────────────────────────────────────────────────────────────────┘
         ↑                        ↑
    Agent HTTP/WS            Agent MCP
    (screenshots,            (navigate, click,
     virtual mouse,           snapshot, type)
     DOM queries)
```

## Quick Start

```bash
cd packages/harness

# Copy and edit env (optional — defaults work for dogfooding)
cp .env.example .env

# Build and start (server + browser only)
docker compose up -d

# Or start with the application container
docker compose --profile app up -d

# Verify
docker compose ps
curl http://localhost:3001/api/v1/health
```

## Connecting an Agent

The agent connects to two endpoints:

### 1. Playwright MCP (browser control)

Add to your MCP client config (e.g., `.mcp.json`):

```json
{
  "mcpServers": {
    "playwright": {
      "url": "http://localhost:8931/mcp"
    }
  }
}
```

Available tools: `browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, `browser_screenshot`, `browser_hover`, `browser_select_option`, `browser_press_key`

### 2. Prompt-Widget API (screenshots, virtual mouse/keyboard, DOM)

```bash
# Navigate via Playwright MCP first, then use widget API:

# List active widget sessions
curl http://localhost:3001/api/v1/agent/sessions

# Take a screenshot
curl -X POST http://localhost:3001/api/v1/agent/sessions/SESSION_ID/screenshot

# Virtual mouse click
curl -X POST http://localhost:3001/api/v1/agent/sessions/SESSION_ID/mouse/click \
  -H 'Content-Type: application/json' -d '{"x":500,"y":300}'

# Type text
curl -X POST http://localhost:3001/api/v1/agent/sessions/SESSION_ID/keyboard/type \
  -H 'Content-Type: application/json' -d '{"text":"hello","selector":"input"}'
```

## Typical Agent Workflow

1. `docker compose up -d` — start the harness
2. Agent navigates to `http://pw-server:3001/admin/` via Playwright MCP
3. Widget auto-injects and connects back to the server
4. Agent uses Playwright MCP for navigation and DOM snapshots
5. Agent uses prompt-widget API for screenshots and virtual input
6. Traces and videos are saved to `./artifacts/`

## Collecting Artifacts

```bash
# Playwright traces/videos are auto-saved to ./artifacts/
ls artifacts/

# Or use the collection script for a timestamped snapshot
./scripts/collect-artifacts.sh
```

## Application Container

The `pw-app` service is opt-in via Docker Compose profiles. It runs any Docker image you want to test:

```bash
# Use a pre-built image (default: nginx:alpine)
APP_IMAGE=my-app:latest docker compose --profile app up -d

# Build from a local Dockerfile
cp docker-compose.override.example.yml docker-compose.override.yml
# Edit docker-compose.override.yml with your app's build context
docker compose --profile app up -d
```

The browser can navigate to `http://pw-app:80` (or whatever port your app exposes) and the widget auto-injects.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_PORT` | `3001` | Host port for prompt-widget server |
| `BROWSER_MCP_PORT` | `8931` | Host port for Playwright MCP |
| `PW_SERVER_URL` | `http://pw-server:3001` | Server URL from browser's perspective |
| `PW_APP_KEY` | _(empty)_ | App API key for widget auth |
| `APP_IMAGE` | `nginx:alpine` | Docker image for pw-app |
| `APP_PORT` | `8080` | Host port for pw-app |
| `APP_INTERNAL_PORT` | `80` | Container port for pw-app |
| `HARNESS_ID` | `docker-harness` | Harness ID for self-registration |
| `HARNESS_NAME` | `Docker Harness` | Display name in admin UI |
| `TARGET_APP_URL` | `http://pw-app:80` | App URL from Docker network |
| `BROWSER_MCP_URL` | `http://pw-browser:8931/mcp` | Browser MCP endpoint |

## Troubleshooting

```bash
# Check container logs
docker compose logs pw-server
docker compose logs pw-browser

# Restart after code changes
docker compose build pw-server && docker compose up -d

# Reset DB
docker volume rm prompt-widget_pw-data
docker compose up -d

# Shell into browser container
docker compose exec pw-browser sh
```
