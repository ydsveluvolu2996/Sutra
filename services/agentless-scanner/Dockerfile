# Sutra agentless disk scanner.
#
# Runs in Sutra's own scan account (738663485493), never in a customer account.
# It is handed a COPY of a customer snapshot, attached as a block device, and its
# only job is: mount read-only, run Trivy, emit findings as JSON, exit.
#
# ── WHY THE IMAGE LOOKS LIKE THIS ───────────────────────────────────────────
# * Trivy is built from a checksum-verified stable Go module. The scanner's
#   output IS the product's vulnerability claim, so the exact release and
#   patched dependency closure must be reproducible.
# * Both Trivy databases are baked into the immutable release image. Production
#   scan subnets have no Internet path: the entrypoint verifies Trivy's actual
#   vulnerability and Java DB metadata on every run, refuses stale content, and
#   scans with both update mechanisms disabled.
# * No AWS SDK, no credentials, no network egress needed to the control plane.
#   The container does not create, share, or delete snapshots — the executor does
#   that. Keeping the blast radius to "reads a filesystem" is the point.

# Trivy 0.72.0's published binary still contains fixed High-severity Go
# dependencies. Build the stable module with those dependencies upgraded instead
# of shipping a known-vulnerable security scanner. go-git joined the override
# list for CVE-2026-71556 (fixed in 5.19.2), which Trivy 0.72.0 pins below.
# x/net joined for CVE-2026-46600, a denial of service parsing invalid DNS
# records (fixed in 0.56.0). The toolchain image moved 1.26.5 -> 1.26.6 for the
# same CVE in the standard library plus CVE-2026-39821, a privilege escalation
# via incorrect Punycode label processing in net/http's use of x/net/idna. Both
# were published after the previous pin and are reported by the image scan
# against the built binary, not against anything Sutra wrote.
# Building it as a dependency
# of a tiny external module is intentional: Go then records Trivy's real v0.72.0
# module version in the binary instead of the unversioned/pseudo-version metadata
# produced when compiling a source checkout. Both the Go toolchain image and all
# downloaded modules are cryptographically pinned.
FROM golang:1.26.6-bookworm@sha256:116d58cbd88c1297624acc6e967a060012422bacf9930927e23fb719189c6f36 AS trivy

WORKDIR /src/build

# Go's checksum database verifies the complete module closure. The expected
# module content hashes below add a fail-closed, reviewable pin for Trivy and
# each security override rather than trusting a mutable tag or a floating proxy
# response. The external build module is never copied into the runtime image.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
  go mod init sutra.local/trivy-release-build \
  && go mod edit -go=1.26.0 \
  && go mod edit -require=github.com/aquasecurity/trivy@v0.72.0 \
  && go mod edit -replace=golang.org/x/text=golang.org/x/text@v0.39.0 \
  && go mod edit -replace=google.golang.org/grpc=google.golang.org/grpc@v1.82.1 \
  && go mod edit -replace=oras.land/oras-go/v2=oras.land/oras-go/v2@v2.6.2 \
  && go mod edit -replace=github.com/go-git/go-git/v5=github.com/go-git/go-git/v5@v5.19.2 \
  && go mod edit -replace=golang.org/x/net=golang.org/x/net@v0.56.0 \
  && TRIVY_MODULE="$(GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org \
       go mod download -json github.com/aquasecurity/trivy@v0.72.0)" \
  && printf '%s\n' "${TRIVY_MODULE}" \
       | grep -Fq '"Sum": "h1:W3v+NE94olOzk3nSwwha59DTBsbcgLRXa4QNSJpRQQM="' \
  && XTEXT_MODULE="$(GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org \
       go mod download -json golang.org/x/text@v0.39.0)" \
  && printf '%s\n' "${XTEXT_MODULE}" \
       | grep -Fq '"Sum": "h1:UbZz4pLOvn600D6Oh6GGEI6VAmndrEBLv8/6BEXzyus="' \
  && GRPC_MODULE="$(GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org \
       go mod download -json google.golang.org/grpc@v1.82.1)" \
  && printf '%s\n' "${GRPC_MODULE}" \
       | grep -Fq '"Sum": "h1:NnAxzGRA0677vCa4BUkOAnO5+FfQqVl9iUXeD0IqcGE="' \
  && ORAS_MODULE="$(GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org \
       go mod download -json oras.land/oras-go/v2@v2.6.2)" \
  && printf '%s\n' "${ORAS_MODULE}" \
       | grep -Fq '"Sum": "h1:N04RXngAp1LJKTG6ifz3xHPipasEkWr+hFmInja5YKo="' \
  && GOGIT_MODULE="$(GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org \
       go mod download -json github.com/go-git/go-git/v5@v5.19.2)" \
  && printf '%s\n' "${GOGIT_MODULE}" \
       | grep -Fq '"Sum": "h1:wkfn7vOlUBu8ivAWKBWisTiwJK4jYHzTF8Ndv1LyGqY="' \
  && XNET_MODULE="$(GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org \
       go mod download -json golang.org/x/net@v0.56.0)" \
  && printf '%s\n' "${XNET_MODULE}" \
       | grep -Fq '"Sum": "h1:Rw8j/hFzGvJUZwNBXnAtf5sVDVt+65SK2C7IxCxZt5o="' \
  && GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org go mod download all \
  && CGO_ENABLED=0 GOEXPERIMENT=jsonv2 GOMAXPROCS=2 \
     GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org go build \
       -mod=mod \
       -p=2 \
       -trimpath \
       -ldflags="-s -w -extldflags '-static' -X github.com/aquasecurity/trivy/pkg/version/app.ver=0.72.0-sutra.1" \
       -o /out/trivy \
       github.com/aquasecurity/trivy/cmd/trivy

