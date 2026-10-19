# syntax=docker/dockerfile:1
# DB-Sankhya — single image serving the API and the web UI.

ARG NODE_IMAGE=node:24-slim

# ---------------------------------------------------------------------------
# build: install everything, compile the web UI and bundle the API
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN npm install -g pnpm@11.23.0 && npm cache clean --force
WORKDIR /src

# Manifests first so the dependency layer is cached between source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/database/package.json packages/database/
COPY packages/sankhya-client/package.json packages/sankhya-client/
COPY packages/shared/package.json packages/shared/
COPY packages/sql-engine/package.json packages/sql-engine/
COPY e2e/package.json e2e/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Production-only node_modules for the API bundle (workspace packages are inlined by esbuild).
RUN pnpm --filter @dbx/api deploy --prod --legacy /out \
 && rm -rf /out/src /out/scripts /out/tsconfig.json /out/dist \
 && cp -r apps/api/dist /out/dist \
 && cp -r apps/web/dist /out/public

# ---------------------------------------------------------------------------
# runtime: minimal image, non-root user, no build tooling
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG GIT_COMMIT=
ENV NODE_ENV=production \
    GIT_COMMIT=${GIT_COMMIT} \
    HOST=0.0.0.0 \
    PORT=3001 \
    STATIC_DIR=/app/public
WORKDIR /app

COPY --from=build --chown=node:node /out /app

USER node
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/server.mjs"]
