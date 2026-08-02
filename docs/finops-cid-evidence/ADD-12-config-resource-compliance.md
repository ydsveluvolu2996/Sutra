# ADD-12 — AWS Config Resource Compliance

## Official capability audit

Primary AWS references reviewed on 2026-08-01:

- <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/config-resource-compliance-dashboard.html>
- <https://docs.aws.amazon.com/config/latest/developerguide/viewing-the-aggregate-dashboard.html>
- <https://docs.aws.amazon.com/config/latest/developerguide/evaluate-config_view-compliance.html>

Immutable public sources audited:

- CID framework commit
  `f9e36d88c47709f10e8fa784ad11d5cc0e728021`: **0 CRCD-specific
  artifacts**. The Guidance page links to a separate official repository.
- `aws-samples/config-resource-compliance-dashboard` commit
  `c0d0c6a36d4f0cc04dc32e84d5f077bec2d4b60c`: complete CRCD v5.0.0
  source used for the exact audit below.

| Published artifact             | Path or extraction                            | Count | SHA-256                                                            | Hash basis                                               |
| ------------------------------ | --------------------------------------------- | ----: | ------------------------------------------------------------------ | -------------------------------------------------------- |
| CID-CMD manifest               | `dashboard_template/cid-crcd.yaml`            |     1 | `1eabc9654371d23672c95daa6aff90be5505dbe59ab9fa9877e81e9bf47d5ff1` | Raw file bytes                                           |
| Complete QuickSight definition | `dashboard_template/cid-crcd-definition.yaml` |     1 | `7827c3d11e1c7cefd6e7f26913c4c5284866d0cb1126a1c55ae614cff6eb30ee` | Raw file bytes                                           |
| Deployment template            | `cloudformation/cid-crcd-stack.yaml`          |     1 | `97542e8c142f5189b57c161a25b3051310b552fbb2826f11aaf96681400d98dc` | Raw file bytes                                           |
| Backfill template              | `backfill/crcd-backfill-resources.yaml`       |     1 | `27aabcad33304cb63510e88d7d9245e11f227de39ab79e38160fd544c33d5e4a` | Raw file bytes                                           |
| Changelog                      | `CHANGELOG.md`                                |     1 | `1f0131ddb4ac458df9b8322be8735d925469e32c1ca18306d22d609a202f04b3` | Raw file bytes                                           |
| Embedded dataset definitions   | `dashboard_template/cid-crcd.yaml#datasets`   |    13 | `6a6a46f386e4e9f4d4073393800c5e7303106b575a45848922b796d78406eef3` | UTF-8 canonical JSON with recursively sorted object keys |
| Embedded Athena view queries   | `dashboard_template/cid-crcd.yaml#views`      |    14 | `aaa904287c86066d4873805581b1a929a798021d5e736092dd32de3fe360ce03` | UTF-8 canonical JSON with recursively sorted object keys |

The complete QuickSight definition is public, so its totals are exact rather
than `null`: **7 sheets, 124 visuals, 51 parameter controls, 13 filter
controls, 53 parameter declarations, 40 calculated fields, 267 filter groups,
1 column configuration, and 13 dataset declarations**. The visual histogram is
64 bar charts, 29 KPIs, 19 tables, 6 gauges, 4 heat maps, 1 pivot table, and 1
pie chart. These are parsed object counts, not screenshot estimates.

The official Cloud Intelligence Dashboard requires more than an overall
compliance score: rule and resource compliance, month-over-month rule/resource
trends, account/Region/service breakdowns, conformance-pack tracking, resource
inventory, required-tag compliance, configuration-item event history, and
Config cost-contributor views. AWS also documents that the aggregate dashboard
can show an overall resource as non-compliant when any reporting rule is
non-compliant; Sutra therefore retains rule/resource evaluation lineage and
does not infer compliance from missing rows.

## Exact official sheet mapping

Only purposes documented by AWS Guidance and the published definition are
mapped. Sutra does not claim upstream grid coordinates, pixel parity, or
QuickSight interaction parity.