# Fetch both official Trivy databases during the controlled release build. They
# become part of the immutable scanner digest that is scanned and promoted; the
# production instance never talks to public OCI registries.
FROM trivy AS trivy-db
ENV TRIVY_CACHE_DIR=/out/trivy-cache
RUN /out/trivy image --download-db-only \
  && /out/trivy image --download-java-db-only \
  && test -s /out/trivy-cache/db/trivy.db \
  && test -s /out/trivy-cache/db/metadata.json \
  && test -s /out/trivy-cache/java-db/trivy-java.db \
  && test -s /out/trivy-cache/java-db/metadata.json

# Multi-architecture manifest resolved from the official Node registry on
# 2026-07-31. Pinning the Alpine 3.23 digest makes the runtime packages
# reproducible while retaining the explicit Node 22.23.1 release line. Debian
# 12 carries unfixed High/Critical findings in its base utilities; the scanner
# gate intentionally rejects those rather than suppressing them.
FROM node:22.23.1-alpine3.23@sha256:8516dce0483394d5708d4b2ee6cacb79fb1d617ea4e2787c2120bcca92ce372e AS scanner-runtime-packages

# util-linux for blkid/lsblk (filesystem detection), and the xfs/btrfs tools so a
# non-ext4 root volume is mountable rather than silently skipped. Customers run
# Amazon Linux 2023 on xfs by default, so xfsprogs is not optional here.
RUN apk add --no-cache \
       util-linux \
       xfsprogs \
       btrfs-progs \
       e2fsprogs \
       ca-certificates

# Remove the bundled package managers. This container runs as root, holds
# CAP_SYS_ADMIN, and has an untrusted customer filesystem mounted at /mnt/scan —
# a package manager is the last thing that should be reachable in that position,
# and nothing here uses one (the entrypoint is plain `node`, and the production
# closure is copied in at build time). It is also the only *fixable* CRITICAL the
# image carried: Trivy flagged CVE-2026-59873 against npm's bundled tar 7.5.11.
# The root Dockerfile strips these for the same reason.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/pnpm /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    /sbin/apk /usr/sbin/apk /usr/bin/apk

FROM scanner-runtime-packages

COPY --from=trivy /out/trivy /usr/local/bin/trivy
COPY --from=trivy-db /out/trivy-cache /var/cache/trivy

WORKDIR /opt/scanner

# Only the built JS and the production closure. No source, no dev toolchain.
COPY dist/src ./dist/src
COPY package.json ./

# The scan target is mounted here, always read-only. Created up front so a
# mount failure is distinguishable from a missing mount point.
RUN mkdir -p /mnt/scan && chmod 0755 /mnt/scan

# Trivy's baked database cache is deliberately outside /mnt/scan so nothing the
# scanner writes can land on a filesystem derived from customer data. It is
# copied from the release-build stage; there is no runtime database download.
ENV TRIVY_CACHE_DIR=/var/cache/trivy

# NOT switched to a non-root user: mounting a block device requires CAP_SYS_ADMIN.
# The compensating controls are that this container holds no credentials, runs in
# Sutra's own isolated scan account, and is handed a throwaway snapshot copy —
# and that SutraAgentlessScannerRole carries explicit denies on the control plane
# (rds, secretsmanager, ssm, dynamodb, iam, sts:AssumeRole) so root here cannot
# reach anything that matters.
#
# The task definition must grant ONLY SYS_ADMIN, never `privileged: true`.

ENTRYPOINT ["node", "dist/src/scan-entrypoint.js"]
