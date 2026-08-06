# ADV-10 — ResilienceVue

Status: **NATIVE_FUNCTIONAL_WITH_PROVIDER_GAPS** (local vertical, exact public-definition mapping, and permanent runtime binding contract complete; authenticated AWS adapter registration and deployed provider evidence are not active)

Official AWS Cloud Intelligence Dashboards scope rechecked 2026-08-01 against the pinned AWS CID Framework definition at commit [`f9e36d88c47709f10e8fa784ad11d5cc0e728021`](https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/blob/f9e36d88c47709f10e8fa784ad11d5cc0e728021/dashboards/resilience-vue/resilience-vue-definition.yaml). ResilienceVue uses daily incremental AWS Resilience Hub assessments across AWS Organizations, linked accounts, Regions, and payer views to expose application resilience posture, RTO/RPO objectives and breaches, infrastructure recommendation trends, and outstanding operational recommendations.

## Pinned definition audit

The pinned definition contains exactly four sheets: `Organizational Summary`, `Application Resiliency`, `Recommendations`, and `About`.

| Immutable evidence | Pinned value |
|---|---|
| Repository | `aws-solutions-library-samples/cloud-intelligence-dashboards-framework` |
| Commit | `f9e36d88c47709f10e8fa784ad11d5cc0e728021` |
| Manifest | `dashboards/resilience-vue/resilience-vue.yaml` |
| Manifest SHA-256 | `9478243fd9da03b4be2813993c98bd3f99970865443b9b11d8b0346de54d380c` |
| Definition | `dashboards/resilience-vue/resilience-vue-definition.yaml` |
| Definition SHA-256 | `c0fe7edf8648327ca13a3ad14372ae382b4b9bf42b428aacd0223f8a5575b63b` |
| Dashboard/version/theme | `resiliencevue` / `v1.0.0` / `MIDNIGHT` |

Independent parsing of that definition produced **4 sheets, 47 visuals, 2
parameter controls, 7 filter controls, 4 parameter declarations, 37
calculated fields, 15 filter groups, 7 column configurations, and 9 dataset
declarations**. The visual histogram is 1 Sankey, 4 bar charts, 15 tables, 9
KPIs, 6 pie charts, 10 word clouds, 1 gauge, and 1 line chart.

| Official sheet | Exact visual inventory | Exact control placements | Native evidence / explicit gap |
|---|---:|---|---|
| Organizational Summary | 23: 1 Sankey, 3 bar, 6 table, 8 KPI, 3 pie, 2 word cloud | 4 filters: Last Assessment Time, Region, Management Account, Resiliency Status | Native account/Region, assessment, policy, breach, drift, backlog, and retained trends. Account scope is not an independently verified multi-payer taxonomy; layout parity is not claimed. |
| Application Resiliency | 17: 8 word cloud, 5 table, 1 gauge, 1 KPI, 1 line, 1 bar | 1 Application Name filter | Native application posture, latest ten assessments, score, policy objectives, and current/achievable/target RTO/RPO. Provider collection and exact layout parity remain open. |
| Recommendations | 7: 4 table, 3 pie | 2 parameters: Availability Architecture and Optimization Type; 2 filters: App Component and Application Name | Native configuration/alarm/SOP/FIS evidence, statuses, export, and separated Sutra inference. Estimated cost plus three unavailable dimensions require a versioned schema and provider validation. |
| About | 0 | None | Native immutable source, freshness, generation/hash, capture identity, activation, and limitations. The upstream sheet contains zero visuals. |

The frozen mapping is exposed by every successful API state and remains visible
in the UI when collection is unconfigured. These counts describe upstream
objects; Sutra never claims pixel or QuickSight layout parity.