| Official sheet                      | Exact objects                                  | Documented purpose                                                                                                  | Native state and explicit gap                                                                                                                                                                                                               |
| ----------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compliance                          | 30 visuals; 7 parameter controls               | Rule, resource, and conformance-pack status, scores, trends, and account/Region/service breakdowns                  | **Partial** — current rule/resource evidence, accepted-generation trend, account/Region/rule/compliance/resource-type controls, and conformance-pack rows exist. Not every score, service breakdown, control, or interaction is reproduced. |
| Tag Compliance                      | 13 visuals; 5 parameter controls               | Required-tag and managed tag-rule compliance                                                                        | **Unavailable** — tag names, values, and tag-rule-specific projections are not collected; generic compliance is not relabelled as tag compliance.                                                                                           |
| Resource Inventory                  | 29 visuals; 19 parameter and 4 filter controls | EC2, EBS, S3, RDS, Lambda, resource-specific attributes, custom tags, SSM state, and Availability Zone distribution | **Partial** — generic tenant-pinned inventory and account/Region/resource-type filtering exist. Resource-specific attributes and linked interactions are not projected.                                                                     |
| Config Usage Insights               | 28 visuals; 14 parameter controls              | CI changes, rule-evaluation trends, redundant and insufficient-data rules, and cost contributors                    | **Partial** — independent activity counts, duplicate-rule signals, insufficient-data pack counts, and reconciled CUR 2.0 actual cost exist. Full upstream series and heat maps do not.                                                      |
| Threat-Informed Security Compliance | 19 visuals; 3 parameter and 3 filter controls  | Threat-informed classifications of preventable misconfigurations                                                    | **Unavailable** — Sutra does not infer the upstream classifications from rule names.                                                                                                                                                        |
| Configuration Item Events           | 5 visuals; 3 parameter and 6 filter controls   | Configuration-change timeline, delivery coverage, latest import, account/Region filters                             | **Unavailable** — only aggregate activity counts exist; event rows and timeline are not synthesized.                                                                                                                                        |
| About                               | 0 visuals; 0 controls                          | Provenance, solution context, and limitations                                                                       | **Supported** — source commits, artifact hashes, object inventory, activation boundary, and limitations remain visible even when dashboard data is null.                                                                                    |

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
- `finops-aws-config-compliance-runtime-binding.ts` adds the permanent daily
  scheduler and five-attempt job shape, tenant-complete idempotency, a bounded
  lease, concurrent-claim suppression, immutable receipt completion, verified
  replay, and provider-neutral failure release. All scopes are prevalidated
  before the scheduler performs its first enqueue.
- Reserved SQLite `0087` and PostgreSQL `0082` migrations add append-only
  normalized snapshot generations. Database guards reject snapshot mutation
  and allow the active head to advance only to a newer `READY` or `EMPTY`
  generation in the same organization/customer/connection scope.
- The repository verifies the normalized payload SHA-256 on every read and
  repeats all three tenant keys in active/history queries.
- The authenticated GET API resolves the connection inside the session
  organization, asserts `connection:read` for the connection customer, rejects
  unknown/duplicate filters, and bounds every detailed result to 500 rows.
- Every successful GET state includes the frozen official definition audit.
  The native UI verifies the immutable source pin and definition hash before
  accepting a response and renders the audit in ready and dashboard-null
  states without synthesizing provider evidence.
- The responsive native dashboard renders explicit configuration-required,
  partial, stale, failed, empty, and complete states; coverage KPIs, independent
  channel states, immutable history trend, rule/lifecycle and resource
  drilldowns, activity counts, actual per-currency CUR totals, and generation
  evidence. It performs exact integer-micros formatting and labels activity
  counts as cost drivers rather than invoice amounts.

## Acceptance state and exact gaps

This is a complete unique vertical awaiting integration-owned shared registry
wiring. The credential-owning AWS adapter, strict signed route, durable replay
store, immutable history, deterministic scheduler, and production composition
are implemented. API activation is `available: true` and reports explicit
`unavailable`, `collecting`, `failed`, or `ready` state. No fixture or sample
data is substituted.

Remaining gates:

1. Provider-validate the bounded aggregator, Organizations, recorder, and
   rule-lifecycle operations in each supported partition.
2. Extend the minimized projection for required-tag compliance and the
   resource-specific EC2/EBS/S3/RDS/Lambda inventory fields used by the
   official dashboard; raw configuration documents remain forbidden.
3. Add threat and configuration-item event views only after their authoritative
   versioned evidence contracts exist; Security Hub and CloudTrail are not substitutes.
4. Run controlled multi-account/Region AWS acceptance, cross-tenant rejection,
   partial recorder, insufficient-data, duplicate-rule, stale, denial,
   rollback, and exact deployed-digest tests.

## Focused verification

- Domain engine suite: `tests/finops-aws-config-compliance.test.ts`
- Collector/job contract suite: `tests/finops-aws-config-compliance-job.test.ts`
- Durable runtime/replay suite:
  `tests/finops-aws-config-compliance-runtime-binding.test.ts`
- Persistence/API/UI/render contract:
  `tests/finops-aws-config-resource-compliance-vertical.test.mjs`
- Official source, hashes, exact objects, and gap mapping:
  `tests/finops-aws-config-compliance-official-definition.test.ts`
- Root TypeScript, touched-file lint, focused tests, and diff checks are run in
  the integrated tree; unrelated concurrent work is reported separately rather
  than attributed to ADD-12.

Current focused result: **27/27 tests passed** with zero failures, skips, or
cancellations. Targeted ESLint, whole-tree TypeScript, and `git diff --check`
pass on the integrated tree.
