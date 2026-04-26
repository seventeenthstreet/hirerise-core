# ─────────────────────────────────────────────────────────────
# HireRise Core — Production Dockerfile
# Fixed from api-service/Dockerfile:
#   - Added --frozen-lockfile safety
#   - Non-root user for security
#   - Multi-stage to keep image lean
#   - Health check built in
# ─────────────────────────────────────────────────────────────

FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --frozen-lockfile

# ── Runtime stage ────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Non-root user
RUN addgroup -S hirerise && adduser -S hirerise -G hirerise

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Remove dev files not needed at runtime
RUN rm -rf src/tests __tests__ *.test.js *.spec.js

RUN chown -R hirerise:hirerise /app
USER hirerise

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:8080/api/v1/health || exit 1

CMD ["node", "src/server.js"]