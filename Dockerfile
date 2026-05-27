# =============================================================================
# HireRise Core — Production Dockerfile
# Multi-stage | Non-root | Distroless-lite | Signal-safe
# =============================================================================

# ── Stage 1: dependency resolution ─────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Copy manifests only — cached unless package*.json changes
COPY package.json package-lock.json ./

# Production-only install, locked versions
RUN npm ci --omit=dev --frozen-lockfile --ignore-scripts \
 && npm cache clean --force

# ── Stage 2: build / prune ──────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Remove test artifacts, dev tooling, and sensitive local config
RUN rm -rf \
      src/tests \
      __tests__ \
      tests \
      "src/ai/observability/'use strict'" \
      *.test.js \
      *.spec.js \
      .env \
      .env.* \
      scripts/maintenance \
      nodemon.json \
      .eslint* \
      .dependency-cruiser.cjs

# ── Stage 3: runtime ────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Security: least-privilege process account
RUN addgroup -g 1001 -S hirerise \
 && adduser  -u 1001 -S hirerise -G hirerise

# Install only tini for proper PID-1 / signal forwarding
RUN apk add --no-cache tini

# Bring in only production artefacts
COPY --from=builder --chown=hirerise:hirerise /app/node_modules ./node_modules
COPY --from=builder --chown=hirerise:hirerise /app/src         ./src
COPY --from=builder --chown=hirerise:hirerise /app/shared      ./shared
COPY --from=builder --chown=hirerise:hirerise /app/package.json ./package.json

# ── Runtime hardening ───────────────────────────────────────────────────────
ENV NODE_ENV=production \
    PORT=8080 \
    # Prevent Node from running as root if USER directive is bypassed
    NODE_OPTIONS="--max-old-space-size=512" \
    # Disable npm update-notifier at runtime
    NO_UPDATE_NOTIFIER=1

USER hirerise
EXPOSE 8080

# Health — lightweight wget (alpine built-in)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:8080/api/v1/health || exit 1

# tini as PID 1 ensures SIGTERM/SIGINT are forwarded to the Node process
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
