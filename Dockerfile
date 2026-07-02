# Standalone ProPanes server image (feedback overlay + admin SPA + API).
#
# Built from the repo root:  docker build -t propanes-server .
#
# Serves on :3001 — the Hono server statically serves packages/admin/dist
# (/admin) and packages/widget/dist (/widget) and exposes the feedback + session
# API. SQLite lives at $DB_PATH (mount a volume at /data to persist it).
#
# NOTE: the agent/terminal *launcher* (Docker-socket based dispatch) is NOT
# wired up here — that needs a Docker host and does not run on serverless
# container platforms (Azure Container Apps). The feedback inbox, admin
# dashboard, and widget all work without it.

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
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/widget/package.json packages/widget/
COPY packages/admin/package.json packages/admin/
COPY packages/server/package.json packages/server/

# better-sqlite3 + node-pty are native; install build tools just long enough to
# compile them, keep tmux for the session terminals, then slim back down.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && pnpm install --frozen-lockfile --prod \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && apt-get install -y --no-install-recommends tmux \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/packages/shared/dist  packages/shared/dist
COPY --from=build /app/packages/widget/dist  packages/widget/dist
COPY --from=build /app/packages/admin/dist   packages/admin/dist
COPY --from=build /app/packages/server/dist  packages/server/dist
COPY --from=build /app/packages/server/public        packages/server/public
COPY --from=build /app/packages/server/tmux-pw.conf  packages/server/tmux-pw.conf

ENV NODE_ENV=production
ENV PORT=3001
ENV DB_PATH=/data/propanes.db

EXPOSE 3001
# serveStatic paths are relative to cwd (../admin/dist, ../widget/dist)
WORKDIR /app/packages/server

# session-service (live terminals) in the background; main server as PID 1.
CMD ["sh", "-c", "node dist/session-service.js & exec node dist/index.js"]
