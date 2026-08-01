# ADD-08 — Sustainability Proxy Metrics and Carbon Emissions

Status: **PARTIAL_PIPELINE (runtime not registered or deployed)**. The fail-closed
engine now has a server-owned dual-source boundary, deterministic daily
scheduler identity, signed materializer response verification, canonical
immutable evidence archive, sealed tenant-bound reference, accepted-attempt
replay, immutable accepted head, authenticated tenant API, filtered trend
projection, and native UI. It is still not a deployed provider pipeline.

## Non-negotiable separation

| Channel | Source and unit | Allowed interpretation |
|---|---|---|
| Resource-use proxies | Active immutable CUR2 quantities: vCPU-hours, memory/storage GB-hours, Lambda GB-seconds, storage requests, data-transfer GB, database vCPU-hours | Technical resource-use and efficiency indicators only |
| Provider carbon | AWS Sustainability `CARBON_EMISSIONS` Data Export in micro-MTCO2e, retaining LBM/MBM, Scope 1/2/3, model, period, account, Region/location and product | AWS provider estimate only |

Proxy values are never converted to carbon. Carbon is never allocated to CUR2
workload tags, resources, or services absent from the provider export. LBM and
MBM are not added together, and totals are not added to scopes.

## Official scope coverage

The complete embedded QuickSight definition was audited 2026-08-01 at pinned
CID framework commit
[`f9e36d88c47709f10e8fa784ad11d5cc0e728021`](https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/blob/f9e36d88c47709f10e8fa784ad11d5cc0e728021/dashboards/sustainability-proxy-metrics/sustainability-proxy-metrics.yaml).
The artifact SHA-256 is
`dff730465da14a7278dfa722340026265d5a16ec0a824fb310cbd6c89004e269`.
It contains exactly **6 sheets, 25 visuals, and 17 controls**: Regional
Footprint (3/0), Compute Proxies (5/4), Storage Proxies (4/4), Data Transfer /
Networking Proxies (4/4), Carbon Emissions (7/5), and About (2/0).

| Capability | Local implementation | Honest gap |
|---|---|---|
| Regional Footprint | Region-filtered resource proxy evidence | Renewable-energy classification and map coordinates are absent from v1 and are not inferred |
| Compute proxies | Exact normalized vCPU/resource monthly series with account, Region, service, metric and workload-tag filters | Processor architecture, EC2 instance family and official business-KPI denominator controls require a versioned schema |
| Storage proxies | Exact normalized storage monthly series | EBS volume type and S3 storage class require a versioned schema |
| Data-transfer/networking proxies | Exact normalized data-transfer monthly series | Transfer-path type and idle NAT Gateway/ELB resource evidence require a versioned schema |
| Provider carbon export | Complete 23-column schema, objects/periods/model/publication lineage and separate monthly trends | Version-pinned export and S3 adapter not deployed |
| Trends | Independent exact proxy and provider-carbon trends | No mathematical combination or correlation claim |
| Targets/workload-tag goals | Workload-tag goal inventory and explicit `NOT_CONFIGURED` states | Durable server-owned target configuration/write workflow remains open |
| Technical resource plans | Metric-specific technical review actions with latest/prior direction | Each plan is explicitly not a carbon-reduction claim |
| Provenance/states | Channel freshness, generation hashes, history, filters, configuration/waiting/empty/partial/stale/current states | Live customer acceptance remains open |

## Assets

- Engine: `lib/finops-sustainability-carbon.ts`
- Projection: `lib/finops-sustainability-dashboard.ts`
- Pinned official inventory: `lib/finops-sustainability-official-definition.ts`
- Materialization contract: `lib/finops-sustainability-carbon-job.ts`
- Permanent runtime boundary: `lib/finops-sustainability-carbon-runtime-binding.ts`
- Repository: `db/finops-sustainability-carbon-repository.ts`
- SQLite 0099: `drizzle/0099_finops_sustainability_carbon.sql`
- PostgreSQL 0094: `postgres/migrations/0094_finops_sustainability_carbon.sql`
- API: `app/api/v1/finops/sustainability-carbon/route.ts`
- UI: `app/costs/finops-sustainability-carbon-dashboard.tsx`

