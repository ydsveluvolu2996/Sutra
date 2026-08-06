# ADV-08 — AWS Budgets Dashboard evidence

Reviewed: 2026-08-02

## Capability and source boundary

This vertical implements the AWS Cloud Intelligence Dashboards AWS Budgets
capability as provider evidence. It is not the existing Sutra-authored budget
guardrail feature. Provider AWS Budgets and `finops_budgets` use different
storage, APIs, labels, evidence lineage, and UI. No provider record is silently
copied into, reconciled with, or evaluated as a Sutra budget.

The dashboard shows and groups:

- exact AWS budgeted amounts, AWS-calculated actual spend, and AWS forecasted
  spend as distinct values;
- each currency independently, using exact integer micro-units;
- provider budget type, time unit, effective dates, notification metadata,
  action status metadata, and supported performance history;
- linked-account targeting, AWS Organizations account/OU hierarchy, and
  optional active Sutra taxonomy ownership;
- the exact provider `cid:budget-level` tag as the official dashboard hierarchy
  grouping key. Missing tags are coverage gaps and are never guessed from a
  budget name.
- official Healthy, Unhealthy, and Forecasted Unhealthy signals using strict
  same-currency comparisons. Missing, equal, or incompatible evidence remains
  Unclassified rather than being treated as zero.

## Official inventory audit

Audited at CID framework commit `f9e36d88c47709f10e8fa784ad11d5cc0e728021`:
<https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/blob/f9e36d88c47709f10e8fa784ad11d5cc0e728021/dashboards/aws-budgets/aws-budgets.yaml>.
The manifest SHA-256 is
`9a9e2229e551332334363656ab4d1310fd3d73049bdce2eada46bd61c5a52de9`.
Its embedded definition contains exactly **2 sheets, 11 visuals, 2 parameter
controls, 5 filter-control objects, 3 parameter declarations, 11 calculated
fields, 9 filter groups and 1 dataset**. The visual inventory is 2 pivot
tables, 4 gauges, 1 bar chart, 1 combo chart, 1 Sankey diagram and 2 insights.
Budget Summary owns all 11 visuals, 2 parameter controls and 4 filter controls;
About has no visuals and one cross-sheet Account Name control.

The native dashboard maps all 11 named visual purposes. All 11 are supported by
exact provider values, status counts, bounded drilldown, history, currency-
separated Group By pivots and bars, four purpose-specific gauges, and an
accessible account-to-`cid:budget-level` relationship flow. This is semantic
feature parity in Sutra's native UI; QuickSight pixel geometry is not claimed.

The same commit/hash-validated official inventory is returned by both
successful API states and is rendered independently in disconnected, loading,
configuration-required, failed, and report-bearing UI states. Provider
delivery remains fail-closed; showing this frozen audit does not synthesize a
budget, hierarchy, spend value, or collector result.

## G1-G6 status

| Gate | Status | Evidence / remaining work |
|---|---|---|
| G1 — requirements and official inventory | `LOCAL_COMPLETE` | Two sheets, controls, measures and status semantics audited against the pinned official definition. |
| G2 — source contract | `LOCAL_COMPLETE` | Bounded AWS Budgets and Organizations evidence, minimized exact hierarchy tag, currencies, pagination and no mutation operations. |
| G3 — durable runtime/replay | `LOCAL_COMPLETE` | Six-hour scheduling, stable request identity, signed broker transport, immutable attempt replay, shared handler registration, internal scheduler hook and bounded timeout contracts are wired. |
| G4 — persistence/API | `LOCAL_COMPLETE` | Registered immutable storage, tenant-scoped authenticated API, bounded cursor/filters and health-status query support. |
| G5 — native UI | `LOCAL_COMPLETE` | The exact 2-sheet/11-visual/7-control purposes render with budgeted/actual/forecast evidence, hierarchy, status filters, currency-safe Group By bars/pivots, four gauges, relationship flow, history and immutable source lineage. |
| G6 — validation/acceptance | `LOCAL_COMPLETE_TESTED` | Engine, vertical, durable runtime, collector adapter, signed route, hostile scope, replay, SSR and shared-registration checks pass locally. Provider/live deployment acceptance remains a separate release gate. |

## Implemented evidence path

