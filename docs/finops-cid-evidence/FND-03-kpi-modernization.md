# FND-03 — KPI and Modernization Dashboard evidence record

Reviewed: 2026-08-01

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/cudos-cid-kpi.html#kpi-dashboard>

Assessment revision: `0fa8d769d4`

Current maturity: `LOCAL_VERTICAL_CANDIDATE`

## Official requirement inventory

- Governed modernization and optimization goals across lines of business.
- Percent On-Demand, Spot adoption, and Graviton usage tracking.
- Potential savings only when meeting a defined KPI can be evidenced.
- Opportunity discovery for infrequently used S3 buckets, old EBS snapshots,
  and Graviton-eligible usage.

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | Official inventory above, reviewed 2026-08-01. |
| G1–G3 source/pipeline | `IMPLEMENTED_UNVERIFIED` | Active CUR2 generations plus versioned tenant KPI goals and immutable taxonomy publications. |
| G4 API | `IMPLEMENTED_UNVERIFIED` | Tenant-resolved read-only KPI report plus separately authorized goal-management and taxonomy routes. |
| G5 visual UI | `IMPLEMENTED_UNVERIFIED` | Versioned 19-formula scorecard, goal state, evidence window, and unavailable/partial disclosures in the Foundational panels. |
| G6 focused verification | `VERIFIED` | Goal overlap/RBAC, exact formulas, source scope, currencies/units, missing compatibility/savings evidence, routes, migrations, repository, and UI are included in the 67-test Foundational set. |
| G7–G10 | `NOT_STARTED` | Exact-tree, controlled AWS reconciliation, reviewed release, immutable deployment, and live visual acceptance remain. |

## Evidence-honesty limits

Sutra withholds architecture compatibility and savings when billing or inventory
evidence cannot prove them. Billing-only signals do not become idle S3/EBS or
Graviton eligibility claims. Goals do not mutate source data or authorize
remediation.

Focused result: **67 passed, 0 failed, 0 skipped** using the command recorded in
`FND-01-cudos.md`.
