# Multi-stage build for the deploy-test-dockerfile task board.
#
# `better-sqlite3` always rebuilds its native addon for Alpine/musl, so the
# dependency stage carries a compile toolchain; the runtime stage intentionally
# contains none of those tools, keeping the production image small.

# ---- Stage 1: production dependencies (compiled) ----
FROM node:22.23.2-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- Stage 2: runtime ----
FROM node:22.23.2-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATABASE_PATH=/data/taskboard.sqlite

WORKDIR /app

# Non-root runtime user (high random uid is intentionally not 0).
RUN addgroup -g 61000 app \
    && adduser -u 61000 -G app -s /sbin/nologin -D app

COPY --from=deps /deps/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server.js app.js ./
COPY lib ./lib
COPY routes ./routes
COPY public ./public

# Build-time marker override (non-sensitive, shown in UI footer and /api/info).
ARG BUILD_MARKER
ENV BUILD_MARKER=${BUILD_MARKER}

# Persistent data volume; the image writes the SQLite database and its WAL
# files here. Mount a real volume over /data at run time to keep data across
# container replacement.
RUN mkdir -p /data && chown -R app:app /data
VOLUME ["/data"]

USER app

EXPOSE 8080

# Readiness-aware healthcheck: the container is only healthy when the HTTP
# server responds AND the database probe succeeds. No static success marker.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD node --input-type=module -e "fetch('http://127.0.0.1:8080/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(err=>{console.error(err.message);process.exit(1)})"

CMD ["node", "server.js"]
