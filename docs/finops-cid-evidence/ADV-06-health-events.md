# ADV-06 — Health Events Dashboard evidence record

Reviewed: 2026-08-01

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/health-events-dashboard.html>

Official implementation inventory (pinned): <https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/blob/f9e36d88c47709f10e8fa784ad11d5cc0e728021/dashboards/health-events/health-events-definition.yaml>

Current AWS Health API/organization references:

- <https://docs.aws.amazon.com/health/latest/ug/aws-health-concepts-and-terms.html>
- <https://docs.aws.amazon.com/health/latest/ug/aggregate-events.html>
- <https://docs.aws.amazon.com/health/latest/APIReference/API_DescribeEventsForOrganization.html>

Assessment revision: local ADV-06 vertical (not yet provider-validated)

Current maturity: `PARTIAL_PIPELINE`

## Official requirement and visual inventory

The official dashboard centralizes past, current and upcoming AWS Health
events across one or multiple organizations/payers. It provides summaries,
affected-resource drilldown, deprecating-version tracking and an upcoming-event
timeline for operational planning. It collects daily and can lag by 48 hours
or more; AWS explicitly says it is not real-time monitoring. AWS Health
Organizational View, an API-eligible Support entitlement and Data Collection
Lab Health Events 3.0.8+ are prerequisites. The CID guide names Business,
Enterprise On-Ramp and Enterprise Support; current AWS Health API guidance
names Business Support+, Enterprise Support and Unified Operations. Sutra
therefore requires validated API entitlement rather than inferring eligibility
from a plan label. Events predating Organizational View can be absent.

The official definition has `Main` and `Quick View` interactive sheets. Its
inventory includes event/account/resource summaries, status/category/resource
status, service, actionability, persona and scope filters, affected-resource
drilldown, impact timeline and explicit `deprecated_versions` reporting.

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | Current AWS guide, Health API references and official dashboard definition above, reviewed 2026-08-01. |
| G1 source contract | `IMPLEMENTED_UNVERIFIED` | Bounded read-only organization event/account/entity/detail operations; support-plan, Organization View, partition/endpoint, account and initial-load states; replay/concurrency controls; server-derived query scope. |
| G2 collector | `IMPLEMENTED_UNVERIFIED` | `lib/finops-aws-health-collector-job.ts` pins organization scope and exact reads. `lib/finops-aws-health-runtime-binding.ts` adds daily identity-only scheduling, trusted endpoint resolution, five-operation request construction, deterministic request identity/replay, sanitized failure recording and an atomic handoff contract. The production credential adapter, handoff implementation and shared handler registration remain absent. |
| G3 persistence | `IMPLEMENTED_UNVERIFIED` | `db/finops-aws-health-repository.ts`, SQLite `0104` and PostgreSQL `0099` persist every attempt immutably, retain all complete history, and advance only a newer complete head. Bounded API history now selects the newest snapshots before restoring chronological order. Disabled, ineligible, pending and partial attempts cannot displace accepted history. |
| G4 API | `IMPLEMENTED_UNVERIFIED` | Authenticated same-tenant `app/api/v1/finops/health-events/route.ts` reads accepted history and exposes distinct eligible-support, Organizations access, Organizational View, delegated-admin, initial-load and provider states. |
| G5 visual UI | `IMPLEMENTED_UNVERIFIED` | Native accessible planning UI shows the 48-hour-or-greater/not-real-time warning, past/current/upcoming summaries, dated impact timeline, affected entities/details, immutable transitions, privacy notice, filters, evidence hashes and formula-safe CSV. Deprecating versions render only from explicit `deprecated_versions` event-detail metadata; otherwise the panel states unavailable. |
| G6 focused verification | `VERIFIED_LOCAL` | 24 engine + runtime + vertical tests pass with 0 failures/skips; scheduler identity, replay, replay-scope substitution, absent adapter, scope substitution, sanitized failures, explicit deprecation evidence, newest-history selection, repository immutability, partial-safe heads, event transitions, route, migrations and SSR visual contract are covered. |
| G7–G10 | `NOT_STARTED` | Exact-tree, controlled eligible-plan/provider, two-tenant, reviewed release, deployment and live acceptance remain. |

## Evidence-honesty limits

Sutra must display the official 48-hour-or-more planning lag and never market
this view as real-time monitoring. Missing historical events before
Organizational View, insufficient Support entitlement, pending initial load,
partial entity pagination and provider failures are distinct from an empty
verified event set.

Focused command:

```text
node --experimental-strip-types --test tests/finops-aws-health-runtime-binding.test.ts tests/finops-aws-health-organization.test.ts tests/finops-aws-health-vertical.test.mjs
```

Result: **24 passed, 0 failed, 0 skipped**.

## Vertical files and remaining live gates

- Projection: `lib/finops-aws-health-dashboard.ts`
- Scheduled collection contract: `lib/finops-aws-health-collector-job.ts`
- Durable runtime boundary: `lib/finops-aws-health-runtime-binding.ts`
- Persistence: `db/finops-aws-health-repository.ts`
- Migrations: `drizzle/0104_finops_aws_health_events.sql`, `postgres/migrations/0099_finops_aws_health_events.sql`
- API/UI: `app/api/v1/finops/health-events/route.ts`, `app/costs/finops-health-events-dashboard.tsx`
- Vertical tests: `tests/finops-aws-health-vertical.test.mjs`

Remaining gates are the permanent credential-broker adapter, atomic handoff
repository and shared durable job-handler registration, controlled validation
in an organization with an eligible Support
plan and Organizational View, real provider pagination/retention/initial-load
evidence, release migration/PostgreSQL parity, signed-in visual and negative
tenant-isolation review, and live post-deploy smoke evidence. Until those pass,
the API reports `AWS_HEALTH_ORGANIZATION_JOB_HANDLER_NOT_REGISTERED`, catalog
maturity must remain `PARTIAL_PIPELINE`, and production activation stays false.
