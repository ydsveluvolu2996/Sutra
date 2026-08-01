# ADD-12 — AWS Config Resource Compliance

## Official capability audit

Primary AWS references reviewed on 2026-08-01:

- <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/config-resource-compliance-dashboard.html>
- <https://docs.aws.amazon.com/config/latest/developerguide/viewing-the-aggregate-dashboard.html>
- <https://docs.aws.amazon.com/config/latest/developerguide/evaluate-config_view-compliance.html>

The official Cloud Intelligence Dashboard requires more than an overall
compliance score: rule and resource compliance, month-over-month rule/resource
trends, account/Region/service breakdowns, conformance-pack tracking, resource
inventory, required-tag compliance, configuration-item event history, and
Config cost-contributor views. AWS also documents that the aggregate dashboard
can show an overall resource as non-compliant when any reporting rule is
non-compliant; Sutra therefore retains rule/resource evaluation lineage and
does not infer compliance from missing rows.

## Implemented bounded slice

- Existing `finops-aws-config-compliance.ts` validates a minimized, tenant-
  pinned organization capture and keeps aggregator compliance, account-local
  lifecycle/recorder coverage, optional S3 activity, and reconciled CUR 2.0
  actual cost as independent evidence planes.
- `finops-aws-config-compliance-job.ts` defines the bounded server-owned daily
  job contract. It pins the trusted organization/customer/connection scope,
  read-only AWS operations, fixed inventory query, active reconciled CUR 2.0
  binding, exact-prefix S3 policy, timeout, privacy exclusions, normalization,
  and immutable persistence handoff.
- Reserved SQLite `0087` and PostgreSQL `0082` migrations add append-only
  normalized snapshot generations. Database guards reject snapshot mutation
  and allow the active head to advance only to a newer `READY` or `EMPTY`
  generation in the same organization/customer/connection scope.
- The repository verifies the normalized payload SHA-256 on every read and
  repeats all three tenant keys in active/history queries.
- The authenticated GET API resolves the connection inside the session
  organization, asserts `connection:read` for the connection customer, rejects
  unknown/duplicate filters, and bounds every detailed result to 500 rows.
- The responsive native dashboard renders explicit configuration-required,
  partial, stale, failed, empty, and complete states; coverage KPIs, independent
  channel states, immutable history trend, rule/lifecycle and resource
  drilldowns, activity counts, actual per-currency CUR totals, and generation
  evidence. It performs exact integer-micros formatting and labels activity
  counts as cost drivers rather than invoice amounts.

## Acceptance state and exact gaps

This is a **partial pipeline**, not a local vertical candidate or a
production-accepted capability. The bounded job contract is implemented, but
its credential-owning AWS adapter and durable handler are not registered, so
API activation is deliberately `available: false` with
`AWS_CONFIG_COMPLIANCE_JOB_HANDLER_NOT_REGISTERED`. No fixture or sample data
is substituted.

Remaining gates:

1. Implement, register, and provider-test the credential-owning adapter and
   durable handler for the exact bounded aggregator, Organizations, recorder,
   and rule-lifecycle operations, including empty-page pagination.
2. Bind optional Config S3 delivery objects and reconciled active CUR 2.0 rows
   to the capture without accepting browser-supplied AWS scope.
3. Extend the minimized projection for required-tag compliance and the
   resource-specific EC2/EBS/S3/RDS/Lambda inventory fields used by the
   official dashboard; raw configuration documents remain forbidden.
4. Run controlled multi-account/Region AWS acceptance, cross-tenant rejection,
   partial recorder, insufficient-data, duplicate-rule, stale, denial,
   rollback, and exact deployed-digest tests.

## Focused verification

- Domain engine suite: `tests/finops-aws-config-compliance.test.ts`
- Collector/job contract suite: `tests/finops-aws-config-compliance-job.test.ts`
- Persistence/API/UI/render contract:
  `tests/finops-aws-config-resource-compliance-vertical.test.mjs`
- TypeScript and touched-file lint must pass in the integrated tree; unrelated
  concurrent work is reported separately rather than attributed to ADD-12.
