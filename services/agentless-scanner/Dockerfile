# Sutra agentless disk scanner.
#
# Runs in Sutra's own scan account (738663485493), never in a customer account.
# It is handed a COPY of a customer snapshot, attached as a block device, and its
# only job is: mount read-only, run Trivy, emit findings as JSON, exit.
#
# ── WHY THE IMAGE LOOKS LIKE THIS ───────────────────────────────────────────
# * Pinned Trivy by digest, not by tag. The scanner's output IS the product's
#   vulnerability claim, so "which scanner version produced this finding" has to
#   be reproducible. A moving tag makes a finding unexplainable after the fact.
# * The Trivy DB is NOT baked in. A vulnerability database frozen at image build
#   time silently ages, and a scan that reports "no CVEs" from a three-month-old
#   database is worse than no scan. It is fetched at run time and the entrypoint
#   refuses to scan if the fetch failed.
# * No AWS SDK, no credentials, no network egress needed to the control plane.
#   The container does not create, share, or delete snapshots — the executor does
#   that. Keeping the blast radius to "reads a filesystem" is the point.

# Digest resolved from the Docker Hub registry on 2026-07-28 and verified to be
# the manifest 0.72.0 actually points at. If you bump the tag you MUST re-resolve
# the digest — the tag alone is mutable and would silently change which scanner
# produced a customer's findings.
FROM aquasec/trivy:0.72.0@sha256:cffe3f5161a47a6823fbd23d985795b3ed72a4c806da4c4df16266c02accdd6f AS trivy

FROM node:22.23.1-bookworm-slim

# util-linux for blkid/lsblk (filesystem detection), and the xfs/btrfs tools so a
# non-ext4 root volume is mountable rather than silently skipped. Customers run
# Amazon Linux 2023 on xfs by default, so xfsprogs is not optional here.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       util-linux \
       xfsprogs \
       btrfs-progs \
       e2fsprogs \
       ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=trivy /usr/local/bin/trivy /usr/local/bin/trivy

WORKDIR /opt/scanner

# Only the built JS and the production closure. No source, no dev toolchain.
COPY dist/src ./dist/src
COPY package.json ./

# The scan target is mounted here, always read-only. Created up front so a
# mount failure is distinguishable from a missing mount point.
RUN mkdir -p /mnt/scan && chmod 0755 /mnt/scan

# Trivy's database cache. Writable, and deliberately outside /mnt/scan so nothing
# the scanner writes can land on a filesystem derived from customer data.
ENV TRIVY_CACHE_DIR=/var/cache/trivy
RUN mkdir -p /var/cache/trivy

# NOT switched to a non-root user: mounting a block device requires CAP_SYS_ADMIN.
# The compensating controls are that this container holds no credentials, runs in
# Sutra's own isolated scan account, and is handed a throwaway snapshot copy —
# and that SutraAgentlessScannerRole carries explicit denies on the control plane
# (rds, secretsmanager, ssm, dynamodb, iam, sts:AssumeRole) so root here cannot
# reach anything that matters.
#
# The task definition must grant ONLY SYS_ADMIN, never `privileged: true`.

ENTRYPOINT ["node", "dist/src/scan-entrypoint.js"]
