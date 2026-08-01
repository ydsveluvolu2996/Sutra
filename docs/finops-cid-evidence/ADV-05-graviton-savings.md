# ADV-05 — Graviton Savings Dashboard evidence record

Reviewed: 2026-08-01

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/graviton-savings-dashboard.html>

Assessment revision: `17da4c5989b4`

Current maturity: `ENGINE_ONLY`

## Official requirement and visual inventory

The official dashboard covers current Graviton usage, realized savings and
potential migration savings across EC2, RDS, OpenSearch and ElastiCache. It
tracks multiple AWS Organizations/payers and provides dedicated service tabs,
monthly coverage, account/instance-family/engine breakdowns, unit-cost trends,
eligibility, resource-level opportunities, filters and export. It depends on
Foundational CUR plus AWS Pricing and Inventory Data Collection modules.

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | Current AWS guide and usage inventory above, reviewed 2026-08-01. |
| G1 source contract | `PARTIAL` | The engine requires explicit AWS_ARM64 Compute Optimizer evidence, canonical CUR2, versioned Price List data, inventory/instance metadata and affirmative architecture/OS/licensing/workload/service compatibility. Exact BigInt micros and tenant account/Region scope are enforced. OpenSearch and ElastiCache resource/source contracts are absent. |
| G2 collector | `PARTIAL` | Compute Optimizer enrollment/export-job discovery exists but export objects and recommendations are not ingested; inventory, pricing, compatibility attestations and cross-service materialization are not joined into the engine capture. |
| G3 persistence | `NOT_STARTED` | No complete Graviton accepted snapshot/history and active report head exists. Compute Optimizer discovery history is deliberately partial and cannot substitute for recommendation coverage. |
| G4 API | `NOT_STARTED` | No authenticated Graviton report API verifies and serves accepted evidence. |
| G5 visual UI | `NOT_STARTED` | No native current usage/realized/potential savings visual, service tabs, monthly coverage, eligibility/resource drilldown or safe export. |
| G6 focused verification | `VERIFIED` | Exact revision `17da4c5989b4`: 10 engine tests pass with 0 failures/skips, covering potential/provider/realized separation, compatibility, blockers, period reconciliation, currency isolation, duplicates, tenant/credential rejection, bounds and no-recommendation configuration state. |
| G7–G10 | `NOT_STARTED` | Exact-tree, provider/two-tenant reconciliation, reviewed release, immutable deployment and live acceptance remain. |

## Evidence-honesty limits

Sutra never infers Arm compatibility from a target family name. Provider
estimated savings, Sutra potential savings and realized post-migration savings
remain distinct. Missing compatibility or period-matched CUR/pricing evidence
blocks a savings value instead of producing zero. Current engine coverage is
EC2, Auto Scaling and RDS only, so it does not yet meet official OpenSearch and
ElastiCache parity.

Focused command:

```text
node --experimental-strip-types --test tests/finops-graviton-savings.test.ts
```

Result: **10 passed, 0 failed, 0 skipped**.
