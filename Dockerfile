# Standalone ProPanes server image (feedback overlay + admin SPA + API).
#
# Built from the repo root:  docker build -t propanes-server .
#
# Serves on :3001 — the Hono server statically serves packages/admin/dist
# (/admin) and packages/widget/dist (/widget) and exposes the feedback + session
# API. SQLite lives at $DB_PATH (mount a volume at /data to persist it).
#
# The production image also runs the in-pod launcher + headed browser stack so
# agent dispatch and noVNC survive pod restarts.

# ---- Stage 1: build the whole workspace -------------------------------------
FROM node:22-bookworm AS build
RUN corepack enable && corepack prepare pnpm@9.14.2 --activate
WORKDIR /app

# Workspace config first for layer caching
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/widget/package.json packages/widget/
COPY packages/admin/package.json packages/admin/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile

# Sources + build (shared -> widget, admin, server)
COPY packages/shared/ packages/shared/
COPY packages/widget/ packages/widget/
COPY packages/admin/ packages/admin/
COPY packages/server/ packages/server/
RUN pnpm run build

# ---- Stage 2: production runtime --------------------------------------------
FROM node:22-bookworm-slim
RUN corepack enable && corepack prepare pnpm@9.14.2 --activate
RUN groupadd --gid 10001 propanes \
 && useradd --uid 10001 --gid 10001 --home-dir /data/agent-home --shell /bin/bash propanes
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/widget/package.json packages/widget/
COPY packages/admin/package.json packages/admin/
COPY packages/server/package.json packages/server/

# better-sqlite3 + node-pty are native; install build tools just long enough to
# compile them, keep tmux for the session terminals, and add the launcher/noVNC
# runtime stack used by the production pod.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && pnpm install --frozen-lockfile --prod \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl fluxbox imagemagick novnc psmisc tmux util-linux websockify \
      x11-utils x11-xserver-utils x11vnc xauth xvfb \
 && rm -rf /var/lib/apt/lists/*

# Playwright MCP + headed Chromium. The MCP/browser process runs as root so the
# browser cache stays readable at /root/.cache; Claude/Codex agents run as the
# non-root propanes user with their writable home on /data.
RUN npm i -g \
      @anthropic-ai/claude-code@2.1.202 \
      @openai/codex@0.142.5 \
      @playwright/mcp@latest \
      playwright@latest \
 && npx --yes playwright install --with-deps chromium \
 && ln -s "$(npm root -g)" /root/node_modules \
 && mkdir -p /root/.claude /root/.codex \
 && node -e 'const f="/root/.claude.json";const fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(f))}catch(e){};j.mcpServers=Object.assign({},j.mcpServers,{playwright:{type:"http",url:"http://localhost:8931/mcp"}});fs.writeFileSync(f,JSON.stringify(j))'

COPY --from=build /app/packages/shared/dist  packages/shared/dist
COPY --from=build /app/packages/widget/dist  packages/widget/dist
COPY --from=build /app/packages/admin/dist   packages/admin/dist
COPY --from=build /app/packages/server/dist  packages/server/dist
COPY --from=build /app/packages/server/public        packages/server/public
COPY --from=build /app/packages/server/tmux-pw.conf  packages/server/tmux-pw.conf

ENV NODE_ENV=production
ENV PORT=3001
ENV DB_PATH=/data/propanes.db

COPY docker-launcher-entrypoint.sh /usr/local/bin/docker-launcher-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-launcher-entrypoint.sh

EXPOSE 3001 6080
# serveStatic paths are relative to cwd (../admin/dist, ../widget/dist)
WORKDIR /app/packages/server

CMD ["/usr/local/bin/docker-launcher-entrypoint.sh"]
