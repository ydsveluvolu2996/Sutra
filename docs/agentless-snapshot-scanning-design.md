# Agentless snapshot scanning — design

**Status:** design only. Not implemented. This closes the *design* gap for the
"agentless snapshot scanning" benchmark row; execution needs AWS infrastructure
and is deliberately out of scope until explicitly authorized (it incurs cost).

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
