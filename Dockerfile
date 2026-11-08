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
#
# Node is pinned to 22, not 24, deliberately: this image's AKS deployment can
# run from an NFS-mounted source override (see docker-launcher-entrypoint.sh's
# NFS_MARKER path) whose better-sqlite3 native addon is compiled against
# Node 22's ABI. The CVE fix that matters here is the pnpm 9.15.9 -> 12.11.2
# bump (it replaces pnpm's own bundled tar/brace-expansion/minimatch/undici/
# glob/pacote); Node 22 + pnpm 12.11.2 clears the same findings without an
# ABI mismatch against that NFS tree.

# ---- Stage 1: build the whole workspace -------------------------------------
FROM node:22-bookworm AS build
RUN corepack enable && corepack prepare pnpm@12.18.0 --activate
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
# node:*-slim ships with no locale set (POSIX/C). tmux then renders every
# non-ASCII glyph in the agent TUIs as "_", so Claude Code's arrows/ellipses
# show up as "--" in the browser terminal. C.UTF-8 is built into glibc.
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8
RUN corepack enable && corepack prepare pnpm@12.18.0 --activate
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
# python3 stays: agent/dev tooling below (and the az CLI installer) needs it.
# xz-utils: linear-cli's npm install script untars a .tar.xz release (slim has no xz).
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && pnpm install --frozen-lockfile --prod \
 && apt-get purge -y make g++ \
 && apt-get autoremove -y \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl feh fluxbox imagemagick novnc psmisc tmux util-linux websockify \
      x11-utils x11-xserver-utils x11vnc xauth xvfb xz-utils \
 # Debian's novnc package hard-depends on Debian's own nodejs (-> libnode108
 # -> node-undici 5.15.0, a real CVE cluster per `npm audit`), purely to ship
 # a couple of unused build-time helper scripts (utils/genkeysymdef.js,
 # utils/use_require.js). The actual noVNC client is the static HTML/JS/CSS
 # under /usr/share/novnc/app, served by websockify's own --web flag (Python,
 # not Node) — see docker-launcher-entrypoint.sh. Keep just those static
 # assets and purge the Debian nodejs chain that dragged node-undici in.
 && mkdir -p /opt/novnc && cp -r /usr/share/novnc/. /opt/novnc/ \
 && apt-get purge -y nodejs novnc \
 && apt-get autoremove -y \
 # node-undici's own dpkg entry survives a plain purge as "config-files"
 # (deinstall ok config-files, version still recorded) even though it has no
 # actual conffiles — that residual version string is exactly what a
 # dpkg-status-based image scan keys on, so purge it again explicitly.
 && dpkg --purge node-undici 2>/dev/null || true \
 && rm -rf /var/lib/apt/lists/*

# Playwright MCP + headed Chromium. The MCP/browser process runs as root so the
# browser cache stays readable at /root/.cache; Claude/Codex agents run as the
# non-root propanes user with their writable home on /data.
#
# npm self-update first: node:22-bookworm-slim's bundled npm vendors its own
# old copies of picomatch, brace-expansion, sigstore, pacote, and ip-address
# (all real CVEs per `npm audit`, living under npm's own node_modules, not
# ours). npm's own maintainers don't ship clean nested copies of all of
# those together: npm@12.2.2 (latest, 2026-11-08) still vendors
# ip-address@10.7.1, undici@6.29.0, glob@13.0.6 and minimatch@10.2.5, each
# behind a CVE fix (10.7.4 / 6.29.1 / 14.0.2 / 11.0.1) — swap just those
# nested copies (plus the earlier brace-expansion / postcss-selector-parser
# pins) for clean ones, and linear-cli's vendored glob/minimatch below.
RUN npm install -g npm@latest \
 # Each replacement is staged with its own dependencies nested under it (npm
 # still works while staging), then moved over npm's vendored copy. glob 14 and
 # minimatch 11 are majors for npm (GHSA-3g3m-2fjr-6pw4 / GHSA-g3hv-75wg-m249
 # have no fix on glob 13 or minimatch 10); `npm install`, `npm pack` and
 # `npm ls -g` were checked against them on 2026-11-08.
 && for spec in brace-expansion@5.0.12 ip-address@10.7.4 postcss-selector-parser@7.1.6 \
                undici@6.29.1 glob@14.0.4 minimatch@11.0.5; do \
      d=/tmp/stage/${spec%@*}; mkdir -p "$d"; \
      ( cd "$d" && npm install --no-save --no-package-lock --no-audit --no-fund \
          --install-strategy=nested --ignore-scripts "$spec" ) || exit 1; \
    done \
 && for name in brace-expansion ip-address postcss-selector-parser undici glob minimatch; do \
      rm -rf "$(npm root -g)/npm/node_modules/$name" \
      && cp -a "/tmp/stage/$name/node_modules/$name" "$(npm root -g)/npm/node_modules/$name" || exit 1; \
    done \
 && npm i -g \
      @anthropic-ai/claude-code@2.1.232 \
      @openai/codex@0.142.5 \
      @schpet/linear-cli@2.2.0 \
      @playwright/mcp@latest \
      playwright@latest \
 # @schpet/linear-cli vendors its own axios/form-data/minimatch/glob (via
 # rimraf) and pins versions with known CVEs (axios SSRF/prototype-pollution,
 # form-data CRLF injection, minimatch/brace-expansion ReDoS) regardless of
 # which linear-cli release is installed — upstream hasn't bumped them.
 # Force the patched versions into its own nested node_modules so the fix
 # survives npm's dedup; linear-cli's CLI surface (axios GET/POST calls) is
 # unaffected by these patch/minor bumps.
 && ( cd "$(npm root -g)/@schpet/linear-cli" \
      && npm install --no-save --no-package-lock \
           axios@^1.20.0 form-data@^4.0.6 ) \
 && for name in glob minimatch; do \
      rm -rf "$(npm root -g)/@schpet/linear-cli/node_modules/$name" \
      && cp -a "/tmp/stage/$name/node_modules/$name" "$(npm root -g)/@schpet/linear-cli/node_modules/$name" || exit 1; \
    done \
 && rm -rf /tmp/stage \
 && npx --yes playwright install --with-deps chromium \
 && ln -s "$(npm root -g)" /root/node_modules \
 && mkdir -p /root/.claude /root/.codex \
 && node -e 'const f="/root/.claude.json";const fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(f))}catch(e){};j.mcpServers=Object.assign({},j.mcpServers,{playwright:{type:"http",url:"http://localhost:8931/mcp"}});fs.writeFileSync(f,JSON.stringify(j))'

# In-session `claude update` can't write the root-owned npm-global tree, so
# swap npm's /usr/local/bin/claude symlink for a shim that prefers a
# user-owned native install on the persistent /data volume (see the shim).
COPY docker-claude-shim.sh /usr/local/bin/docker-claude-shim.sh
RUN rm /usr/local/bin/claude \
 && cp /usr/local/bin/docker-claude-shim.sh /usr/local/bin/claude \
 && chmod +x /usr/local/bin/claude /usr/local/bin/docker-claude-shim.sh

# Dev/agent tooling for in-container terminal sessions: enough to fetch and
# run installers for the rest (az via aka.ms/InstallAzureCLIDeb, aws via the
# zip installer). gh comes from GitHub's apt repo. Deliberately NOT baking the
# heavy CLIs (az alone is >1GB) — install those at runtime where needed; they
# don't survive a pod restart, but the fetch tools to reinstall them always
# will.
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends \
      curl wget git ca-certificates gnupg jq unzip zip less procps \
      openssh-client python3-venv python3-pip \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
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

COPY docker-launcher-entrypoint.sh /usr/local/bin/docker-launcher-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-launcher-entrypoint.sh

EXPOSE 3001 6080
# serveStatic paths are relative to cwd (../admin/dist, ../widget/dist)
WORKDIR /app/packages/server

CMD ["/usr/local/bin/docker-launcher-entrypoint.sh"]
