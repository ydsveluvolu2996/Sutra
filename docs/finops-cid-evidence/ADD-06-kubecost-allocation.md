# ADD-06 — Kubecost Containers Cost Allocation

Status: **PARTIAL_PIPELINE (local vertical)**. The pure Kubecost/OpenCost engine
is now backed by a signed versioned-export materialization contract, immutable
accepted-head persistence, authenticated same-tenant API, and native UI. No
exporter adapter or customer evidence is deployed by this change.

## Official scope coverage

| Official area | Implemented locally | Honest remaining gap |
|---|---|---|
| Self-hosted Kubecost, any tier | Provider-neutral `KUBECOST`/`OPENCOST` versioned S3 export contract | Customer exporter and signed ingest adapter are not deployed |
| Container/pod/namespace/controller allocation | Full account → cluster → namespace → controller → workload → pod → container lineage with special allocations preserved | None for accepted source rows; null lineage stays unallocated |
| Executive Summary | Exact total allocated cost by currency, CPU/RAM usage-vs-request efficiency, cost by account, and top clusters | Normalized groups do not retain CPU/RAM component cost, so those component KPIs are explicitly unavailable |
| Workloads Explorer | Tenant-bounded filters, exact rows, namespace/controller/workload pivots, allocation categories, pagination, and efficiency | Per-hour trend facts are not retained after snapshot grouping |
| EKS Breakdown | Cluster distribution, coverage, group counts, and workload drilldown | Capacity type and instance type are absent from the export schema and are not inferred |
| Showback/chargeback | Reconciled namespace showback and usage-vs-request evidence | Read-only dashboard creates no invoices, journals, transfers, or chargeback posting |

## End-to-end assets

- Acceptance engine: `lib/finops-kubecost-allocation.ts`
- Dashboard projection: `lib/finops-kubecost-dashboard.ts`
- Materialization job: `lib/finops-kubecost-allocation-job.ts`
- Repository: `db/finops-kubecost-allocation-repository.ts`
- SQLite 0097: `drizzle/0097_finops_kubecost_allocation.sql`
- PostgreSQL 0092: `postgres/migrations/0092_finops_kubecost_allocation.sql`
- API: `app/api/v1/finops/kubecost-allocation/route.ts`
- Native UI: `app/costs/finops-kubecost-allocation-dashboard.tsx`

The job pins the tenant scope, exact bucket/prefix and expected bucket owner,
read-only current/versioned S3 actions, conditional KMS decrypt action, query
contract, bounds, active CUR2 generation, and 30-minute deadline. Exporter
write permission is never included. Returned destination and full account,
cluster, billing-period, CUR2-generation scope must exactly match the request.

Snapshots are content-addressed and rebound to tenant, connection, partition,
billing period, active CUR2 generation, capture, state, data-through time, row
count, and group count on every read. Only complete `READY` or `EMPTY` evidence
can advance the head, and only when its data-through time is newer. Other
states remain immutable history.

The API resolves the connection under the authenticated organization and
checks `connection:read` for its customer. Organization/customer IDs cannot be
supplied by the client. Filters are bounded and apply only to groups already
inside the persisted server scope.

## Reconciliation and presentation

CUR2 remains authoritative spend. Kubecost/OpenCost is an attribution view and
the presentation policy is `ATTRIBUTION_VIEW_ONLY_DO_NOT_ADD_TO_CUR2`.
Currencies never combine. All money, efficiency, aggregation, and sorting uses
exact rational/BigInt math. Missing request/usage evidence stays unavailable;
special idle/shared/external/unallocated/unmounted costs are not redistributed.

## Activation gates open

1. Register SQLite 0097, PostgreSQL 0092, and the deploy migrator entry.
2. Wire the dashboard component and catalog maturity.
3. Deploy a signed exporter/ingest adapter for the exact tenant prefix.
4. Bind it to an active reconciled CUR2 generation and schedule materialization.
5. Extend the normalized snapshot with retained hourly facts for trend views,
   CPU/RAM component cost, and EKS capacity/instance-type dimensions.
6. Prove bucket-owner/prefix/version/KMS restrictions and writer separation.
7. Run live multi-account/cluster acceptance across complete, empty, mismatch,
   partial, stale, waiting, error, and cross-tenant attacks.

Until those gates pass, the API returns
`KUBECOST_EXPORTER_INGEST_ADAPTER_NOT_DEPLOYED` and this vertical is not locally
verified or live.