| Plane | Local implementation | Evidence |
|---|---|---|
| Trust boundary | Bounded capture normalization, exact account/tenant pinning, money and pagination validation, minimized tags | `lib/finops-aws-budgets-organization.ts` |
| Official definition | Frozen source hash, exact object/type counts, sheet/control inventory and per-visual native coverage | `lib/finops-aws-budgets-official-definition.ts` |
| Collection job | Read-only signed-broker request contract with exact operations, bounds, Organizations prerequisite, and `cid:budget-level` | `lib/finops-aws-budgets-collector-job.ts` |
| Permanent binding | Six-hour scheduler enqueue contract, server-resolved scope, stable broker request identity, five-minute transport ceiling and registered durable handler | `lib/finops-aws-budgets-durable-binding.ts`, `db/background-job-handlers.ts`, `app/api/internal/jobs/run/route.ts` |
| Production composition | Active trust-role scope catalog, credential-free deterministic scheduler, durable queue, immutable snapshot/attempt repositories and server-owned signed-broker handler | `db/finops-aws-budgets-runtime-repository.ts`, `lib/finops-aws-budgets-production-composition.ts` |
| Authenticated transport | Ed25519 request signing, exact-byte broker response verification, nonce binding, response/request digest reconciliation, HTTPS-only origin, bounded body, and sanitized failures | `lib/finops-aws-budgets-signed-broker.ts` |
| Provider adapter | Real AWS SDK Budgets/Organizations readers, bounded pages/records/bytes/deadline, token-cycle rejection, minimized subscriber/action/tag evidence and generic provider failures | `services/aws-collector/src/aws-budgets-provider-adapter.ts` |
| Provider route | Exact signed path, body/header scope pinning, per-connection lease, server-owned STS role session with an exact read-only intersection, and credential-free response | `services/aws-collector/src/aws-budgets-provider-route.ts`, `services/aws-collector/src/role-broker.ts`, `services/aws-collector/src/local-server.ts` |
| Attempt evidence | Immutable per-queue-attempt ledger with same-tenant trust-role joins, exact replay, conflict rejection, provider-unavailable outcomes, signed request/response digests, and broker key lineage | `db/finops-aws-budgets-durable-attempt-repository.ts`, `drizzle/0109_finops_aws_budgets_durable_attempts.sql`, `postgres/migrations/0104_finops_aws_budgets_durable_attempts.sql` |
| SQLite persistence | Immutable generations and complete-only, monotonic accepted head | `drizzle/0091_finops_aws_budgets_organization.sql` |
| PostgreSQL persistence | Equivalent constraints/triggers plus `PUBLIC` revocation | `postgres/migrations/0086_finops_aws_budgets_organization.sql` |
| Repository | Live connection/account/partition scope, digest revalidation, replay safety, incomplete-history retention | `db/finops-aws-budgets-organization-repository.ts` |
| API | Authenticated `connection:read`, same-tenant connection resolution, bounded filters/cursor, active/latest disclosure | `app/api/v1/finops/aws-budgets-organization/route.ts` |
| Native UI | Provider/source banner, hierarchy and official health-status filters, separate budgeted/actual/forecast cards, Group By bars/pivots, four gauges, accessible relationship flow, drilldown, performance/generation history and safe CSV | `app/costs/finops-aws-budgets-organization-dashboard.tsx` |
| Focused verification | Exact official audit, engine, repository, job, migrations/API, SSR rendering, production composition, scheduler scoping, replay, signatures, collector HTTP route, hostile scope, sanitized failures and shared registration | `tests/finops-aws-budgets-official-definition.test.ts`, `tests/finops-aws-budgets-organization.test.ts`, `tests/finops-aws-budgets-vertical.test.mjs`, `tests/finops-aws-budgets-durable-binding.test.mjs`, `tests/finops-aws-budgets-production-composition.test.mjs`, `tests/finops-aws-budgets-provider-contract.test.mjs`, `tests/finops-aws-budgets-shared-registration.test.mjs`, `services/aws-collector/test/aws-budgets-provider-adapter.test.ts` |

## Data Collection prerequisites

The provider path requires both data planes:

1. AWS Budgets in each connected payer/member account for definitions,
   calculated actual/forecast spend, history, notification/subscriber summary,
   action metadata, and the minimized `cid:budget-level` tag.
2. AWS Organizations in the management account or an authorized delegated
   administrator for the complete account/OU set.

The permanent role remains read-only. Budget mutation and action execution are
not part of this dashboard contract.

## Honest states and accepted-head rule

Only a normalized `ready` AWS Budgets generation with complete Organizations
hierarchy evidence may advance the accepted head. Partial, access-required, and
unavailable generations remain immutable history and cannot replace prior
complete evidence. The API distinguishes configuration-required, partial,
stale, empty, failed, and complete. Missing actual, forecast, hierarchy tags,
taxonomy, or provider updates are never rendered as zero.

Focused local verification: **37 passed, 0 failed, 0 skipped** across the exact
definition, engine, durable binding, repository/API, production composition,
server-rendered UI, provider adapter, exact STS policy, real local HTTP route,
hostile scope and shared-registration suites. Root and collector typechecks and
the collector build pass.

## Remaining production gates

- The D1 and PostgreSQL attempt migrations are registered in the shared runtime;
  the release migration/checksum gate must still execute them before the handler
  is enabled.
- The managed broker origin, application signing private key, broker response
  public key and key identifiers must be provisioned in the deployed app/broker
  workloads. No local test is evidence that production secrets exist.
- The reviewed customer role/permission-pack rollout must grant the exact read
  ceiling used by the implemented adapter. Missing access remains explicit and
  cannot advance the complete evidence head.
- Provider validation is still required for management-account and delegated-
  administrator collection, pagination, empty accounts, planned budgets,
  history-ineligible types, multi-currency, access denied, stale delivery,
  missing `cid:budget-level`, and cross-tenant denial.
- Live acceptance requires at least one scheduled, cryptographically verified
  tenant collection whose immutable attempt points to the persisted generation,
  plus retry/replay, signature rejection, timeout, and unavailable-state checks
  against the deployed broker. Dashboard catalog/navigation and the overall CID
  tracker remain root-release responsibilities.

Therefore ADV-08 is locally complete and shared-runtime wired, but it is not
production accepted or live verified until the release gates above pass.

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
  - `app/costs/finops-aws-budgets-organization-dashboard.tsx`

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
