# ADD-06 — Kubecost Containers Cost Allocation

Status: **PARTIAL_PIPELINE (local vertical)**. The pure Kubecost/OpenCost engine
is now backed by a permanent six-hour scheduler/handler contract, strict
exact-byte Ed25519 broker transport, version-pinned export acceptance,
immutable attempt and accepted-head persistence, authenticated same-tenant API,
and native UI. No exporter adapter or customer evidence is deployed by this
change.

## Official scope coverage

Official AWS guidance and the authoritative `awslabs/containers-cost-allocation-dashboard`
repository were rechecked 2026-08-01. The source is pinned at commit
[`8a581332a70ae55d53464e52a0bb8b3dd64cb425`](https://github.com/awslabs/containers-cost-allocation-dashboard/tree/8a581332a70ae55d53464e52a0bb8b3dd64cb425),
whose CID asset `cid/containers_cost_allocation.yaml` has SHA-256
`2bde67113c8f585d13fc43fe537c3bee3eecf3a416b81cd0f57295226b4ed45b`.
AWS documents exactly three dashboard tabs: **Executive Summary**, **Workloads
Explorer**, and **EKS Breakdown**. The official repository explicitly supports
self-hosted Kubecost and explicitly does not support OpenCost. Sutra retains
OpenCost as a supplemental, clearly labeled source; it is not counted as
official parity.

| Official area | Implemented locally | Honest remaining gap |
|---|---|---|
| Self-hosted Kubecost, any tier | `KUBECOST` versioned S3 export contract; supplemental `OPENCOST` is disclosed separately | Customer exporter and signed ingest adapter are not deployed |
| Container/pod/namespace/controller allocation | Full account → cluster → namespace → controller → workload → pod → container lineage with special allocations preserved | None for accepted source rows; null lineage stays unallocated |
| Executive Summary | Exact total and CPU/RAM/GPU/network/PV/load-balancer/shared/external component cost by currency, CPU/RAM usage-vs-request efficiency, cost by account, and top clusters | None for accepted component-cost evidence |
| Workloads Explorer | Tenant-bounded filters, exact rows, namespace/controller/workload pivots, allocation categories, pagination, efficiency, and filtered hourly allocated-cost trend | Exact QuickSight geometry remains a browser/live gate |
| EKS Breakdown | Cluster distribution, coverage, group counts, and workload drilldown | Capacity type and instance type are absent from the export schema and are not inferred |
| Showback/chargeback | Reconciled namespace showback and usage-vs-request evidence | Read-only dashboard creates no invoices, journals, transfers, or chargeback posting |

## End-to-end assets

- Acceptance engine: `lib/finops-kubecost-allocation.ts`
- Dashboard projection: `lib/finops-kubecost-dashboard.ts`
- Materialization job: `lib/finops-kubecost-allocation-job.ts`
- Permanent runtime binding: `lib/finops-kubecost-runtime-binding.ts`
- Signed export broker: `lib/finops-kubecost-signed-export-broker.ts`
- Repository: `db/finops-kubecost-allocation-repository.ts`
- Runtime-attempt repository: `db/finops-kubecost-runtime-attempt-repository.ts`
- SQLite 0097: `drizzle/0097_finops_kubecost_allocation.sql`
- SQLite runtime attempts 0111: `drizzle/0111_finops_kubecost_runtime_attempts.sql`
- PostgreSQL 0092: `postgres/migrations/0092_finops_kubecost_allocation.sql`
- PostgreSQL runtime attempts 0106: `postgres/migrations/0106_finops_kubecost_runtime_attempts.sql`
- API: `app/api/v1/finops/kubecost-allocation/route.ts`
- Native UI: `app/costs/finops-kubecost-allocation-dashboard.tsx`
- Focused runtime proof: `tests/finops-kubecost-runtime-binding.test.mjs`

The durable job payload contains only its server-owned scheduled window. At
execution time the handler reloads and validates the exact tenant, account,
cluster, billing period, destination, expected bucket owner, optional CMK and
active reconciled CUR2 evidence. Only attempts 1–5 with `maxAttempts=5` are
accepted, and the enqueue idempotency identity includes encoded organization,
customer, connection and window values. The reloaded scope, destination and
CUR2 evidence are deep-cloned and frozen, including every array and currency
total, before hashing or broker invocation. The request pins the read-only
current and versioned S3 actions, conditional KMS decrypt action, query contract, bounds,
and five-minute broker deadline. Exporter write permission is an explicit empty
list. The deterministic request ID and immutable attempt ledger make a replay
return the prior result without calling the broker or republishing a capture.

The broker origin must be a credential-free HTTPS origin. Requests and exact
response bytes are Ed25519 authenticated with nonce binding and bounded while
streaming. Response request ID/body hash, broker key ID, destination, full
scope, and active CUR2 digest must match before persistence. Provider details
are reduced to a finite sanitized error vocabulary.

A capture that otherwise qualifies for complete `READY` or `EMPTY` publication
is rejected unless every S3 object has a non-null version ID. An ETag and object
hash do not make a mutable current-key read immutable. The collector may still
retain incomplete current-key evidence as non-complete history, but it cannot
publish it as the accepted head through this permanent runtime.

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

1. Register the durable job handler and six-hour scheduler in the shared worker
   runtime. Until then activation reason is
   `KUBECOST_SIGNED_VERSIONED_EXPORT_RUNTIME_NOT_REGISTERED`.
2. Provision the managed HTTPS broker origin, client signing key, broker
   verification key, nonce/replay store, and secret rotation process.
3. Deploy its credential-owning read adapter for the exact tenant prefix and
   keep the exporter writer on a separate identity.
4. Bind it to an active reconciled CUR2 generation and validate S3 bucket-owner,
   prefix, object-versioning, Object Lock/lifecycle where applicable, KMS and IAM
   restrictions with real objects.
5. Version the accepted schema for EKS node capacity and instance-type
   dimensions; current evidence does not carry them and they are not inferred.
6. Run live multi-account/cluster acceptance across complete, empty, mismatch,
   partial, stale, waiting, error, and cross-tenant attacks.
7. Run the exact-tree G7 gate, controlled provider/two-tenant G8 acceptance,
   reviewed GitHub/release G9 gate, and deployed-digest/rollback G10 acceptance.

Until those gates pass, the API returns
`KUBECOST_SIGNED_VERSIONED_EXPORT_RUNTIME_NOT_REGISTERED` and this vertical is
not locally verified or live.
