# FND-02 — Cost Intelligence Dashboard evidence record

Reviewed: 2026-08-01

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/cudos-cid-kpi.html#cost-intelligence-dashboard-cid>

Assessment revision: `0fa8d769d4`

Current maturity: `LOCAL_VERTICAL_CANDIDATE`

## Official requirement inventory

- Accessible executive cloud-financial analysis over CUR/CUR 2.0.
- Chargeback/showback by business unit, account, or cost center.
- Savings Plan, Reserved Instance, and Spot impact on unit metrics.
- Savings attribution by account/business unit and RI/SP expiry visibility.

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | Official inventory above, reviewed 2026-08-01. |
| G1–G3 source/pipeline | `IMPLEMENTED_UNVERIFIED` | Shares the correction-safe CUR2 ingestion and active-generation persistence path with FND-01. |
| G4 API | `IMPLEMENTED_UNVERIFIED` | `GET /api/v1/finops/cost-intelligence`; authenticated tenant scope, one canonical export history, 36-period/250,000-row bounds, exact filters. |
| G5 visual UI | `IMPLEMENTED_UNVERIFIED` | Executive comparison, allocation, movers, forecast, pivot, explorer, and commitment coverage in the Foundational panels. |
| G6 focused verification | `VERIFIED` | Exact bigint money, separated currencies, taxonomy reconciliation, incomplete commitment disclosure, source evidence, routes, repositories, and UI are included in the 67-test Foundational set. |
| G7–G10 | `NOT_STARTED` | Exact-tree, controlled two-tenant/provider, release, deployment, rollback, and live visual evidence remain. |

## Evidence-honesty limits

Forecasts are labelled insufficient until enough history exists. Commitment
savings and utilization remain partial unless the active canonical fields prove
the complete basis. Allocation is reporting attribution, not an invoice change.

Focused result: **67 passed, 0 failed, 0 skipped** using the command recorded in
`FND-01-cudos.md`.
