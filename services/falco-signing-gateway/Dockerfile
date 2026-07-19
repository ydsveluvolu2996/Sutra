ARG NODE_IMAGE
FROM ${NODE_IMAGE}

ENV NODE_ENV=production
WORKDIR /opt/sutra

COPY --chown=65532:65532 services/falco-signing-gateway ./services/falco-signing-gateway
COPY --chown=65532:65532 lib/canonical-json.ts ./lib/canonical-json.ts
COPY --chown=65532:65532 lib/falco-request-security.ts ./lib/falco-request-security.ts
COPY --chown=65532:65532 lib/falco-runtime-boundary.ts ./lib/falco-runtime-boundary.ts
COPY --chown=65532:65532 lib/falco-runtime-types.ts ./lib/falco-runtime-types.ts

USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["node", "--experimental-strip-types", "/opt/sutra/services/falco-signing-gateway/server.ts"]
