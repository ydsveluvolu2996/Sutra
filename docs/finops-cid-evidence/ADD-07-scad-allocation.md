# ADD-07 — SCAD Containers Cost Allocation

Status: `PARTIAL_PIPELINE` (local vertical complete; provider activation not claimed)

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
- Repository: `db/finops-scad-allocation-repository.ts`
- SQLite/PostgreSQL: `drizzle/0098_finops_scad_allocation.sql`, `postgres/migrations/0093_finops_scad_allocation.sql`
- API/UI: `app/api/v1/finops/scad-allocation/route.ts`, `app/costs/finops-scad-allocation-dashboard.tsx`
- Tests: `tests/finops-scad-allocation.test.ts`, `tests/finops-scad-allocation-vertical.test.mjs`

## Controls

- Session organization/customer boundaries are server-derived; the API accepts no tenant selector.
- Only an active AWS trust-role connection with `connection:read` can read accepted heads.
- The scheduled job payload contains only a server window. Tenant scope, export ARN, bucket/prefix, required columns, S3 read actions and bounds are server-owned.
- Snapshot JSON is content-addressed. Updates/deletes are rejected, and only a complete newer same-period generation can advance a head.
- Partial deliveries and failed corrections remain immutable history and cannot displace complete evidence.
- Exact rational arithmetic avoids float drift; currencies remain separate.
- CSV neutralizes spreadsheet formula prefixes.

## Honest live gaps

1. Register the permanent S3/CUR2 materializer and durable job handler.
2. Prove AWS export/object pagination, corrected manifests, throttling, versioned-object handling and failure recovery with real SCAD exports.
3. Apply both migrations through the release path and complete PostgreSQL parity evidence.
4. Add a governed non-SCAD CUR2 resource join before claiming full tagged infrastructure TCO.
5. Complete signed-in visual, negative tenant-isolation, multi-account EKS/ECS/Batch reconciliation and live post-deploy smoke evidence.

Until those gates pass, catalog maturity must remain `PARTIAL_PIPELINE`; the route reports `SCAD_CUR2_MATERIALIZER_JOB_HANDLER_NOT_REGISTERED`, and production activation remains false.
