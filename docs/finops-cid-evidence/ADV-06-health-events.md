# ADV-06 — Health Events Dashboard evidence record

Reviewed: 2026-08-01

Official guide: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/health-events-dashboard.html>

Immutable implementation source: AWS `cloud-intelligence-dashboards-framework`
commit `f9e36d88c47709f10e8fa784ad11d5cc0e728021`, dashboard version
`v3.1.0`.

| Artifact | Pinned path | Independently computed SHA-256 |
|---|---|---|
| Manifest | `dashboards/health-events/health-events.yaml` | `64150dfa317077894fd352bf98e6a1aa59ed7557dc51065ee519095fa5e98509` |
| QuickSight definition | `dashboards/health-events/health-events-definition.yaml` | `4c24253e3eb2bfb3d68f2ca39e07968136d82be32e9a63a9cddc6003a3340a6d` |

Current AWS Health API/organization references:

- <https://docs.aws.amazon.com/health/latest/ug/aws-health-concepts-and-terms.html>
- <https://docs.aws.amazon.com/health/latest/ug/aggregate-events.html>
- <https://docs.aws.amazon.com/health/latest/APIReference/API_DescribeEventsForOrganization.html>

Assessment revision: exact-definition audit plus local native ADV-06 vertical
(not yet provider-validated).

Current maturity: `LOCAL_VERTICAL_CANDIDATE`

## Exact official inventory

The pinned definition contains exactly **3 sheets, 33 visuals, 23 parameter
controls, 5 filter controls, 26 parameter declarations, 74 calculated fields,
35 filter groups and 1 dataset** (with no column configurations). Visuals
comprise 16 KPIs, 2 pie charts, 3 bar charts, 8 tables, 1 combo chart, 2 pivot
tables and 1 insight visual.

| Sheet | Visuals | Exact visual types | Parameter controls | Filter controls | Native status |
|---|---:|---|---:|---:|---|
| Main | 25 | 14 KPI, 2 pie, 1 bar, 7 table, 1 combo | 21 | 0 | `PARTIAL` |
| Quick View | 7 | 1 table, 2 KPI, 2 pivot, 2 bar | 2 | 5 | `PARTIAL` |
| About | 1 | 1 insight | 0 | 0 | `SUPPORTED` |

Every official control is frozen in
`lib/finops-aws-health-official-definition.ts` and rendered in the native UI.

Main parameter controls: `STARTS AFTER`, `STARTS BEFORE`, `EVENT STATUS`,
`CATEGORY`, `RESOURCE STATUS`, `SUMMARY FORMAT`, `ACTIONABILITY`, `PERSONAS`,
`EVENT SCOPE`, `CHART GROUPING`, `DISPLAY MODE`, `PAGE`, `Payer Account`,
`SERVICE`, `Event ARN`, `Account Display Format`, `ACCOUNT`,
`SUMMARY LENGTH (characters)`, `LOOKBACK DAYS`, `Near Days Threshold`, `SEARCH`.

Quick View parameter controls: `EVENT SCOPE`, `Payer Accounts`.

Quick View filter controls: `EVENT STATUS`, `RESOURCE STATUS`, `CATEGORY`,
`ACTIONABILITY`, `SERVICE`.

The native implementation covers the official planning outcomes with
past/current/upcoming summaries, impact timeline, affected-resource/detail
drilldown, immutable event transitions, filters and explicit deprecation
evidence. Exact control parity is not claimed: persona, resource-status, payer,
pagination, display-format and summary-format controls remain incomplete in the
native view. The About sheet is supported as an evidence/limitations view.

## Required operating semantics

