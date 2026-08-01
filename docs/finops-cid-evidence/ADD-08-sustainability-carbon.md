# ADD-08 — Sustainability Proxy Metrics and Carbon Emissions

Status: **PARTIAL_PIPELINE (local vertical)**. The existing fail-closed engine
now has a server-owned dual-source materialization contract, immutable accepted
head, authenticated tenant API, filtered trend projection, and native UI. It is
not a deployed provider pipeline.

## Non-negotiable separation

| Channel | Source and unit | Allowed interpretation |
|---|---|---|
| Resource-use proxies | Active immutable CUR2 quantities: vCPU-hours, memory/storage GB-hours, Lambda GB-seconds, storage requests, data-transfer GB, database vCPU-hours | Technical resource-use and efficiency indicators only |
| Provider carbon | AWS Sustainability `CARBON_EMISSIONS` Data Export in micro-MTCO2e, retaining LBM/MBM, Scope 1/2/3, model, period, account, Region/location and product | AWS provider estimate only |

Proxy values are never converted to carbon. Carbon is never allocated to CUR2
workload tags, resources, or services absent from the provider export. LBM and
MBM are not added together, and totals are not added to scopes.

## Official scope coverage

| Capability | Local implementation | Honest gap |
|---|---|---|
| vCPU, storage and data-transfer proxies | Exact normalized monthly series with account, Region, service, metric and workload-tag filters | Depends on deployed CUR2 classifier/materializer |
| Provider carbon export | Complete 23-column schema, objects/periods/model/publication lineage and separate monthly trends | Version-pinned export and S3 adapter not deployed |
| Trends | Independent exact proxy and provider-carbon trends | No mathematical combination or correlation claim |
| Targets/workload-tag goals | Workload-tag goal inventory and explicit `NOT_CONFIGURED` states | Durable server-owned target configuration/write workflow remains open |
| Technical resource plans | Metric-specific technical review actions with latest/prior direction | Each plan is explicitly not a carbon-reduction claim |
| Provenance/states | Channel freshness, generation hashes, history, filters, configuration/waiting/empty/partial/stale/current states | Live customer acceptance remains open |

## Assets

- Engine: `lib/finops-sustainability-carbon.ts`
- Projection: `lib/finops-sustainability-dashboard.ts`
- Materialization contract: `lib/finops-sustainability-carbon-job.ts`
- Repository: `db/finops-sustainability-carbon-repository.ts`
- SQLite 0099: `drizzle/0099_finops_sustainability_carbon.sql`
- PostgreSQL 0094: `postgres/migrations/0094_finops_sustainability_carbon.sql`
- API: `app/api/v1/finops/sustainability-carbon/route.ts`
- UI: `app/costs/finops-sustainability-carbon-dashboard.tsx`

The job pins authenticated payer scope, allowed usage accounts, exact active
CUR2 generation, exact carbon bucket/prefix/expected owner/periods, complete
carbon schema, read-only current/versioned object actions, bounds, and deadline.
It rejects source, account, generation, period, bucket, or prefix substitution.

Snapshots are content-addressed and rebound to tenant, connection, payer,
partition, capture, state, both channel states, completion time, and row counts.
Only complete `current` or complete `empty` snapshots may advance a monotonically
newer head. Partial, stale, waiting, and configuration-required generations
remain immutable history.

The API derives tenant scope from the authenticated organization, resolves the
active trust-role connection, and enforces `connection:read` for its customer.
No tenant identifier can be supplied. Filter values are bounded and apply only
to persisted same-tenant rows.

## Activation gaps

1. Register SQLite 0099, PostgreSQL 0094, and the deploy migrator entry.
2. Wire the component and catalog maturity.
3. Deploy the active-CUR2 proxy classifier/materializer.
4. Provision and bind a version-pinned 23-column `CARBON_EMISSIONS` export with
   exact-prefix S3 permissions and expected-owner enforcement.
5. Add durable, authorized target configuration and audit history.
6. Validate monthly/backfill/correction/empty/model-change/account-churn cases,
   proxy freshness, carbon freshness, and cross-tenant attacks live.

Until those pass, the API reports
`SUSTAINABILITY_CUR2_CARBON_MATERIALIZER_NOT_DEPLOYED`; the vertical is not
locally verified or live.