| Official capability | Sutra local status | Evidence-honest implementation |
|---|---|---|
| Organizational account/Region/status summary, assessed/not-assessed, in-policy/breached, drift and score posture | Implemented locally | Native filters and summary cards are derived only from retained complete target heads. Absence remains an explicit non-resilience state. |
| Last Assessment Time control | Implemented locally | Bounded UTC from/to query controls filter retained assessment `startTime`; invalid or inverted ranges fail closed. |
| Application Resiliency, latest ten assessments and score trend | Implemented locally | Latest-assessment posture, provider status, last-assessed time, count and ten-row score trend are rendered from retained assessment history. |
| Current/achievable/target RPO and RTO by AZ, application/software, infrastructure/hardware and Region | Implemented locally | Dimension drilldown joins the latest assessment objective evidence with the linked resiliency-policy objectives without inventing missing dimensions. |
| Suggested resiliency and operational recommendations | Implemented locally where present in v1 evidence | Open recommendation drilldown and CSV remain available; all retained SOP, alarm and FIS-test statuses now feed separate status panels. |
| Estimated cost, optimization type and availability architecture | Not present in immutable v1 schema | The UI explicitly discloses these fields as unavailable. Adding them requires a versioned capture-schema migration and provider validation; no placeholder values are inferred. |
| About/source provenance | Implemented locally | Evidence generation, content hash, capture ID, freshness, activation state and limitations remain inspectable. |

## Implemented local evidence path

- `lib/finops-resilience-vue.ts` defines and fail-closed normalizes the bounded read-only Resilience Hub capture. It validates scope, ARN account/partition/Region binding, pagination, completeness, timestamps, duplicates, and provider-vs-Sutra inference labels.
- `lib/finops-resilience-vue-job.ts` adds a server-owned daily incremental job/adapter contract. The job payload accepts only a UTC collection window; account/partition/Region targets and incremental cursors are server-resolved. Four workers and the existing 15-minute collection bound constrain execution.
- `lib/finops-resilience-vue-runtime-binding.ts` closes the local permanent scheduler/handler boundary. The daily scheduler enumerates eligible connections from trusted server state and enqueues only `{ scheduledWindow }`; the durable handler reloads the tenant connection and every account/partition/Region target before any provider call. Each target receives a deterministic target/window request identity that remains stable if the incremental cursor advances during queue replay, the exact 14-operation read-only surface, a 100-item page size, 20,000-page ceiling, pagination-token replay rejection, required exhaustion evidence, archive-safe 11 MiB runtime capture ceiling, four-worker limit, and one 15-minute abort window.
- The runtime binding canonicalizes the exact provider request and capture, archives it as `finops_source_snapshot`, derives a content-addressed `fss_...` evidence generation, seals the object reference with tenant/customer/connection/source/generation AAD, and requires the application handoff to durably bind that immutable reference to the normalized `rvg_...` snapshot. An accepted request identity is replayed without another AWS call, archive, or persistence write. Provider messages and ARNs are never copied to durable failure metadata; only the bounded generic failure code is handed off.
- `drizzle/0093_finops_resilience_vue.sql` and `postgres/migrations/0088_finops_resilience_vue.sql` retain immutable generations and a monotonic accepted head per tenant, connection, account, partition, and Region. Incomplete/configuration generations remain in history and cannot displace a complete head. PostgreSQL revokes `PUBLIC` access.
- `db/finops-resilience-vue-repository.ts` validates the live AWS connection, normalizes captures against a trusted target, hashes the exact JSON, verifies it again on reads, and exposes tenant-scoped active targets and bounded history.
- `app/api/v1/finops/resilience-vue/route.ts` requires an authenticated session, resolves the connection inside the authenticated organization, checks `connection:read` for the connection customer, reads only accepted heads, supports bounded account/Region/application/posture/recommendation filters, and discloses freshness, newer incomplete attempts, provenance, and activation state.
- `lib/finops-resilience-vue-official-definition.ts` freezes the exact public manifest/definition hashes, aggregate object counts, per-sheet visual types, control placements, native mappings, and gaps.
- `app/costs/finops-resilience-vue-dashboard.tsx` is a native accessible visual with all four official sheet contracts, exact object/control counts, account/payer, Region, application, policy-posture, recommendation-kind and last-assessment-time filters; organizational assessed/in-policy/breach/drift cards; daily retained-generation trends; latest-ten assessment score history; application posture and dimension-level current/achievable/target RTO/RPO evidence; SOP/alarm/FIS status panels; unimplemented recommendation drilldowns; formula-safe CSV; immutable evidence identifiers; and honest configuration/partial/stale/empty/failure states.

## Evidence and tests

