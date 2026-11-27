# syntax=docker/dockerfile:1.7
# Multi-stage image for the Node services (api and workers).
# Build: docker build -f infra/docker/node-service.Dockerfile --build-arg APP=api .
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH HUSKY=0 TURBO_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate
WORKDIR /repo

FROM base AS build
ARG APP
# Fetch dependencies from the lockfile alone, so this layer is cached until the lockfile changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "@fincore/${APP}..."
RUN pnpm --filter "@fincore/${APP}..." run build
# Produces a self-contained production node_modules with no dev dependencies or sources.
RUN pnpm --filter "@fincore/${APP}" deploy --prod --legacy /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
RUN apk add --no-cache tini
WORKDIR /app
COPY --from=build --chown=root:root /out ./
# Run as the unprivileged built-in "node" user (uid 1000). App files are root-owned, so they're read-only to it.
USER node
# tini is PID 1: it forwards SIGTERM so graceful shutdown works, and it reaps zombies.
ENTRYPOINT ["/sbin/tini", "--"]
# `node .` runs package.json "main": dist/server.js (api) or dist/main.js (workers).
CMD ["node", "--enable-source-maps", "."]
