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

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /app /app
RUN mkdir -p /app/runtime /app/.sutra /app/.wrangler \
    && ln -sfn /app/runtime/.dev.vars /app/.dev.vars \
    && chown -h node:node /app/.dev.vars \
    && chown -R node:node /app/runtime /app/.sutra /app/.wrangler
USER node

EXPOSE 3000
ENTRYPOINT ["/app/docker/entrypoint.sh"]