The permanent runtime queues only organization/customer/connection identity and
a UTC daily window. On each attempt it resolves authenticated payer scope,
sorted allowed usage accounts, an active reconciled CUR2 generation plus its
source evidence, manifest, data-through time and seven-metric classification
contract, and a separately version-pinned carbon export. The carbon boundary
includes export name/ARN/Region, bucket, exact slash-terminated prefix, expected
bucket owner, generation, manifest, all 23 columns, publication kind/time and
expected periods. Nothing in the durable payload can choose either source.

The signed request pins read-only current/versioned S3 actions, exact-prefix and
expected-owner enforcement, object/row exhaustion evidence, byte/row/object/
account/period/time limits, and two machine-readable prohibitions: proxies may
not be converted to MTCO2e and provider carbon may not be allocated to CUR2
resources or workload tags. It rejects scope, account, CUR2 generation or
manifest, carbon export/bucket/prefix/generation/manifest/schema/period, request
hash, capture hash, signature, archive hash or sealed-reference substitution.

The exact boundary, request, verified capture and separation policy are
canonically archived as `finops_source_snapshot`. A deterministic `fss_`
generation is sealed with organization/customer/connection/source/generation
context before the normalized `scg_` snapshot is committed. Accepted retries
are verified and replayed without another provider read, archive or commit.
Raw provider messages are reduced to stable failure codes.

Snapshots are content-addressed and rebound to tenant, connection, payer,
partition, capture, state, both channel states, completion time, and row counts.
Only complete `current` or complete `empty` snapshots may advance a monotonically
newer head. Proxy and carbon completeness/freshness are evaluated independently:
an incomplete or stale channel cannot borrow freshness from the other. Partial,
stale, waiting, and configuration-required generations remain immutable history.

The API derives tenant scope from the authenticated organization, resolves the
active trust-role connection, and enforces `connection:read` for its customer.
No tenant identifier can be supplied. Filter values are bounded and apply only
to persisted same-tenant rows. Every successful API envelope, including the
configuration-required response with no accepted snapshot, returns the same
frozen official definition. The browser validates its schema, commit, artifact
hash, counts, and sheet inventory before accepting provider-backed envelopes,
and renders the pinned source audit independently of report availability in
disconnected, loading, configuration-required, and failed states.

## Activation gaps

1. Register the daily job/handler and replace the API's legacy activation reason
   after the runtime composition exists.
2. Implement and deploy the server boundary loader, signed materializer adapter,
   immutable evidence archive/sealer and transactional handoff ports.
3. Deploy the active-CUR2 resource-proxy classifier with governed multiplier
   metadata snapshots and reconciliation evidence.
4. Provision and bind a version-pinned 23-column `CARBON_EMISSIONS` export with
   exact-prefix S3 permissions and expected-owner enforcement.
5. Add durable, authorized target configuration and audit history.
6. Validate monthly/backfill/correction/empty/model-change/account-churn cases,
   proxy freshness, carbon freshness, and cross-tenant attacks live.

Until those pass, the current API continues to report
`SUSTAINABILITY_CUR2_CARBON_MATERIALIZER_NOT_DEPLOYED`. The isolated binding
also returns `SUSTAINABILITY_SERVER_DUAL_SOURCE_BOUNDARY_NOT_CONFIGURED` or
`SUSTAINABILITY_SIGNED_MATERIALIZER_ADAPTER_NOT_DEPLOYED` explicitly. Its
`registeredInSharedRuntime` marker remains `false`; this evidence does not claim
provider acceptance, live data, production registration or deployment.

## Local verification

- Engine/repository/UI vertical tests cover channel separation, schema and
  permission pins, exact normalization, missing totals, tenant/account/model/
  unit failures, empty/partial/stale states, immutable heads, both successful
  API audit surfaces, native UI, and report-independent official evidence.
- Runtime tests cover identity-only queue payloads, dual-plane lineage and
  policy pins, signed archive evidence, deterministic replay, unavailable
  states, partial-carbon non-activation, boundary/signature/CUR2/carbon/archive
  substitution, and provider-error redaction.
