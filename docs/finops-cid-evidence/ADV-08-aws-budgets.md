# ADV-08 — AWS Budgets Dashboard evidence

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

## Implemented evidence path

| Plane | Local implementation | Evidence |
|---|---|---|
| Trust boundary | Bounded capture normalization, exact account/tenant pinning, money and pagination validation, minimized tags | `lib/finops-aws-budgets-organization.ts` |
| Collection job | Read-only signed-broker request contract with 30-minute deadline, exact operations, bounds, Organizations prerequisite, and `cid:budget-level` | `lib/finops-aws-budgets-collector-job.ts` |
| SQLite persistence | Immutable generations and complete-only, monotonic accepted head | `drizzle/0091_finops_aws_budgets_organization.sql` |
| PostgreSQL persistence | Equivalent constraints/triggers plus `PUBLIC` revocation | `postgres/migrations/0086_finops_aws_budgets_organization.sql` |
| Repository | Live connection/account/partition scope, digest revalidation, replay safety, incomplete-history retention | `db/finops-aws-budgets-organization-repository.ts` |
| API | Authenticated `connection:read`, same-tenant connection resolution, bounded filters/cursor, active/latest disclosure | `app/api/v1/finops/aws-budgets-organization/route.ts` |
| Native UI | Provider/source banner, hierarchy filters, separate budgeted/actual/forecast cards, status, drilldown, performance and generation history, safe CSV | `app/costs/finops-aws-budgets-organization-dashboard.tsx` |
| Focused verification | Engine, repository, job, migration/API contracts, and SSR evidence rendering | `tests/finops-aws-budgets-organization.test.ts`, `tests/finops-aws-budgets-vertical.test.mjs` |

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

## Remaining production gates

- The signed-broker job contract is implemented locally, but its permanent AWS
  provider adapter is not yet deployed/bound to the scheduler.
- Provider validation is still required for management-account and delegated-
  administrator collection, pagination, empty accounts, planned budgets,
  history-ineligible types, multi-currency, access denied, stale delivery,
  missing `cid:budget-level`, and cross-tenant denial.
- Runtime migration registries, dashboard catalog/navigation, and the overall
  CID tracker are integrated by the root release task.

Therefore ADV-08 is a local partial pipeline, not production accepted or live
verified.
