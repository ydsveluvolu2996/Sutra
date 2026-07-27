# Agentless snapshot scanning — design

**Status:** partially implemented — planner, orchestrator, persistence, IAM and
the AWS executor exist and are unit-tested; **no call has ever run against AWS**.
The executor refuses to act unless constructed with `liveValidated: true`, which
an operator may set only after validating each EC2 call live. Still missing: the
scanner container that mounts the volume and runs Trivy, the API/UI surface, the
sweeper, and Sutra's scan-account infrastructure.

**Trust decision (2026-07-28, changed from the original proposal below).** Sutra
may CREATE snapshots but may DELETE NOTHING in a customer account — not even a
snapshot it created. The customer role carries an explicit IAM deny on
`DeleteSnapshot`, `DeleteVolume`, `DetachVolume`, `ModifyVolume`,
`TerminateInstances`, `StopInstances`, `RebootInstances`, `DeregisterImage` and
`DeleteTags`. Cleanup is performed by a customer-owned Data Lifecycle Manager
policy that the same CloudFormation stack installs, running under the customer's
own service role on a retention window they choose and can pause from their own
console. The consequence is stated rather than hidden: if that policy is removed,
snapshots accumulate and bill, and Sutra reports them as an explicit liability.

The `## Architecture (proposed)` and `## Trust & cost boundary` sections below are
kept for provenance but are SUPERSEDED on two points: step 6 ("Guaranteed
teardown ... the source snapshot") and the customer-role action list, which no
longer includes any delete.

## Why
Today Sutra collects Kubernetes/EKS evidence via an in-cluster agent (read-only
metadata) plus ingested Trivy CRDs, and AWS evidence via the customer-role
collector. There is **no agentless path** that scans an EBS-backed workload's
disk without running anything inside the customer's node. Agentless snapshot
scanning is the feature Wiz pioneered and the main architectural gap vs. the
market leaders.

## Goal & boundary
Scan the *contents* of EC2/EKS node (and, by extension, container-layer) volumes
for vulnerabilities, secrets, and malware **without** deploying a scanning agent
on the customer's workloads, and **without** Sutra ever holding customer data at
rest. Evidence-honest invariants carry over: metadata-only findings, no raw file
contents/samples retained, absence of a scan is `unknown` not `clean`.

## Architecture (proposed)
1. **Discover** target volumes: from the AWS CMDB, enumerate EC2 instances /
   EKS node groups and their attached EBS volumes (`DescribeInstances`,
   `DescribeVolumes`). Tag-scoped to the customer's opted-in accounts.
2. **Snapshot**: `CreateSnapshot` per target volume (point-in-time, read-only),
   tagged `sutra-agentless=true` with a TTL for guaranteed cleanup.
3. **Share/copy into the scanning account**: `ModifySnapshotAttribute` (or a
   re-encrypt `CopySnapshot` with a Sutra-owned KMS key) so the snapshot is
   readable only by the disposable scanner, never by the control plane.
4. **Scan in a disposable worker**: a short-lived, isolated compute (Fargate
   task or an autoscaled worker) in Sutra's scanning account creates a volume
   from the snapshot, mounts it **read-only**, and runs the existing engines
   (Trivy for vuln/secret/SBOM; the malware ingest path for a malware engine),
   emitting only normalized, metadata-only findings.
5. **Normalize + ingest**: findings flow through the same normalization the
   agent uses (`db/kubernetes-repository` scanner-evidence, the new
   `lib/kubernetes-malware` model), so agentless and agent findings unify.
6. **Guaranteed teardown**: delete the created volume, the copied snapshot, and
   (if Sutra created it) the source snapshot — mirroring the disposable-EKS
   teardown guard already in `scripts/eks-disposable-guard.mjs`.

## Trust & cost boundary
- The customer role grants only `ec2:CreateSnapshot`, `DescribeVolumes`,
  `DescribeInstances`, `CopySnapshot`, `ModifySnapshotAttribute` scoped by tag;
  **no** file data ever transits the web control plane.
- Snapshots and volumes are Sutra-KMS-encrypted; the scanner account cannot
  reach the control plane's data stores.
- Cost is bounded by TTL'd snapshots + spot/Fargate workers; a dry-run
  `plan` mode (mirroring `kubernetes-security-stack.mjs plan`) must show every
  snapshot/volume that would be created and deleted before any mutation.

## What would be built (ordered)
1. `lib/aws-agentless-scan-plan.ts` — a **pure planner**: given discovered
   volumes + policy, produce a deterministic scan plan (snapshot → copy → scan →
   teardown steps) with cost/TTL annotations. Fully fixture-testable, no AWS.
2. A disposable scanner worker (container) reusing Trivy + the malware ingest.
3. An orchestration runner with a `plan`/`apply` split and a teardown guard.
4. Wire normalized findings into the existing scanner-evidence store + UI.

**Fixture-testable now:** step 1 (the planner) — could be built without AWS.
**Needs AWS (authorize + cost):** steps 2–4 and any real snapshot/scan.

## Built so far (code, no AWS, tested)
- `postgres/migrations/0059_agentless_scans.sql` + `drizzle/0065_…` — run ledger,
  metadata-only findings, and outstanding-resource rows covering BOTH Sutra's own
  failed teardowns and customer-side cleanup handoffs.
- `db/agentless-scan-repository.ts` — tenant-scoped persistence (`org_id` AND
  `customer_id` on every read; a run id is not a capability), terminal states that
  cannot be re-opened, findings capped and the cap reflected in the stored count.
- `services/agentless-scanner/` — its own package, because
  `tests/collector-permission-coverage` proves every `aws-collector` command is
  read-only and `CreateSnapshot` would break that. Contains
  `Ec2AgentlessExecutor`: all six executor methods, tag-at-creation (required by
  the `aws:RequestTag` grant), share→copy→revoke, bounded snapshot-ready polling,
  and no method capable of deleting a customer snapshot. 10 unit tests.
- `infrastructure/customer-role.yaml` — opt-in `EnableAgentlessSnapshotScanning`
  (default `false`), tag-conditioned grants, the explicit no-delete deny, the
  customer-owned DLM cleanup policy, and an `AccessMode` output that reports
  `READ_PLUS_OWN_SNAPSHOTS` instead of falsely claiming `READ_ONLY`.
- `lib/aws-agentless-discovery.ts` — `normalizeDescribedVolumes` (EC2
  DescribeVolumes → `AgentlessVolume[]`, region from AZ).
- `lib/aws-agentless-scan-plan.ts` — `buildAgentlessScanPlan` (deterministic
  snapshot→copy→scan→teardown plan, honest skip reasons, guaranteed teardown,
  concurrency waves, TTL clamps).
- `lib/aws-agentless-scan-runner.ts` — `executeAgentlessScan(plan, executor)`:
  the orchestration engine over an injected `AgentlessExecutor`, with teardown
  guaranteed even when a scan throws. Fully unit-tested with a fake executor
  (`tests/aws-agentless-scan.test.ts`), including the teardown-on-failure and
  teardown-failure-recorded cases.
- `scripts/agentless-scan.mjs` — CLI: offline `plan`; `apply` hard-refused
  unless `--execute --i-accept-aws-cost` AND the real executor is wired.

## The AWS executor (the one AWS-authorization-gated piece)
`AgentlessExecutor` (in the runner) is the exact contract to implement against a
live account — as a **new AWS-SDK service** (the existing `services/aws-collector`
uses `rootDir: "."` and cannot import the root-lib interface, so this is its own
module). Method → AWS SDK mapping:

| Interface method | AWS SDK call |
|---|---|
| `createSnapshot` | EC2 `CreateSnapshotCommand` (+ `CreateTagsCommand` sutra-agentless + TTL) |
| `copySnapshotKms` | EC2 `CopySnapshotCommand` with `Encrypted: true`, `KmsKeyId` = Sutra scan-account key |
| `createScanVolume` | EC2 `CreateVolumeCommand` from the snapshot in the scan AZ (read-only mount by the worker) |
| `runScan` | attach to a disposable scanner (EC2/Fargate), mount read-only, run Trivy + the malware ingest; map to `AgentlessScanFinding[]` — **needs a worker instance, not just an SDK call** |
| `deleteVolume` | EC2 `DeleteVolumeCommand` |
| `deleteSnapshot` | EC2 `DeleteSnapshotCommand` (copied + source) |

Role assumption reuses `services/aws-collector` `AwsRoleBroker` (STS AssumeRole +
ExternalId). A TTL sweeper reconciles any `teardownFailures` the runner reports.
This module is deliberately built + tested **on AWS, service by service**, so
its SDK calls are validated against real responses rather than guessed.
