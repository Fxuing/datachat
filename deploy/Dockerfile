# syntax=docker/dockerfile:1

# When built in CI, pass `--build-arg SERVER_BASE_IMAGE=<registry>/datachat-server-base:deps-<hash>`
# so BuildKit skips building `deps-builder`/`runtime-base` and only appends the ~2-5 MB dist layer.
# When built locally (`docker compose up --build`), it defaults to the local `runtime-base` stage.
ARG SERVER_BASE_IMAGE=runtime-base

# ---------- build (pure JS/TS/Vite output; runs natively on $BUILDPLATFORM without QEMU) ----------
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV npm_config_store_dir=/pnpm/store
RUN corepack enable \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/datasource-sdk/package.json packages/datasource-sdk/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN --mount=type=cache,id=pnpm-build-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @datachat/datasource-sdk build \
    && pnpm --filter @datachat/shared build \
    && pnpm -r build

# ---------- local fallback prod-deps (skipped by BuildKit when SERVER_BASE_IMAGE is external) ----------
FROM node:22-bookworm-slim AS deps-builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV npm_config_store_dir=/pnpm/store
RUN corepack enable \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/datasource-sdk/package.json packages/datasource-sdk/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN --mount=type=cache,id=pnpm-prod-store,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --filter @datachat/server...

FROM node:22-bookworm-slim AS runtime-base

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

WORKDIR /app

RUN mkdir -p /data /app/apps/server /app/packages/shared /app/packages/datasource-sdk /app/agent \
    && chown -R node:node /app /data

COPY --chown=node:node --from=deps-builder /app/node_modules ./node_modules
COPY --chown=node:node --from=deps-builder /app/apps/server/node_modules ./apps/server/node_modules
COPY --chown=node:node --from=deps-builder /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --chown=node:node --from=deps-builder /app/package.json ./package.json
COPY --chown=node:node --from=deps-builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --chown=node:node --from=deps-builder /app/packages/datasource-sdk/package.json ./packages/datasource-sdk/package.json
COPY --chown=node:node --from=deps-builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --chown=node:node --from=deps-builder /app/apps/server/package.json ./apps/server/package.json

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>r.json()).then(j=>{if(!j.ok||j.db!=='ok')process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]

# ---------- runtime (thin app layer on top of prebuilt or local runtime-base) ----------
FROM ${SERVER_BASE_IMAGE} AS runtime

COPY --chown=node:node --from=build /app/packages/datasource-sdk/dist ./packages/datasource-sdk/dist
COPY --chown=node:node --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --chown=node:node --from=build /app/apps/server/dist ./apps/server/dist
COPY --chown=node:node --from=build /app/agent ./agent

# ---------- web ----------
FROM nginx:1.27-alpine AS web

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