- Existing `tests/finops-resilience-vue.test.ts` covers the 14-operation read-only surface, source normalization, tenant/account/partition/Region substitution, pagination replay, duplicate conflict, empty/configuration/partial/stale states, inference separation, bounds, freshness, and query-service source failures.
- `tests/finops-resilience-vue-vertical.test.mjs` covers immutable complete-only target heads, replay safety, cross-tenant isolation, incomplete-head protection, mutation guards, daily server-owned job inputs/cursors, authenticated route contracts, SQLite/PostgreSQL parity and revokes, and server-rendered visual coverage.
- `tests/finops-resilience-vue-official-definition.test.ts` verifies immutable source hashes, all aggregate and per-sheet counts, exact control placement, and unavailable versioned-schema dimensions.
- `tests/finops-resilience-vue-runtime-binding.test.ts` covers identity-only trusted scheduling, exact operations and pagination/timeout/capture bounds, canonical immutable evidence archival and sealing handoff, deterministic at-least-once replay, explicit unregistered state, cross-tenant and capture substitution rejection, archive-hash rejection, and sanitization of raw provider failures.

## Activation and live gaps

The local vertical intentionally reports `RESILIENCE_VUE_AWS_ADAPTER_JOB_HANDLER_NOT_REGISTERED`, and `RESILIENCE_VUE_RUNTIME_BINDING.registeredInSharedRuntime` remains `false`.

Exact remaining provider/live gates:

1. Implement and register the authenticated credential-broker adapter for the declared 14 Resilience Hub reads, including AWS retry/throttling behavior within the frozen page, byte, concurrency, and 15-minute bounds.
2. Bind the server-owned eligible-connection resolver and Organizations-aware account/Region target resolver. Prove disabled/suspended accounts, unsupported Regions, partition routing, and incremental cursors cannot be supplied by a request body.
3. Implement the permanent immutable-handoff port so the archived/sealed `fss_...` evidence lineage and normalized `rvg_...` snapshot are committed atomically or recoverably under one deterministic request identity.
4. Register `finops-resilience-vue-daily-collect` in the shared durable handler registry and bind the daily scheduler, queue, evidence archive, key service, runtime role/session broker, and observability. Shared registry files were deliberately not changed by this isolated closure.
5. Run controlled live acceptance in every supported partition against representative accounts/Regions: exhaust multi-page applications, policies, assessments, components, recommendations, resources and drift; reproduce the retained record counts independently; prove token replay, timeout, cross-tenant, forged-scope and least-privilege denial behavior; retain signed evidence and exercise rollback.

Until those gates pass, this dashboard is **not** `LOCAL_VERIFIED`, `DEPLOYED`, or `LIVE_VERIFIED`; it must not claim actual tenant resilience posture.

## Focused validation

```text
node --experimental-strip-types --test --test-concurrency=1 \
  tests/finops-resilience-vue-official-definition.test.ts \
  tests/finops-resilience-vue-vertical.test.mjs \
  tests/finops-resilience-vue.test.ts \
  tests/finops-resilience-vue-runtime-binding.test.ts
```

Result: **26 passed, 0 failed, 0 skipped**.

```text
pnpm typecheck
pnpm exec eslint \
  app/api/v1/finops/resilience-vue/route.ts \
  app/costs/finops-resilience-vue-dashboard.tsx \
  lib/finops-resilience-vue-official-definition.ts \
  tests/finops-resilience-vue-official-definition.test.ts \
  tests/finops-resilience-vue-vertical.test.mjs
git diff --check
```

Result: **all passed**.

## Merge record — 2026-08-06

Merged to `main` since this record was last updated (2026-08-05 15:01). Every
item below is source-only work that landed through review with CI green on the
merge commit — nothing more. No provider, live, two-tenant, or release evidence
is created by any of it.

**Maturity is unchanged (`LOCAL_VERTICAL_CANDIDATE`) and no child-stage gate passed.** G7
fixed-tree, G8 controlled provider acceptance, G9 release and G10 deployment
remain unpassed for this row; no live acceptance, provider reconciliation, or
two-tenant acceptance is claimed.

- **Native chart kit and catalog identity — `4ac72bd` (PR #36) and `f107cdf`
  (PR #37).** This row's view moved onto the shared native chart kit at
  `app/components/charts`:
  - `app/costs/finops-resilience-vue-dashboard.tsx`

  Focused rendering proof added with it:
  - `tests/finops-resilience-vue-charts.test.mjs`

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
