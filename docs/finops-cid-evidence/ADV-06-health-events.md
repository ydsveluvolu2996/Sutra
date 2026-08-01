# ADV-06 — Health Events Dashboard evidence record

Reviewed: 2026-08-01

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/health-events-dashboard.html>

Assessment revision: `17da4c5989b4`

Current maturity: `ENGINE_ONLY`

## Official requirement and visual inventory

The official dashboard centralizes past, current and upcoming AWS Health
events across one or multiple organizations/payers. It provides summaries,
affected-resource drilldown, deprecating-version tracking and an upcoming-event
timeline for operational planning. It collects daily and can lag by 48 hours
or more; AWS explicitly says it is not real-time monitoring. AWS Health
Organizational View, a Business/Enterprise On-Ramp/Enterprise Support plan and
Data Collection Lab Health Events 3.0.8+ are prerequisites. Events predating
Organizational View can be absent.

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | Current AWS guide above, reviewed 2026-08-01. |
| G1 source contract | `IMPLEMENTED_UNVERIFIED` | Bounded read-only organization event/account/entity/detail operations; support-plan, Organization View, partition/endpoint, account and initial-load states; replay/concurrency controls; server-derived query scope. |
| G2 collector | `NOT_STARTED` | A pure capture normalizer/query transport exists, but the collector service has no concrete paginated AWS Health runner and durable scheduled dispatch. |
| G3 persistence | `NOT_STARTED` | No immutable accepted Health event/entity/detail history and complete-only dashboard head is bound. |
| G4 API | `NOT_STARTED` | No authenticated application route reads accepted Health generations. |
| G5 visual UI | `NOT_STARTED` | No native past/current/upcoming summary, timeline, deprecation view or affected-resource drilldown exists. |
| G6 focused verification | `VERIFIED` | Exact revision `17da4c5989b4`: 9 engine/query tests pass with 0 failures/skips for scope, pagination, partial/stale, generic failures, drilldowns and server-side query bounds. |
| G7–G10 | `NOT_STARTED` | Exact-tree, controlled eligible-plan/provider, two-tenant, reviewed release, deployment and live acceptance remain. |

## Evidence-honesty limits

Sutra must display the official 48-hour-or-more planning lag and never market
this view as real-time monitoring. Missing historical events before
Organizational View, insufficient Support entitlement, pending initial load,
partial entity pagination and provider failures are distinct from an empty
verified event set.

Focused command:

```text
node --experimental-strip-types --test tests/finops-aws-health-organization.test.ts
```

Result: **9 passed, 0 failed, 0 skipped**.
