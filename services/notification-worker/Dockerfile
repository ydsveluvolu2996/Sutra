FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS build

ENV COREPACK_HOME=/opt/corepack \
    PNPM_HOME=/opt/pnpm \
    PATH=/opt/pnpm:$PATH

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.13.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/aws-collector/package.json services/aws-collector/package.json
COPY services/notification-worker/package.json services/notification-worker/package.json
RUN pnpm --filter @sutra/notification-worker install --frozen-lockfile

COPY db ./db
COPY lib ./lib
COPY services/notification-worker ./services/notification-worker
RUN pnpm --filter @sutra/notification-worker exec esbuild \
      runtime.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=esm \
      --outfile=/out/runtime.mjs

FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:a2723a2817c5b01b8e7b98d567bc8b5a6b0e713e25bfb0a82b6ade4b9db06f50

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=65532:65532 /out/runtime.mjs /app/runtime.mjs
COPY --from=build --chown=65532:65532 /app/services/notification-worker/production-entrypoint.mjs /app/production-entrypoint.mjs

USER 65532:65532
EXPOSE 8081
ENTRYPOINT ["node", "/app/production-entrypoint.mjs"]
