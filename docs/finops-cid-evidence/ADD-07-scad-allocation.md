# ADD-07 — SCAD Containers Cost Allocation

Status: `PARTIAL_PIPELINE`; runtime activation is not claimed.

Reviewed 2026-08-01 against the official AWS
[SCAD Containers Cost Allocation Dashboard](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/scad-containers-dashboard.html),
[SCAD prerequisites](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/scad-containers-dashboard-prerequisites.html),
[SCAD concepts](https://docs.aws.amazon.com/cur/latest/userguide/split-cost-allocation-data.html),
[SCAD enablement](https://docs.aws.amazon.com/cur/latest/userguide/enabling-split-cost-allocation-data.html),
and [CUR 2.0 Data Exports](https://docs.aws.amazon.com/cur/latest/userguide/what-is-data-exports.html).
AWS documents EKS/ECS pod/task allocation, the executive and workload lenses,
resource-request versus actual-utilization modes, a new CUR2 export, 24–48 hour
delivery latency, and no historical backfill. Sutra preserves those boundaries.

## Immutable official-definition audit

The framework manifest is pinned at commit
`f9e36d88c47709f10e8fa784ad11d5cc0e728021`, path
`dashboards/scad-containers-cost-allocation/scad-containers-cost-allocation.yaml`,
SHA-256 `0b27190fecbb87988b3f06ec122f3a2ffc7636b25f8008b3117367ad8302c2d4`.
It identifies the dashboard/template and two SCAD datasets, but does not embed
the QuickSight analysis definition. Exact controls, visual-object counts,
placement and pixel geometry are therefore undisclosed and are not fabricated.

AWS guidance says “three tabs” and then names five sections: Executive Summary,
Workloads Explorer, Cluster Breakdown, Labels/Tags Explorer and Data on EKS.
Sutra records the three-tab claim and five-section inventory separately. The
first three sections are supported from SCAD evidence; tagged non-SCAD resource
TCO and EMR service cost remain partial until a governed CUR2 join exists.

Both successful API states expose the same frozen audit. The browser validates
the pinned commit, manifest hash, three-tab claim and five-section inventory,
and keeps that audit visible in disconnected, loading,
configuration-required, failed, and report-bearing states. Source coverage is
not treated as an accepted SCAD export or allocation result.

| Official lens | Sutra evidence-backed implementation | Boundary |
|---|---|---|
| EKS/ECS/AWS Batch pod/task allocation | Exact CUR2 SCAD lineage through account, Region, platform, cluster, namespace, workload and pod/task | AWS SCAD does not publish container IDs |
| Executive CPU/GPU/RAM/shared/total KPIs | Exact rational allocated, AWS-attributed unused and total cost by currency; VCPU, MEMORY and accelerator families | “Shared/idle” is AWS-attributed unused cost, not all platform overhead |
| Account and top-cluster views | Account and cluster cost-ranked allocations within one currency, with pod/task and metric-group counts | No cross-currency ranking or merging |
| Workloads Explorer | Bounded filters and drilldown across EKS, ECS, Batch EKS/Batch ECS, usage and costs | Actual usage stays unavailable in request-only mode |
| Cluster coverage | Account/Region/platform cluster cards with namespace, workload, pod/task and missing-lineage counts | Lineage completeness is explicit |
| Labels/tags explorer | Exact sorted CUR2 resource-tag dimensions retained in normalized lineage | Only tags present on SCAD rows |
| TCO with tagged AWS resources | `SCAD_TAGGED_POD_TASK_COST_ONLY` view | EC2/EBS/LB and other resource TCO needs a separate governed CUR2 join |
| Spark/Flink/EMR-on-EKS | Explicit `SUTRA_NAME_OR_TAG_INFERENCE` grouping | Not an AWS workload classification |
| Showback/chargeback | Account, cluster, namespace, workload or selected-tag allocation using CUR2 attributed amortized cost | Policy basis is visible; no invented redistribution |
| Reconciliation and lineage | Per-period source total vs projected groups, exact difference, immutable CUR2 generation/hash/object coverage | Complete newer corrections replace a period atomically |

## Files

- Engine: `lib/finops-scad-allocation.ts`
- Projection: `lib/finops-scad-dashboard.ts`
- Official definition: `lib/finops-scad-official-definition.ts`
- Materializer contract: `lib/finops-scad-materialization-job.ts`
- CUR2 runtime adapter: `lib/finops-scad-cur2-runtime-adapter.ts`
- Durable runtime binding: `lib/finops-scad-durable-runtime-binding.ts`
- Repository: `db/finops-scad-allocation-repository.ts`
- SQLite/PostgreSQL: `drizzle/0098_finops_scad_allocation.sql`, `postgres/migrations/0093_finops_scad_allocation.sql`
- API/UI: `app/api/v1/finops/scad-allocation/route.ts`, `app/costs/finops-scad-allocation-dashboard.tsx`
- Tests: `tests/finops-scad-allocation.test.ts`, `tests/finops-scad-allocation-vertical.test.mjs`, `tests/finops-scad-cur2-runtime-activation.test.ts`, `tests/finops-scad-official-definition.test.ts`

## Controls

- Session organization/customer boundaries are server-derived; the API accepts no tenant selector.
- Only an active AWS trust-role connection with `connection:read` can read accepted heads.
- The scheduled job payload contains only a server window. Tenant scope, export ARN, bucket/prefix, required columns, S3 read actions and bounds are server-owned.
- The production-facing adapter accepts only an exact, deep-frozen
  `SERVER_RESOLVED_SCAD_CUR2_EXPORT` boundary. It revalidates manifest scope,
  derives the generation from the manifest SHA-256, pins every versioned
  object, rejects extra boundary/object/row fields, and never persists
  pagination tokens. Unversioned current-key objects remain partial evidence
  and cannot advance a head.
- Manifest/object/row reads are capped at 25,000 attempted requests, three attempts per request, 20,000 objects, 750,000 rows and 30 minutes. Repeated tokens, cross-prefix objects and changed ETag/version/checksum evidence fail closed.
- Rows from an object are buffered until all of that object's pages are exhausted. A mid-object failure discards those rows and records an honest partial capture; no unverifiable subset can advance a period head.
- Completed daily-job receipts are content-hashed before replay. Concurrent claims return `IN_PROGRESS`; duplicate manifests are acknowledged before object reads.
- Snapshot JSON is content-addressed. Updates/deletes are rejected, and only a complete newer same-period generation can advance a head.
- Partial deliveries and failed corrections remain immutable history and cannot displace complete evidence.
- Exact rational arithmetic avoids float drift; currencies remain separate.
- CSV neutralizes spreadsheet formula prefixes.

## Honest live gaps

1. Bind the exact active Data Export/manifest resolver and a permanent
   least-privilege S3 SDK client or signed broker, including the production
   CSV-gzip/Parquet decoder that maps all SCAD columns without numeric coercion.
2. Bind the durable replay store, register the daily job handler and eligible
   connection tick in the shared runtime.
3. Prove real SCAD export/object pagination, corrected manifests, versioned
   objects, throttling, token expiry, authorization, timeout and recovery.
4. Add a governed non-SCAD CUR2 join for tagged EC2, EBS, load-balancer, EMR and
   other infrastructure cost before claiming the AWS dashboard's full TCO lens.
5. Apply both existing migrations through the release path, then complete live
   multi-account EKS/ECS/Batch request/actual/accelerator reconciliation,
   signed-in two-tenant UI/build, immutable-image deployment and browser smoke.

Focused verification: **31/31 tests passed** across the allocation, vertical and
activation suites, including eight new runtime tests. TypeScript and targeted
ESLint pass on the current tree.

Until those gates pass, catalog maturity must remain `PARTIAL_PIPELINE`; the route reports `SCAD_CUR2_MATERIALIZER_JOB_HANDLER_NOT_REGISTERED`, and production activation remains false.

## Merge record — 2026-08-06

Merged to `main` since this record was last updated (2026-08-05 15:01). Every
item below is source-only work that landed through review with CI green on the
merge commit — nothing more. No provider, live, two-tenant, or release evidence
is created by any of it.

**Maturity is unchanged (`PARTIAL_PIPELINE`) and no child-stage gate passed.** G7
fixed-tree, G8 controlled provider acceptance, G9 release and G10 deployment
remain unpassed for this row; no live acceptance, provider reconciliation, or
two-tenant acceptance is claimed.

- **Native chart kit and catalog identity — `4ac72bd` (PR #36) and `f107cdf`
  (PR #37).** This row's view moved onto the shared native chart kit at
  `app/components/charts`:
  - `app/costs/finops-scad-allocation-dashboard.tsx`

  Focused rendering proof added with it:
  - `tests/finops-final-four-charts.test.mjs`

  Across `app/costs/`, 28 view modules plus the catalog page now import the kit,
  and the kit's own rendering suite `tests/chart-kit-rendering.test.mjs` holds
  12 tests. `app/costs/finops-dashboard-identity.tsx` renders each dashboard's
  catalog glyph, name and ID above every opened view
  (`tests/finops-dashboard-identity.test.mjs`). This is UI rendering work only:
  no source contract, collector operation, migration, API shape, or evidence
  semantic changed, and no G5 or G6 stage status is promoted by it.

- **New `aws_static_credentials` onboarding method — `6298f03` (PR #39).**
  Onboarding now offers an access key ID plus secret access key (with a session
  token required for temporary `ASIA` keys) as an alternative to the
  CloudFormation trust-role flow, which stays the recommended default. The
  credential material lives only in the collector's AES-GCM-encrypted registry
  document; the app database stores the `aws_static_credentials` source kind and
  nothing else. Static sessions carry **no STS inline session-policy ceiling and
  no role-contract attestation** — both are impossible without `AssumeRole`.
  **This row's connection prerequisite is unchanged: the FinOps per-source
  verticals still require the trust-role method.** The FinOps source guards were
  deliberately left trust-role-only, so an `aws_static_credentials` connection
  cannot satisfy the prerequisite recorded above. No permission ceiling,
  attestation, or role contract in this record is relaxed by it.