The AWS guide documents daily collection and says data may lag by 48 hours or
more. The dashboard is for review and longer-term operational planning, not
real-time monitoring; current incident response must use AWS Health
Notifications and incident tooling. Events predating Organizational View may
be absent. AWS Health Organizational View, an API-eligible Support entitlement
and the required data collection deployment remain prerequisites. Sutra
requires validated API entitlement rather than inferring eligibility from a
plan label.

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | Immutable official manifest/definition hashes, exact independent object counts and current AWS guidance above, reviewed 2026-08-01. |
| G1 source contract | `IMPLEMENTED_UNVERIFIED` | Bounded read-only organization event/account/entity/detail operations; support-plan, Organization View, partition/endpoint, account and initial-load states; replay/concurrency controls; server-derived query scope. |
| G2 collector | `IMPLEMENTED_UNVERIFIED` | The daily runtime has a signed exact-body broker client, concrete pinned AWS SDK reader, strict local/hosted provider route, exact `.8.8` STS intersection and bounded provider adapter. The adapter validates Organizations all-features state, management/delegated-administrator identity, management-only Organizational View status, actual API entitlement, non-replayed pagination, every account/entity/detail drilldown, a hard deadline and a conservative 24-hour initial-load wait. The shared worker and daily tick are registered. |
| G3 persistence | `IMPLEMENTED_UNVERIFIED` | The immutable snapshot history is joined by `db/finops-aws-health-runtime-repository.ts`, SQLite `0119` and PostgreSQL `0115`: deterministic request leases, sanitized failures, sealed replay/orphan recovery, configuration evidence and `.8.8`-gated same-tenant candidate-account resolution. Disabled, ineligible, pending and partial attempts cannot displace accepted complete history. |
| G4 API | `IMPLEMENTED_UNVERIFIED` | Authenticated same-tenant `app/api/v1/finops/health-events/route.ts` reads accepted history plus durable runtime state and exposes distinct unavailable, collecting, failed and ready collection states without relabeling old history as current. |
| G5 visual UI | `IMPLEMENTED_UNVERIFIED` | Native accessible planning UI renders all three official sheet names, exact visual/control inventory, every official control label and honest partial-coverage gaps alongside the 48-hour-or-greater/not-real-time warning, planning visuals, entity details, privacy notice, evidence hashes and formula-safe CSV. Explicit runtime banners distinguish unavailable, collecting, failed and ready; a failed or in-progress attempt leaves the prior accepted history visibly dated. |
| G6 focused verification | `VERIFIED_LOCAL` | Engine, runtime, vertical, provider, signed-response, durable replay, migration-parity, hard-deadline, four-state SSR and frozen-definition tests cover source pins/counts, controls, tenant scope, entitlement, delegation, pagination replay, sanitized failures, immutable heads and forged broker responses. Root and collector typechecks, focused lint and repository secret scan pass. |
| G7–G10 | `NOT_STARTED` | Exact-tree, controlled eligible-plan/provider, two-tenant, reviewed release, deployment and live acceptance remain. |

## Evidence-honesty limits

Sutra must display the official 48-hour-or-more planning lag and never market
this view as real-time monitoring. Missing historical events before
Organizational View, insufficient Support entitlement, pending initial load,
partial entity pagination and provider failures are distinct from an empty
verified event set.

Focused command:

```text
node --experimental-strip-types --test tests/finops-aws-health-runtime-binding.test.ts tests/finops-aws-health-organization.test.ts tests/finops-aws-health-vertical.test.mjs tests/finops-aws-health-official-definition.test.mjs
```

The official-definition suite now performs an actual server render of the
null-report dashboard state instead of treating source-code token matches as UI
coverage. The shared report-independent contract is in
`tests/finops-report-independent-official-ui.test.mjs`.

Current ADV-06 root focused result: **45 passed, 0 failed, 0 skipped** across
engine/runtime/API/UI/provider composition suites. The service-local provider,
SDK-reader, strict-route and immutable permission/session suites add **10 passed,
0 failed, 0 skipped**.

## Vertical files and remaining live gates

- Frozen official definition: `lib/finops-aws-health-official-definition.ts`
- Projection: `lib/finops-aws-health-dashboard.ts`
- Scheduled collection contract: `lib/finops-aws-health-collector-job.ts`
- Durable runtime boundary: `lib/finops-aws-health-runtime-binding.ts`
- Signed broker and production composition: `lib/finops-aws-health-signed-broker.ts`, `lib/finops-aws-health-production-composition.ts`
- Persistence: `db/finops-aws-health-repository.ts`
- Durable runtime persistence: `db/finops-aws-health-runtime-repository.ts`
- Migrations: `drizzle/0104_finops_aws_health_events.sql`, `drizzle/0119_finops_aws_health_runtime.sql`, `postgres/migrations/0099_finops_aws_health_events.sql`, `postgres/migrations/0115_finops_aws_health_runtime.sql`
- Credential-owning boundary: `services/aws-collector/src/aws-health-provider-adapter.ts`, `services/aws-collector/src/aws-health-provider-route.ts`
- API/UI: `app/api/v1/finops/health-events/route.ts`, `app/costs/finops-health-events-dashboard.tsx`
- Vertical tests: `tests/finops-aws-health-vertical.test.mjs`, `tests/finops-aws-health-official-definition.test.mjs`

The concrete AWS SDK reader, shared signed-route, daily worker registration,
immutable `.8.8` permission successor and both migration registries are locally
closed. Remaining external gates are controlled validation
in an organization with current API entitlement and Organizational View, real
provider pagination/retention/initial-load evidence, signed-in two-tenant visual
review, release application of PostgreSQL migration `0115`, fixed-tree release
gates and live post-deploy smoke evidence. No provider/live claim is made.

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
  - `app/costs/finops-health-events-dashboard.tsx`

  Focused rendering proof added with it:
  - `tests/finops-health-events-chart.test.mjs`

  Across `app/costs/`, 28 view modules plus the catalog page now import the kit,
  and the kit's own rendering suite `tests/chart-kit-rendering.test.mjs` holds
  12 tests. `app/costs/finops-dashboard-identity.tsx` renders each dashboard's
  catalog glyph, name and ID above every opened view
  (`tests/finops-dashboard-identity.test.mjs`). This is UI rendering work only:
  no source contract, collector operation, migration, API shape, or evidence
  semantic changed, and no G5 or G6 stage status is promoted by it.
