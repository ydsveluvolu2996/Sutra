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
| Permanent binding | Six-hour scheduler enqueue contract, server-resolved scope, stable broker request identity, five-minute transport ceiling, durable handler factory, and explicit unregistered state | `lib/finops-aws-budgets-durable-binding.ts` |
| Authenticated transport | Ed25519 request signing, exact-byte broker response verification, nonce binding, response/request digest reconciliation, HTTPS-only origin, bounded body, and sanitized failures | `lib/finops-aws-budgets-signed-broker.ts` |
| Attempt evidence | Immutable per-queue-attempt ledger with same-tenant trust-role joins, exact replay, conflict rejection, provider-unavailable outcomes, signed request/response digests, and broker key lineage | `db/finops-aws-budgets-durable-attempt-repository.ts`, `drizzle/0109_finops_aws_budgets_durable_attempts.sql`, `postgres/migrations/0104_finops_aws_budgets_durable_attempts.sql` |
| SQLite persistence | Immutable generations and complete-only, monotonic accepted head | `drizzle/0091_finops_aws_budgets_organization.sql` |
| PostgreSQL persistence | Equivalent constraints/triggers plus `PUBLIC` revocation | `postgres/migrations/0086_finops_aws_budgets_organization.sql` |
| Repository | Live connection/account/partition scope, digest revalidation, replay safety, incomplete-history retention | `db/finops-aws-budgets-organization-repository.ts` |
| API | Authenticated `connection:read`, same-tenant connection resolution, bounded filters/cursor, active/latest disclosure | `app/api/v1/finops/aws-budgets-organization/route.ts` |
| Native UI | Provider/source banner, hierarchy filters, separate budgeted/actual/forecast cards, status, drilldown, performance and generation history, safe CSV | `app/costs/finops-aws-budgets-organization-dashboard.tsx` |
| Focused verification | Engine, repository, job, migration/API contracts, SSR evidence rendering, scheduler scoping, replay, signature verification, sanitized failures, and immutable attempt history | `tests/finops-aws-budgets-organization.test.ts`, `tests/finops-aws-budgets-vertical.test.mjs`, `tests/finops-aws-budgets-durable-binding.test.mjs` |

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

- The isolated scheduler and durable handler binding is complete, but it is
  deliberately not added to the shared background-handler registry by this
  vertical. Runtime state remains
  `AWS_BUDGETS_SIGNED_BROKER_HANDLER_NOT_REGISTERED` until the root release
  integrates the job kind and six-hour scheduler.
- The D1 and PostgreSQL attempt migrations are registered in the shared runtime;
  the release migration/checksum gate must still execute them before the handler
  is enabled.
- The managed broker origin, application signing private key, broker response
  public key, key identifiers, replay store, and permanent read-only AWS SDK
  adapter must be provisioned in the deployed app/broker workloads. No local
  test is evidence that those production secrets or tasks exist.
- The provider adapter must demonstrate bounded pagination and timeout behavior
  for every declared Budgets and Organizations operation. A signed unavailable
  capture is retained honestly and cannot advance the complete evidence head.
- Provider validation is still required for management-account and delegated-
  administrator collection, pagination, empty accounts, planned budgets,
  history-ineligible types, multi-currency, access denied, stale delivery,
  missing `cid:budget-level`, and cross-tenant denial.
- Live acceptance requires at least one scheduled, cryptographically verified
  tenant collection whose immutable attempt points to the persisted generation,
  plus retry/replay, signature rejection, timeout, and unavailable-state checks
  against the deployed broker. Dashboard catalog/navigation and the overall CID
  tracker remain root-release responsibilities.

Therefore ADV-08 is a local partial pipeline, not production accepted or live
verified.
