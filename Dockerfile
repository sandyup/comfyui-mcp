# syntax=docker/dockerfile:1
#
# Container image for the comfyui-mcp server.
# Used by Glama (https://glama.ai) to run automated safety/quality checks.
#
# The server speaks MCP over stdio by default. Point it at a running ComfyUI
# with the COMFYUI_URL env var, e.g.:
#   docker run --rm -i -e COMFYUI_URL=http://host.docker.internal:8188 comfyui-mcp
# To expose the streamable-HTTP transport instead, append CLI flags:
#   docker run --rm -p 9100:9100 comfyui-mcp --http --host 0.0.0.0 --port 9100

# ---- Builder: install deps (incl. native build for better-sqlite3) + compile TS ----
FROM node:22-bookworm AS builder
WORKDIR /app

# Toolchain for native deps (better-sqlite3) when no prebuilt binary is available.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install against the lockfile. scripts/ is needed because our (safe) postinstall
# runs during install; copying it first keeps the dependency layer cacheable.
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci

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
