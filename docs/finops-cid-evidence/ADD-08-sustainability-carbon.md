# ADD-08 — Sustainability Proxy Metrics and Carbon Emissions

Status: **IMPLEMENTED_AWAITING_SHARED_REGISTRATION_AND_LIVE_ACCEPTANCE**. The
unique vertical now includes the credential-owning export adapter, strict signed
route, deterministic daily composition, durable accepted-attempt replay,
redacted immutable failure audit, separated comparator, governed target version
ledger/write route, versioned official dimensions, authenticated API, and native
UI. Shared runtime/IAM registration and customer-account acceptance remain
integration/deployment work and are not claimed here.

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
| Regional Footprint | Versioned coordinate and renewable-class evidence with source/version per value | Explicitly `unavailable` until a pinned regional reference is delivered; never inferred |
| Compute proxies | Exact normalized monthly series plus evidence-gated processor architecture and instance family | Missing product columns remain `unavailable` |
| Storage proxies | Exact normalized storage series plus evidence-gated EBS/S3 class | Missing storage classifier lineage remains `unavailable` |
| Data-transfer/networking proxies | Exact normalized transfer series plus evidence-gated path and idle NAT/ELB dimensions | Missing classifier/query lineage remains `unavailable` |
| Provider carbon export | Complete 23-column schema, objects/periods/model/publication lineage, versioned S3 adapter and separate monthly trends | Shared route/role registration and live export acceptance remain |
| Trends | Independent exact proxy and provider-carbon trends | No mathematical combination or correlation claim |
| Targets/workload-tag goals | Authorized same-origin write route, append-only versions, immutable audit/history, active heads and `COLLECTING`/above/at-or-below evaluation | Live operator acceptance remains |
| Technical resource plans | Metric-specific technical review actions with latest/prior direction | Each plan is explicitly not a carbon-reduction claim |
| Provenance/states | Channel freshness, generation hashes, history, filters, configuration/waiting/empty/partial/stale/current states | Live customer acceptance remains open |

## Assets

- Engine: `lib/finops-sustainability-carbon.ts`
- Projection: `lib/finops-sustainability-dashboard.ts`
- Pinned official inventory: `lib/finops-sustainability-official-definition.ts`
- Materialization contract: `lib/finops-sustainability-carbon-job.ts`
- Permanent runtime boundary: `lib/finops-sustainability-carbon-runtime-binding.ts`
- Production composition: `lib/finops-sustainability-carbon-runtime-composition.ts`
- App-side signed broker: `lib/finops-sustainability-carbon-signed-broker.ts`
- Credential adapter: `services/aws-collector/src/sustainability-carbon-provider-adapter.ts`
- Strict signed route: `services/aws-collector/src/sustainability-carbon-route.ts`
- Repository: `db/finops-sustainability-carbon-repository.ts`
- Durable replay/failure repository: `db/finops-sustainability-runtime-repository.ts`
- Target version repository: `db/finops-sustainability-target-repository.ts`
- SQLite 0099: `drizzle/0099_finops_sustainability_carbon.sql`
- PostgreSQL 0094: `postgres/migrations/0094_finops_sustainability_carbon.sql`
- SQLite 0126 / PostgreSQL 0122: governed targets and durable runtime attempts
- API: `app/api/v1/finops/sustainability-carbon/route.ts`
- Target API: `app/api/v1/finops/sustainability-carbon/targets/route.ts`
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

## Remaining integration/deployment gates

1. Register the unique daily handler and strict route in shared collector/runtime
   registries and advance the shared onboarding/role-broker permission pack.
2. Bind the production boundary loader, archive/sealer, exact-prefix S3 reader,
   optional KMS decrypt, and the active reconciled CUR2 classifier.
3. Provision the customer `CARBON_EMISSIONS` export and validate monthly,
   backfill, correction, empty, model-change, account-churn and cross-tenant
   cases against live AWS evidence.

Until shared registration passes, the API reports `runtimeState=unavailable`
with `SUSTAINABILITY_CUR2_CARBON_MATERIALIZER_NOT_REGISTERED`. This evidence
does not claim provider acceptance, production registration or deployment.

## Local verification

- Engine/repository/UI vertical tests cover channel separation, schema and
  permission pins, exact normalization, missing totals, tenant/account/model/
  unit failures, empty/partial/stale states, immutable heads, both successful
  API audit surfaces, native UI, and report-independent official evidence.
- Runtime tests cover identity-only queue payloads, dual-plane lineage and
  policy pins, signed archive evidence, deterministic replay, unavailable
  states, partial-carbon non-activation, boundary/signature/CUR2/carbon/archive
  substitution, and provider-error redaction.
- Closure tests cover versioned dimension lineage, unavailable values, governed
  target evaluation, immutable target/runtime migrations and authorized writes.
- Collector tests cover export/comparator separation, prefix substitution,
  comparator exhaustion, read-only action pins and bounded credential-side data.

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
  (PR #37).** This row's own view module was not modified; it was already on
  the native chart kit before these merges. What reached it is shared:
  `app/costs/finops-foundational-panels.tsx` and
  `app/costs/finops-cur-intelligence-panels.tsx` stopped drawing an absent
  series as a floored zero (`tests/finops-shared-panel-floors.test.mjs`), which
  preserves the absent-is-not-zero release invariant in the panels this row
  renders. Across `app/costs/`, 28 view modules plus the catalog page now import the kit,
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
