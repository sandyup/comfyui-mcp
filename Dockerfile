# syntax=docker/dockerfile:1
#
# Container image for the comfyui-mcp server.
# Used by Glama (https://glama.ai) to run automated safety/quality checks.
#
# The server speaks MCP over stdio by default. Point it at a running ComfyUI
# with the COMFYUI_URL env var, e.g.:
#   docker run --rm -i -e COMFYUI_URL=http://host.docker.internal:8188 comfyui-mcp
# To expose the streamable-HTTP transport instead, append CLI flags. NOTE:
# binding a non-loopback host (0.0.0.0) without auth HARD-FAILS by design —
# pass a token (recommended) or the explicit unauthenticated opt-out:
#   docker run --rm -p 9100:9100 -e COMFYUI_MCP_HTTP_TOKEN=changeme comfyui-mcp \
#     --http --host 0.0.0.0 --port 9100
#   docker run --rm -p 9100:9100 comfyui-mcp \
#     --http --host 0.0.0.0 --port 9100 --allow-unauthenticated-non-loopback

# ---- Builder: install deps (incl. native build for better-sqlite3) + compile TS ----
FROM node:22-bookworm AS builder
WORKDIR /app

# Toolchain for native deps (better-sqlite3) when no prebuilt binary is available.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install against the lockfile. scripts/ is copied first so the dep layer stays
# cacheable when only src/ changes.
#
# We pass --ignore-scripts to skip ALL install hooks, then explicitly rebuild
# the native deps we actually need. Why: the optional `cloudflared` package's
# postinstall downloads a ~40 MB binary from GitHub releases over an
# https.get() call with no timeout. On rate-limited CI networks (notably
# Glama's build sandbox) that request hangs indefinitely and the whole image
# build stalls. The runtime tunnel helper in src/services/tunnel.ts already
# downloads the binary lazily on first use, so dropping the install-time
# fetch is safe. better-sqlite3 + sharp still need their `install` scripts
# to fetch / build their native bindings, hence the explicit rebuild.
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --ignore-scripts \
  && npm rebuild better-sqlite3 sharp

# Compile TypeScript -> dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies; the compiled native modules in node_modules are kept.
RUN npm prune --omit=dev

# ---- Runtime: slim image with only production artifacts ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# bookworm <-> bookworm-slim share glibc, so the native better-sqlite3 binary
# built in the builder stage is ABI-compatible here.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --chown=node:node scripts ./scripts

# Run as the image's built-in unprivileged user.
USER node

ENTRYPOINT ["node", "dist/index.js"]
