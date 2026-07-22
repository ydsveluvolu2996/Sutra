FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS base

ENV COREPACK_HOME=/opt/corepack \
    PNPM_HOME=/opt/pnpm \
    PATH=/opt/pnpm:$PATH

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.13.1 --activate

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/aws-collector/package.json services/aws-collector/package.json
COPY services/notification-worker/package.json services/notification-worker/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
COPY . .
RUN chmod 0755 docker/entrypoint.sh docker/postgres-init.sh
RUN pnpm --dir services/aws-collector build && pnpm build

FROM dependencies AS runtime-dependencies
RUN pnpm --filter sutra deploy --prod /app/.runtime/root \
    && pnpm --filter @msp/aws-collector deploy --prod /app/.runtime/collector

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The runtime launches only Node, the built Worker through Wrangler, and the
# compiled AWS collector. Package managers and their bundled build/signing
# dependencies are not an application runtime surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/pnpm /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --from=runtime-dependencies --chown=node:node /app/.runtime/root/node_modules /app/node_modules
COPY --from=runtime-dependencies --chown=node:node /app/.runtime/collector/node_modules /app/services/aws-collector/node_modules
COPY --from=builder --chown=node:node /app/dist /app/dist
COPY --from=builder --chown=node:node /app/services/aws-collector/dist /app/services/aws-collector/dist
COPY --from=builder --chown=node:node /app/package.json /app/package.json
COPY --from=builder --chown=node:node /app/services/aws-collector/package.json /app/services/aws-collector/package.json
COPY --from=builder --chown=node:node /app/scripts/start-pilot.mjs /app/scripts/start-pilot.mjs
COPY --from=builder --chown=node:node /app/scripts/internal-job-request.mjs /app/scripts/internal-job-request.mjs
COPY --from=builder --chown=node:node /app/scripts/setup-local-pilot.mjs /app/scripts/setup-local-pilot.mjs
COPY --from=builder --chown=node:node /app/scripts/postgres-migrate.mjs /app/scripts/postgres-migrate.mjs
COPY --from=builder --chown=node:node /app/postgres/migrations /app/postgres/migrations
COPY --from=builder --chown=node:node /app/docker/entrypoint.sh /app/docker/entrypoint.sh
COPY --from=builder --chown=node:node /app/docker/postgres-init.sh /app/docker/postgres-init.sh
COPY --from=builder --chown=node:node /app/deploy/ec2 /app/deploy/ec2

RUN mkdir -p /app/runtime /app/.sutra /app/.wrangler \
    && ln -sfn /app/runtime/.dev.vars /app/.dev.vars \
    && chown -h node:node /app/.dev.vars \
    && chown -R node:node /app/runtime /app/.sutra /app/.wrangler
USER node

EXPOSE 3000
ENTRYPOINT ["/app/docker/entrypoint.sh"]
