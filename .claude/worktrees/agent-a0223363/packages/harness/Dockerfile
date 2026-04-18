# Stage 1: Build all packages
FROM node:22-bookworm AS build

RUN corepack enable && corepack prepare pnpm@9.14.2 --activate

WORKDIR /app

# Copy workspace config first for better layer caching
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json tsconfig.base.json ./

# Copy package.json files for each package
COPY packages/shared/package.json packages/shared/
COPY packages/widget/package.json packages/widget/
COPY packages/admin/package.json packages/admin/
COPY packages/server/package.json packages/server/

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/shared/ packages/shared/
COPY packages/widget/ packages/widget/
COPY packages/admin/ packages/admin/
COPY packages/server/ packages/server/

# Build everything via turbo (shared -> widget, admin, server in parallel)
RUN pnpm run build

# Stage 2: Production runtime
FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@9.14.2 --activate

WORKDIR /app

# Copy workspace config
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# Copy package.json files
COPY packages/shared/package.json packages/shared/
COPY packages/widget/package.json packages/widget/
COPY packages/admin/package.json packages/admin/
COPY packages/server/package.json packages/server/

# Install production dependencies only
# node-pty needs build tools, install them temporarily
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    pnpm install --frozen-lockfile --prod && \
    npm install -g @anthropic-ai/claude-code && \
    apt-get purge -y python3 make g++ && \
    apt-get autoremove -y && \
    apt-get install -y --no-install-recommends tmux && \
    rm -rf /var/lib/apt/lists/*

# Copy built artifacts from build stage
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/widget/dist packages/widget/dist
COPY --from=build /app/packages/admin/dist packages/admin/dist
COPY --from=build /app/packages/server/dist packages/server/dist

# Copy server static assets
COPY --from=build /app/packages/server/public packages/server/public
COPY --from=build /app/packages/server/tmux-pw.conf packages/server/tmux-pw.conf

COPY packages/harness/scripts/pw-server-entrypoint.sh /scripts/pw-server-entrypoint.sh
RUN chmod +x /scripts/pw-server-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3001
ENV DB_PATH=/data/prompt-widget.db

EXPOSE 3001

# serveStatic paths are relative to cwd (e.g. ../admin/dist/, ../widget/dist/)
WORKDIR /app/packages/server

ENTRYPOINT ["/scripts/pw-server-entrypoint.sh"]
# Main server as PID 1; session-service started in entrypoint
CMD ["node", "dist/index.js"]
