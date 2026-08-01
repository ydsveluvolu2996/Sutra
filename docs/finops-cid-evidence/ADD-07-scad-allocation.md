# ADD-07 — SCAD Containers Cost Allocation

Status: `PARTIAL_PIPELINE`; runtime activation is not claimed.

Reviewed 2026-08-02 against the official AWS
[SCAD Containers Cost Allocation Dashboard](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/scad-containers-dashboard.html),
[SCAD prerequisites](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/scad-containers-dashboard-prerequisites.html),
[SCAD concepts](https://docs.aws.amazon.com/cur/latest/userguide/split-cost-allocation-data.html),
[SCAD enablement](https://docs.aws.amazon.com/cur/latest/userguide/enabling-split-cost-allocation-data.html),
and [CUR 2.0 Data Exports](https://docs.aws.amazon.com/cur/latest/userguide/what-is-data-exports.html).
AWS documents EKS/ECS pod/task allocation, the executive and workload lenses,
resource-request versus actual-utilization modes, a new CUR2 export, 24–48 hour
delivery latency, and no historical backfill. Sutra preserves those boundaries.

| Official lens | Sutra evidence-backed implementation | Boundary |
|---|---|---|
| EKS/ECS/AWS Batch pod/task allocation | Exact CUR2 SCAD lineage through account, Region, platform, cluster, namespace, workload and pod/task | AWS SCAD does not publish container IDs |
| Executive CPU/GPU/RAM/shared/total KPIs | Exact rational allocated, AWS-attributed unused and total cost by currency; VCPU, MEMORY and accelerator families | “Shared/idle” is AWS-attributed unused cost, not all platform overhead |
| Account and top-cluster views | Account and cluster ranked allocations with pod/task and metric-group counts | No cross-currency merging |
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
- Materializer contract: `lib/finops-scad-materialization-job.ts`
- CUR2 runtime adapter: `lib/finops-scad-cur2-runtime-adapter.ts`
- Durable runtime binding: `lib/finops-scad-durable-runtime-binding.ts`
- Repository: `db/finops-scad-allocation-repository.ts`
- SQLite/PostgreSQL: `drizzle/0098_finops_scad_allocation.sql`, `postgres/migrations/0093_finops_scad_allocation.sql`
- API/UI: `app/api/v1/finops/scad-allocation/route.ts`, `app/costs/finops-scad-allocation-dashboard.tsx`
- Tests: `tests/finops-scad-allocation.test.ts`, `tests/finops-scad-allocation-vertical.test.mjs`, `tests/finops-scad-cur2-runtime-activation.test.ts`

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

Focused verification: **28/28 tests passed** across the allocation, vertical and
activation suites, including eight new runtime tests. TypeScript and targeted
ESLint pass on the current tree.

Until those gates pass, catalog maturity must remain `PARTIAL_PIPELINE`; the route reports `SCAD_CUR2_MATERIALIZER_JOB_HANDLER_NOT_REGISTERED`, and production activation remains false.
