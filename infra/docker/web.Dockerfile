# syntax=docker/dockerfile:1.7
# Next.js standalone image.
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH HUSKY=0 TURBO_TELEMETRY_DISABLED=1 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "@fincore/web..."
RUN pnpm --filter "@fincore/web..." run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
RUN apk add --no-cache tini
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]
